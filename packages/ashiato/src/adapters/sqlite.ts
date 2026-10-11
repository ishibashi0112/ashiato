import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

export async function connectSqlite(path: string): Promise<DbAdapter> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });

  const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

  return {
    dialect: "sqlite",
    async listTables() {
      return all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).map((r) => ({ name: String(r.name) }));
    },
    async primaryKey(t: TableRef) {
      return all(`PRAGMA table_info(${q(t.name)})`)
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name));
    },
    async countRows(t: TableRef) {
      return Number(all(`SELECT COUNT(*) AS n FROM ${q(t.name)}`)[0]?.n ?? 0);
    },
    async readRows(t: TableRef): Promise<Row[]> {
      return all(`SELECT * FROM ${q(t.name)}`).map(normalizeRow);
    },
    async close() {
      db.close();
    },
  };
}
