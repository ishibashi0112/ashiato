import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A small writable SQLite database standing in for the app's database. */
export function createAppDb() {
  const file = join(mkdtempSync(join(tmpdir(), "ashiato-")), "app.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, qty INTEGER, updated_at TEXT);
    CREATE TABLE stock (item_id INTEGER PRIMARY KEY, qty INTEGER);
    CREATE TABLE audit_log (message TEXT);
    INSERT INTO stock VALUES (3, 50), (4, 20);
  `);
  return { file, db };
}
