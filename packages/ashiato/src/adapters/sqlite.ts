import { normalizeRow, normalizeValue } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import type { DbAdapter, QueryResult } from "./types.js";

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
      // ordinary tables only: no virtual tables (their module may not be loaded) or FTS shadow tables.
      // Version: the CREATE TABLE statement, which ALTER TABLE rewrites.
      return all(
        `SELECT l.name, s.sql FROM pragma_table_list l LEFT JOIN sqlite_schema s ON s.type = 'table' AND s.name = l.name
          WHERE l.schema = 'main' AND l.type = 'table' AND l.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY l.name`,
      ).map((r) => ({ name: String(r.name), version: String(r.sql) }));
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
    async listViews() {
      return all("SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name").map((r) => ({ name: String(r.name) }));
    },
    async describeTable(t: TableRef) {
      // SQLite keeps no comments; the declared type is whatever CREATE TABLE said (empty when none)
      const columns = all(`PRAGMA table_info(${q(t.name)})`).map((c) => ({
        name: String(c.name),
        type: String(c.type ?? ""),
        nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
      }));
      return { columns };
    },
    async runQuery(sql: string, maxRows: number): Promise<QueryResult> {
      // the database is opened read-only, so nothing can be written whatever the statement says
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true);
      const rows: QueryResult["rows"] = [];
      // Node.js 22.16 and later: rows as arrays (two columns may share a name), read only as far as needed
      if (typeof stmt.setReturnArrays === "function" && typeof stmt.iterate === "function") {
        stmt.setReturnArrays(true);
        let more = false;
        for (const row of stmt.iterate() as Iterable<unknown[]>) {
          if (rows.length === maxRows) {
            more = true;
            break;
          }
          rows.push(row.map(normalizeValue));
        }
        return { columns: stmt.columns().map((c) => c.name), rows, more };
      }
      const all = stmt.all() as Record<string, unknown>[];
      const columns = Object.keys(all[0] ?? {});
      for (const r of all.slice(0, maxRows)) rows.push(columns.map((c) => normalizeValue(r[c])));
      return { columns, rows, more: all.length > maxRows };
    },
    async close() {
      db.close();
    },
  };
}
