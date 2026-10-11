import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

export async function connectSqlite(path: string): Promise<DbAdapter> {
  const { DatabaseSync } = await import("node:sqlite");
  // wait for the app's write lock instead of failing the checkpoint at once
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });

  const all = (sql: string) => {
    const stmt = db.prepare(sql);
    // integers beyond 2^53 would otherwise throw; normalizeValue turns safe ones back into numbers
    stmt.setReadBigInts(true);
    return stmt.all() as Record<string, unknown>[];
  };

  return {
    dialect: "sqlite",
    async listTables() {
      // ordinary tables only: no virtual tables (their module may not be loaded) or FTS shadow tables
      return all(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
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
