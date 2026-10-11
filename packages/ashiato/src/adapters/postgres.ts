import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const name = (t: TableRef) => `${q(t.schema ?? "public")}.${q(t.name)}`;

export async function connectPostgres(url: URL): Promise<DbAdapter> {
  const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const query = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as Record<string, unknown>[];

  return {
    dialect: "postgres",
    async listTables() {
      const rows = await query(
        `SELECT table_schema, table_name FROM information_schema.tables
          WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name`,
      );
      return rows.map((r) => ({ schema: String(r.table_schema), name: String(r.table_name) }));
    },
    async primaryKey(t) {
      const rows = await query(
        `SELECT k.column_name
           FROM information_schema.table_constraints c
           JOIN information_schema.key_column_usage k
             ON k.constraint_name = c.constraint_name AND k.constraint_schema = c.constraint_schema
          WHERE c.constraint_type = 'PRIMARY KEY' AND c.table_schema = $1 AND c.table_name = $2
          ORDER BY k.ordinal_position`,
        [t.schema ?? "public", t.name],
      );
      return rows.map((r) => String(r.column_name));
    },
    async countRows(t) {
      return Number((await query(`SELECT COUNT(*) AS n FROM ${name(t)}`))[0]?.n ?? 0);
    },
    async readRows(t): Promise<Row[]> {
      return (await query(`SELECT * FROM ${name(t)}`)).map(normalizeRow);
    },
    async close() {
      await client.end();
    },
  };
}
