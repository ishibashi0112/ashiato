import type { Row, TableRef } from "../core/types.js";

/**
 * A read-only view of a database. Every method must work with SELECT permission only:
 * no triggers, no CDC, no setting changes.
 */
export interface DbAdapter {
  readonly dialect: string;
  listTables(): Promise<TableRef[]>;
  primaryKey(table: TableRef): Promise<string[]>;
  countRows(table: TableRef): Promise<number>;
  readRows(table: TableRef): Promise<Row[]>;
  close(): Promise<void>;
}
