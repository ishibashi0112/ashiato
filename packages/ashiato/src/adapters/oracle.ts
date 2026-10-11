import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** oracle://user:password@host:1521/serviceName?schema=OWNER — uses node-oracledb Thin mode (no Instant Client needed). */
export async function connectOracle(url: URL): Promise<DbAdapter> {
  const oracledb = await loadDriver<typeof import("oracledb")>("oracledb", "Oracle");
  oracledb.fetchAsString = [oracledb.CLOB];
  oracledb.fetchAsBuffer = [oracledb.BLOB];
  const conn = await oracledb.getConnection({
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectString: `${url.hostname}:${url.port || 1521}${url.pathname}`,
  });
  const exec = async (sql: string, binds: Record<string, string> = {}) =>
    ((await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows ?? []) as Record<string, unknown>[];

  const owner =
    url.searchParams.get("schema")?.toUpperCase() ??
    String((await exec("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS S FROM DUAL"))[0]?.S);
  const name = (t: TableRef) => `${q(t.schema ?? owner)}.${q(t.name)}`;

  return {
    dialect: "oracle",
    async listTables() {
      const rows = await exec(
        "SELECT OWNER, TABLE_NAME FROM ALL_TABLES WHERE OWNER = :owner AND NESTED = 'NO' AND SECONDARY = 'N' ORDER BY TABLE_NAME",
        { owner },
      );
      return rows.map((r) => ({ schema: String(r.OWNER), name: String(r.TABLE_NAME) }));
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
      return (await exec(`SELECT * FROM ${name(t)}`)).map(normalizeRow);
    },
    async close() {
      await conn.close();
    },
  };
}
