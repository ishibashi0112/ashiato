import type { DbAdapter } from "../adapters/types.js";
import type { Snapshot, TableRef, TableSnapshot } from "./types.js";

export interface SnapshotOptions {
  /** Tables with more rows than this are skipped (reported, not read). Default 100,000. */
  maxRows?: number;
  /** Cached primary keys, keyed by table id. Filled on first use. */
  keyCache?: Map<string, string[]>;
}

export async function takeSnapshot(db: DbAdapter, tables: TableRef[], options: SnapshotOptions = {}): Promise<Snapshot> {
  const maxRows = options.maxRows ?? 100_000;
  const keyCache = options.keyCache ?? new Map<string, string[]>();
  const takenAt = new Date().toISOString();
  const result: TableSnapshot[] = [];

  for (const table of tables) {
    const id = table.schema ? `${table.schema}.${table.name}` : table.name;
    let key = keyCache.get(id);
    if (!key) {
      key = await db.primaryKey(table);
      keyCache.set(id, key);
    }
    const rowCount = await db.countRows(table);
    if (rowCount > maxRows) {
      result.push({ table, key, rows: [], rowCount, skipped: true });
      continue;
    }
    const rows = await db.readRows(table);
    result.push({ table, key, rows, rowCount: rows.length });
  }

  return { takenAt, tables: result };
}
