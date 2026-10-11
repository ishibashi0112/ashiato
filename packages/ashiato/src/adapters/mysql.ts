import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `\`${id.replace(/`/g, "``")}\``;
const name = (t: TableRef) => (t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name));

/** mysql://user:password@host:3306/database — also works for MariaDB. */
export async function connectMysql(url: URL): Promise<DbAdapter> {
  const mysql = await loadDriver<typeof import("mysql2/promise")>("mysql2/promise", "MySQL");
  const pool = mysql.createPool({
    uri: url.toString(),
    connectionLimit: 1,
    enableKeepAlive: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const query = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    try {
      return (await pool.query(sql, params))[0] as Record<string, unknown>[];
    } catch (e) {
      // the server closed the connection (wait_timeout, restart): the pool opens a new one
      if (!(e as { fatal?: boolean }).fatal) throw e;
      return (await pool.query(sql, params))[0] as Record<string, unknown>[];
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
      const rows = await query(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n FROM information_schema.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
      );
      return rows.map((r) => ({ schema: String(r.s), name: String(r.n) }));
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
        await query(`SELECT ${b} AS b, COUNT(*) AS n, CAST(SUM(${await sigOf(t)}) AS CHAR) AS s FROM ${name(t)} AS ${ALIAS} GROUP BY 1`),
      );
    },
    async readBuckets(t, key, n, which) {
      const b = bucketOf(key, n);
      const where = which ? ` WHERE ${b} IN (${bucketList(which)})` : "";
      return (
        await query(`SELECT ${b} AS ${BUCKET}, CAST(${await sigOf(t)} AS CHAR) AS ${SIG}, ${ALIAS}.* FROM ${name(t)} AS ${ALIAS}${where}`)
      ).map(toBucketedRow);
    },
    async close() {
      await pool.end();
    },
  };
}
