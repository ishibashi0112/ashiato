import { exactDecimal, normalizeRow, normalizeValue } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, groupBy, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { DbAdapter, QueryResult } from "./types.js";

const q = (id: string) => `\`${id.replace(/`/g, "``")}\``;
const name = (t: TableRef) => (t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name));
/** Column type of DECIMAL / NUMERIC in result metadata (MYSQL_TYPE_NEWDECIMAL). */
const DECIMAL = 246;

const text = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v));

/** mysql://user:password@host:3306/database — also works for MariaDB. */
export async function connectMysql(url: URL): Promise<DbAdapter> {
  const mysql = await loadDriver<typeof import("mysql2/promise")>("mysql2/promise", "MySQL");
  const pool = mysql.createPool({
    uri: url.toString(),
    connectionLimit: 1,
    enableKeepAlive: true,
    dateStrings: true,
    // BIGINT as a number when exact, as text otherwise
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  const run = async (sql: string, params: unknown[]) => {
    const [rows, fields] = (await pool.query(sql, params)) as unknown as [Record<string, unknown>[], { name: string; columnType: number }[]?];
    // DECIMAL comes as text: a number when exact, like the other databases' adapters
    const decimals = (fields ?? []).filter((f) => f.columnType === DECIMAL).map((f) => f.name);
    if (decimals.length) for (const r of rows) for (const c of decimals) r[c] = exactDecimal(r[c]);
    return rows;
  };
  const query = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    try {
      return await run(sql, params);
    } catch (e) {
      // the server closed the connection (wait_timeout, restart): the pool opens a new one
      if (!(e as { fatal?: boolean }).fatal) throw e;
      return await run(sql, params);
    }
  };
  await query("SELECT 1");

  // MySQL keeps no row version, so the signature is a hash of the row's values (as bytes, so
  // mixed character sets can't clash), with a NULL flag per column. Buckets: CRC32 of the key.
  const columns = new Map<string, Promise<string[]>>();
  const columnsOf = (t: TableRef) => {
    let c = columns.get(name(t));
    if (!c) {
      c = query(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [t.schema ?? null, t.name],
      ).then((rows) => rows.map((r) => String(r.c)));
      c.catch(() => columns.delete(name(t)));
      columns.set(name(t), c);
    }
    return c;
  };
  const bin = (c: string) => `CAST(${ALIAS}.${q(c)} AS BINARY)`;
  const sigOf = async (t: TableRef) => {
    const cols = await columnsOf(t);
    if (cols.length === 0) throw new Error(`no readable columns in ${name(t)}`);
    const nulls = cols.map((c) => `ISNULL(${ALIAS}.${q(c)})`).join(", ");
    return `CAST(CONV(SUBSTRING(MD5(CONCAT_WS(0x00, ${cols.map(bin).join(", ")}, CONCAT(${nulls}))), 1, 15), 16, 10) AS UNSIGNED)`;
  };
  const bucketOf = (key: string[], n: number) =>
    key.length === 0 || n <= 1 ? "0" : `CRC32(CONCAT_WS(0x00, ${key.map(bin).join(", ")})) % ${n}`;

  return {
    dialect: "mysql",
    async listTables() {
      // Version: CREATE_TIME, which every ALTER TABLE sets too (MySQL 8, MariaDB). It has whole
      // seconds only, so a second ALTER within the same second could go unseen: until that second is
      // surely over, the version is different at every call.
      const rows = await query(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n,
                CONCAT(COALESCE(CREATE_TIME, ''), IF(CREATE_TIME > NOW() - INTERVAL 2 SECOND AND CREATE_TIME <= NOW(), CONCAT(' ', NOW(6)), '')) AS v
           FROM information_schema.TABLES
          WHERE TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') AND TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
      );
      return rows.map((r) => ({ schema: String(r.s), name: String(r.n), version: String(r.v) }));
    },
    async primaryKey(t) {
      const rows = await query(
        `SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
          WHERE CONSTRAINT_NAME = 'PRIMARY' AND TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [t.schema ?? null, t.name],
      );
      return rows.map((r) => String(r.c));
    },
    async countRows(t) {
      return Number((await query(`SELECT COUNT(*) AS n FROM ${name(t)}`))[0]?.n ?? 0);
    },
    async readRows(t): Promise<Row[]> {
      return (await query(`SELECT * FROM ${name(t)}`)).map(normalizeRow);
    },
    async bucketSums(t, key, n) {
      const b = bucketOf(key, n);
      return toSums(
        await query(`SELECT ${b} AS b, COUNT(*) AS n, CAST(SUM(${await sigOf(t)}) AS CHAR) AS s FROM ${name(t)} AS ${ALIAS}${groupBy(b)}`),
      );
    },
    async readBuckets(t, key, n, which) {
      const b = bucketOf(key, n);
      const where = which ? ` WHERE ${b} IN (${bucketList(which)})` : "";
      return (
        await query(`SELECT ${b} AS ${BUCKET}, CAST(${await sigOf(t)} AS CHAR) AS ${SIG}, ${ALIAS}.* FROM ${name(t)} AS ${ALIAS}${where}`)
      ).map(toBucketedRow);
    },
    forget(t) {
      columns.delete(name(t));
    },
    async listViews() {
      const rows = await query(
        "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_TYPE = 'VIEW' AND TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
      );
      return rows.map((r) => ({ schema: String(r.s), name: String(r.n) }));
    },
    async describeTable(t) {
      const where = [t.schema ?? null, t.name];
      const cols = await query(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        where,
      );
      // a view's TABLE_COMMENT is the word VIEW
      const table = await query(
        `SELECT TABLE_COMMENT AS comment FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND TABLE_TYPE <> 'VIEW'`,
        where,
      );
      return {
        columns: cols.map((c) => ({ name: String(c.name), type: String(c.type), nullable: c.nullable === "YES", comment: text(c.comment) })),
        comment: text(table[0]?.comment),
      };
    },
    async runQuery(sql, maxRows) {
      // A read-only transaction (the server refuses any write) and sql_select_limit, so that only
      // the rows shown are sent. Both are put back before the connection returns to the pool.
      let conn = await pool.getConnection();
      try {
        await conn.query("START TRANSACTION READ ONLY");
      } catch (e) {
        // the server closed the idle connection (wait_timeout, restart): take a new one
        if (!(e as { fatal?: boolean }).fatal) throw e;
        conn.destroy();
        conn = await pool.getConnection();
        await conn.query("START TRANSACTION READ ONLY");
      }
      try {
        await conn.query(`SET SESSION sql_select_limit = ${maxRows + 1}`);
        const [rows, fields] = (await conn.query({ sql, rowsAsArray: true })) as unknown as [unknown[][], { name: string; columnType: number }[]?];
        const decimal = (fields ?? []).map((f) => f.columnType === DECIMAL);
        return {
          columns: (fields ?? []).map((f) => f.name),
          rows: (Array.isArray(rows) ? rows : []).slice(0, maxRows).map((r) => r.map((v, i) => (decimal[i] ? exactDecimal(v) : normalizeValue(v)))),
          more: Array.isArray(rows) && rows.length > maxRows,
        } satisfies QueryResult;
      } finally {
        try {
          await conn.query("SET SESSION sql_select_limit = DEFAULT");
          await conn.query("ROLLBACK");
          conn.release();
        } catch {
          conn.destroy();
        }
      }
    },
    async close() {
      await pool.end();
    },
  };
}
