import { exactDecimal, normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, groupBy, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

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

/** oracle://user:password@host:1521/serviceName?schema=OWNER — uses node-oracledb Thin mode (no Instant Client needed). */
export async function connectOracle(url: URL): Promise<DbAdapter> {
  const oracledb = await loadDriver<OracleDb>("oracledb", "Oracle");
  // a pool of one checks the connection before use and reconnects after a restart or idle timeout
  const pool = await oracledb.createPool({
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectString: `${url.hostname}:${url.port || 1521}${decodeURIComponent(url.pathname)}`,
    poolMin: 0,
    poolMax: 1,
    poolPingInterval: 10,
  });
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
          if (type === "DATE") return "YYYY-MM-DD HH24:MI:SS";
          const m = /^TIMESTAMP\((\d)\)( WITH (LOCAL )?TIME ZONE)?$/.exec(type);
          if (!m) return undefined;
          return `YYYY-MM-DD HH24:MI:SS${m[1] === "0" ? "" : `.FF${m[1]}`}${m[2] && !m[3] ? " TZH:TZM" : ""}`;
        };
        if (!cols.some((c) => format(String(c.DATA_TYPE)))) return (alias: string) => `${alias}.*`;
        return (alias: string) =>
          cols
            .map((c) => {
              const col = `${alias}.${q(String(c.COLUMN_NAME))}`;
              const f = format(String(c.DATA_TYPE));
              return f ? `TO_CHAR(${col}, '${f}') AS ${q(String(c.COLUMN_NAME))}` : col;
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
    async close() {
      await pool.close(0);
    },
  };
}
