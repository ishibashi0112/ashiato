import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `[${id.replace(/]/g, "]]")}]`;
const name = (t: TableRef) => (t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name));

export async function connectMssql(url: URL): Promise<DbAdapter> {
  const mssql = await loadDriver<typeof import("mssql")>("mssql", "SQL Server");
  const params = url.searchParams;
  const pool = await new mssql.ConnectionPool({
    server: url.hostname,
    port: url.port ? Number(url.port) : 1433,
    user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    // reading a large table can take longer than the 15s default
    requestTimeout: Number(params.get("requestTimeout") ?? 120_000),
    options: {
      encrypt: params.get("encrypt") === "true",
      trustServerCertificate: params.get("trustServerCertificate") !== "false",
      instanceName: params.get("instance") ?? undefined,
      // opt-in: routed to a readable secondary, snapshots could lag behind the app's writes
      readOnlyIntent: params.get("applicationIntent")?.toLowerCase() === "readonly",
    },
  }).connect();

  const query = async (sql: string, inputs: Record<string, string> = {}) => {
    const req = pool.request();
    for (const [k, v] of Object.entries(inputs)) req.input(k, mssql.NVarChar, v);
    return (await req.query(sql)).recordset as Record<string, unknown>[];
  };

  return {
    dialect: "mssql",
    async listTables() {
      const rows = await query(
        "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME",
      );
      return rows.map((r) => ({ schema: String(r.TABLE_SCHEMA), name: String(r.TABLE_NAME) }));
    },
    async primaryKey(t) {
      const rows = await query(
        `SELECT k.COLUMN_NAME
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS c
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
             ON k.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA
          WHERE c.CONSTRAINT_TYPE = 'PRIMARY KEY' AND c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
          ORDER BY k.ORDINAL_POSITION`,
        { schema: t.schema ?? "dbo", table: t.name },
      );
      return rows.map((r) => String(r.COLUMN_NAME));
    },
    async countRows(t) {
      const rows = await query(`SELECT COUNT_BIG(*) AS n FROM ${name(t)}`);
      return Number(rows[0]?.n ?? 0);
    },
    async readRows(t): Promise<Row[]> {
      return (await query(`SELECT * FROM ${name(t)}`)).map(normalizeRow);
    },
    async close() {
      await pool.close();
    },
  };
}
