import { exactDecimal, normalizeRow, normalizeValue } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, groupBy, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { ColumnInfo, DbAdapter, QueryResult } from "./types.js";

type OracleDb = typeof import("oracledb");

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** DATE / TIMESTAMP hold no time zone; the driver reads them as local time, so format them from the local fields. */
const localText = (d: Date | null, ms: boolean) =>
  d === null
    ? null
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      (ms ? `.${pad(d.getMilliseconds(), 3)}` : "");


function fetchTypeHandler(oracledb: OracleDb) {
  return (meta: import("oracledb").Metadata<unknown>) => {
    switch (meta.dbType) {
      case oracledb.DB_TYPE_NUMBER:
        // exact values: the driver's float would round large IDs and long decimals
        return { type: oracledb.STRING, converter: exactDecimal as (v: unknown) => unknown };
      case oracledb.DB_TYPE_DATE:
        return { converter: ((d: Date | null) => localText(d, false)) as (v: unknown) => unknown };
      case oracledb.DB_TYPE_TIMESTAMP:
        return { converter: ((d: Date | null) => localText(d, true)) as (v: unknown) => unknown };
      case oracledb.DB_TYPE_CLOB:
      case oracledb.DB_TYPE_NCLOB:
        return { type: oracledb.STRING };
      case oracledb.DB_TYPE_BLOB:
        return { type: oracledb.BUFFER };
      default:
        return undefined;
    }
  };
}

const text = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v));

/** ALL_TAB_COLUMNS → a type as written in CREATE TABLE: VARCHAR2(20 BYTE), NUMBER(10,2), NUMBER, DATE. */
function columnInfo(c: Record<string, unknown>): ColumnInfo {
  const type = String(c.DATA_TYPE);
  const precision = c.DATA_PRECISION === null ? undefined : Number(c.DATA_PRECISION);
  const scale = c.DATA_SCALE === null ? undefined : Number(c.DATA_SCALE);
  let full = type;
  if (/^N?(VAR)?CHAR2?$/.test(type)) {
    // NCHAR / NVARCHAR2 always count characters; the others say which (NLS_LENGTH_SEMANTICS)
    full = type.startsWith("N") ? `${type}(${c.CHAR_LENGTH})` : `${type}(${c.CHAR_USED === "C" ? `${c.CHAR_LENGTH} CHAR` : `${c.DATA_LENGTH} BYTE`})`;
  } else if (type === "RAW") full = `RAW(${c.DATA_LENGTH})`;
  else if (type === "NUMBER" && precision !== undefined) full = scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  else if (type === "NUMBER" && scale === 0) full = "NUMBER(*,0)";
  else if (type === "FLOAT" && precision !== undefined) full = `FLOAT(${precision})`;
  return { name: String(c.COLUMN_NAME), type: full, nullable: c.NULLABLE !== "N", comment: text(c.COMMENTS) };
}

/**
 * client=thick: node-oracledb Thick mode, through Oracle Instant Client (libDir=its folder, otherwise
 * it is looked for on PATH). Needed for what Thin mode can't do: passwords of the old 10G kind,
 * Native Network Encryption required by the server, Oracle Database 11g.
 */
function useThickMode(oracledb: OracleDb, url: URL): boolean {
  const client = url.searchParams.get("client")?.toLowerCase();
  if (!client || client === "thin") return false;
  if (client !== "thick") throw new Error(`client=${client}: use client=thick (Oracle Instant Client), or leave it out for Thin mode`);
  const libDir = url.searchParams.get("libDir") ?? undefined;
  try {
    // can be called again with the same folder; Thin mode can't be switched to Thick once it has connected
    oracledb.initOracleClient(libDir ? { libDir } : {});
  } catch (e) {
    throw new Error(`Thick mode needs Oracle Instant Client ${libDir ? `in ${libDir}` : "on PATH (or libDir=<its folder> in the URL)"}: ${(e as Error).message}`);
  }
  return true;
}

/**
 * A full connect descriptor. Thick mode reads host:port/service through the Instant Client's naming
 * methods, and ORA-12154 follows where sqlnet.ora leaves EZCONNECT out; a descriptor needs none.
 */
function connectDescriptor(host: string, port: string, service: string): string {
  for (const [label, value] of [["host", host], ["service name", service]] as const) {
    // these would start another part of the descriptor
    if (!value || /[()=\s]/.test(value)) throw new Error(`The Oracle ${label} "${value}" is empty or holds a bracket, = or a space`);
  }
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SERVICE_NAME=${service})))`;
}

/** Errors Thin mode gives where Thick mode connects: they say what to add to the URL. */
function thinModeHint(e: unknown): unknown {
  if (!(e instanceof Error) || !/^NJS-(116|138|533)\b/.test(e.message)) return e;
  return new Error(`${e.message}\nThin mode can't connect to this database: add client=thick to the URL (needs Oracle Instant Client, see the README).`);
}

/**
 * oracle://user:password@host:1521/serviceName?schema=OWNER — node-oracledb Thin mode (no Instant
 * Client needed), or Thick mode with client=thick.
 */
export async function connectOracle(url: URL): Promise<DbAdapter> {
  const oracledb = await loadDriver<OracleDb>("oracledb", "Oracle");
  const thick = useThickMode(oracledb, url);
  const service = decodeURIComponent(url.pathname).replace(/^\//, "");
  // a pool of one checks the connection before use and reconnects after a restart or idle timeout
  const pool = await oracledb.createPool({
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectString: thick ? connectDescriptor(url.hostname, url.port || "1521", service) : `${url.hostname}:${url.port || 1521}/${service}`,
    poolMin: 0,
    poolMax: 1,
    poolPingInterval: 10,
  });
  try {
    // connect now, so a wrong password or a mode that can't connect shows up here
    await (await pool.getConnection()).close();
  } catch (e) {
    await pool.close(0).catch(() => undefined);
    throw thinModeHint(e);
  }
  const handler = fetchTypeHandler(oracledb);
  const exec = async (sql: string, binds: Record<string, string> = {}) => {
    const conn = await pool.getConnection();
    try {
      const res = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler: handler });
      return (res.rows ?? []) as Record<string, unknown>[];
    } finally {
      await conn.close();
    }
  };

  const owner =
    url.searchParams.get("schema")?.toUpperCase() ??
    String((await exec("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS S FROM DUAL"))[0]?.S);
  const name = (t: TableRef) => `${q(t.schema ?? owner)}.${q(t.name)}`;

  // The driver turns DATE / TIMESTAMP into a JavaScript Date: milliseconds only, and shifted around
  // daylight saving changes. Such columns are read as text formatted by the database instead.
  const columnLists = new Map<string, Promise<(alias: string) => string>>();
  const columnsOf = (t: TableRef) => {
    let c = columnLists.get(name(t));
    if (!c) {
      c = exec(
        `SELECT COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS
          WHERE OWNER = :owner AND TABLE_NAME = :tbl AND COLUMN_ID IS NOT NULL ORDER BY COLUMN_ID`,
        { owner: t.schema ?? owner, tbl: t.name },
      ).then((cols) => {
        const format = (type: string) => {
          if (type === "DATE") return { text: "YYYY-MM-DD HH24:MI:SS" };
          const m = /^TIMESTAMP\((\d)\)( WITH (LOCAL )?TIME ZONE)?$/.exec(type);
          if (!m) return undefined;
          // WITH LOCAL TIME ZONE comes in the session's zone, which the driver sets from this machine's: in UTC it reads the same on every machine
          return { text: `YYYY-MM-DD HH24:MI:SS${m[1] === "0" ? "" : `.FF${m[1]}`}${m[2] ? " TZH:TZM" : ""}`, utc: Boolean(m[3]) };
        };
        if (!cols.some((c) => format(String(c.DATA_TYPE)))) return (alias: string) => `${alias}.*`;
        return (alias: string) =>
          cols
            .map((c) => {
              const col = `${alias}.${q(String(c.COLUMN_NAME))}`;
              const f = format(String(c.DATA_TYPE));
              return f ? `TO_CHAR(${f.utc ? `${col} AT TIME ZONE '+00:00'` : col}, '${f.text}') AS ${q(String(c.COLUMN_NAME))}` : col;
            })
            .join(", ");
      });
      c.catch(() => columnLists.delete(name(t)));
      columnLists.set(name(t), c);
    }
    return c;
  };
  // Signature: ORA_ROWSCN, the SCN of the last change to the row's block (to the row itself only for
  // tables created with ROWDEPENDENCIES). A change to a block marks all its rows, so buckets group
  // whole blocks: a hash of the ROWID up to the block number (object, file, block). A row keeps its
  // ROWID, so it stays in its bucket.
  const bucketOf = (key: string[], n: number) => (key.length === 0 || n <= 1 ? "0" : `ORA_HASH(SUBSTR(ROWIDTOCHAR(${ALIAS}.ROWID), 1, 15), ${n - 1})`);

  return {
    dialect: "oracle",
    async listTables() {
      // IOT overflow segments are listed too but can't be queried (ORA-25191).
      // Version: OBJECT_ID (a new one when created again) and LAST_DDL_TIME, which every ALTER TABLE
      // changes. That time has whole seconds only, so a second DDL within the same second could go
      // unseen: until that second is surely over, the version is different at every call.
      const rows = await exec(
        `SELECT t.OWNER, t.TABLE_NAME, TO_CHAR(o.OBJECT_ID) || ':' || TO_CHAR(o.LAST_DDL_TIME, 'YYYYMMDDHH24MISS')
                || CASE WHEN o.LAST_DDL_TIME > SYSDATE - 2 / 86400 AND o.LAST_DDL_TIME <= SYSDATE THEN ':' || TO_CHAR(SYSTIMESTAMP, 'YYYYMMDDHH24MISSFF6') END AS V
           FROM ALL_TABLES t
           LEFT JOIN ALL_OBJECTS o ON o.OWNER = t.OWNER AND o.OBJECT_NAME = t.TABLE_NAME AND o.OBJECT_TYPE = 'TABLE' AND o.SUBOBJECT_NAME IS NULL
          WHERE t.OWNER = :owner AND t.NESTED = 'NO' AND t.SECONDARY = 'N' AND (t.IOT_TYPE IS NULL OR t.IOT_TYPE = 'IOT')
          ORDER BY t.TABLE_NAME`,
        { owner },
      );
      return rows.map((r) => ({ schema: String(r.OWNER), name: String(r.TABLE_NAME), version: String(r.V) }));
    },
    async primaryKey(t) {
      const rows = await exec(
        `SELECT cc.COLUMN_NAME
           FROM ALL_CONSTRAINTS c
           JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME
          WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = :owner AND c.TABLE_NAME = :tbl
          ORDER BY cc.POSITION`,
        { owner: t.schema ?? owner, tbl: t.name },
      );
      return rows.map((r) => String(r.COLUMN_NAME));
    },
    async countRows(t) {
      return Number((await exec(`SELECT COUNT(*) AS N FROM ${name(t)}`))[0]?.N ?? 0);
    },
    async readRows(t): Promise<Row[]> {
      const select = await columnsOf(t);
      return (await exec(`SELECT ${select(ALIAS)} FROM ${name(t)} ${ALIAS}`)).map(normalizeRow);
    },
    async bucketSums(t, key, n) {
      const b = bucketOf(key, n);
      return toSums(await exec(`SELECT ${b} AS "b", COUNT(*) AS "n", TO_CHAR(SUM(ORA_ROWSCN)) AS "s" FROM ${name(t)} ${ALIAS}${groupBy(b)}`));
    },
    async readBuckets(t, key, n, which) {
      const b = bucketOf(key, n);
      const select = await columnsOf(t);
      const where = which ? ` WHERE ${b} IN (${bucketList(which)})` : "";
      return (await exec(`SELECT ${b} AS "${BUCKET}", TO_CHAR(ORA_ROWSCN) AS "${SIG}", ${select(ALIAS)} FROM ${name(t)} ${ALIAS}${where}`)).map(
        toBucketedRow,
      );
    },
    forget(t) {
      columnLists.delete(name(t));
    },
    async listViews() {
      const rows = await exec("SELECT OWNER, VIEW_NAME FROM ALL_VIEWS WHERE OWNER = :owner ORDER BY VIEW_NAME", { owner });
      return rows.map((r) => ({ schema: String(r.OWNER), name: String(r.VIEW_NAME) }));
    },
    async describeTable(t) {
      const binds = { owner: t.schema ?? owner, tbl: t.name };
      const cols = await exec(
        `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH, c.CHAR_USED, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE, m.COMMENTS
           FROM ALL_TAB_COLUMNS c
           LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME AND m.COLUMN_NAME = c.COLUMN_NAME
          WHERE c.OWNER = :owner AND c.TABLE_NAME = :tbl ORDER BY c.COLUMN_ID`,
        binds,
      );
      const table = await exec("SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = :owner AND TABLE_NAME = :tbl", binds);
      return { columns: cols.map(columnInfo), comment: text(table[0]?.COMMENTS) };
    },
    async runQuery(sql, maxRows) {
      const run = async () => {
        const conn = await pool.getConnection();
        try {
          // names without an owner are the ?schema= owner's tables, as in `ashiato schema` (no privilege needed)
          if (url.searchParams.get("schema")) await conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${q(owner)}`);
          // a second guard: Oracle refuses to change anything in a read-only transaction (ORA-01456)
          await conn.execute("SET TRANSACTION READ ONLY");
          const res = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: maxRows + 1, fetchTypeHandler: handler });
          const rows = (res.rows ?? []) as unknown[][];
          return {
            columns: (res.metaData ?? []).map((m) => m.name),
            rows: rows.slice(0, maxRows).map((r) => r.map(normalizeValue)),
            more: rows.length > maxRows,
          } satisfies QueryResult;
        } finally {
          await conn.rollback().catch(() => undefined);
          await conn.close();
        }
      };
      try {
        return await run();
      } catch (e) {
        // ORA-01466: a read-only transaction can't read a table created or altered within the last second
        if (!(e instanceof Error) || !e.message.startsWith("ORA-01466")) throw e;
        await new Promise((r) => setTimeout(r, 1100));
        return run();
      }
    },
    async close() {
      await pool.close(0);
    },
  };
}
