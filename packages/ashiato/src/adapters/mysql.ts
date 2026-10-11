import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `\`${id.replace(/`/g, "``")}\``;
const name = (t: TableRef) => (t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name));

/** mysql://user:password@host:3306/database — also works for MariaDB. */
export async function connectMysql(url: URL): Promise<DbAdapter> {
  const mysql = await loadDriver<typeof import("mysql2/promise")>("mysql2/promise", "MySQL");
  const conn = await mysql.createConnection({ uri: url.toString(), dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const query = async (sql: string, params: unknown[] = []) => (await conn.query(sql, params))[0] as Record<string, unknown>[];

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
    async close() {
      await conn.end();
    },
  };
}
