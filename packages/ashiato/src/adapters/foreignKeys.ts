import type { ForeignKey } from "./types.js";

/** One column of a foreign key as a catalog lists it: the rows of one key come together, in column order. */
export interface ForeignKeyColumn {
  /** The key's name (its constraint), which groups the rows. */
  key: string;
  column: string;
  schema?: string;
  table: string;
  referencedColumn: string;
}

/** Catalog rows, one per column, → foreign keys. */
export function groupForeignKeys(rows: ForeignKeyColumn[]): ForeignKey[] {
  const keys = new Map<string, ForeignKey>();
  for (const r of rows) {
    let fk = keys.get(r.key);
    if (!fk) {
      fk = { columns: [], references: r.schema ? { schema: r.schema, name: r.table } : { name: r.table }, referencedColumns: [] };
      keys.set(r.key, fk);
    }
    fk.columns.push(r.column);
    fk.referencedColumns.push(r.referencedColumn);
  }
  return [...keys.values()];
}
