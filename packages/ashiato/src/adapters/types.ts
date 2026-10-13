import type { JsonValue, Row, TableRef } from "../core/types.js";

/** A row read together with its bucket and signature (see `DbAdapter.readBuckets`). */
export interface BucketedRow {
  bucket: number;
  /** An integer, as a decimal string. Changes whenever the row changes. */
  sig: string;
  row: Row;
}

/** Row count and sum of the row signatures of one bucket. */
export interface BucketSum {
  count: number;
  sum: bigint;
}

/** A table as `listTables` returns it. */
export interface ListedTable extends TableRef {
  /**
   * Optional. Changes whenever the table is created again or its definition is altered (columns,
   * primary key), so that what was cached about it is read again: compared as text, never parsed.
   */
  version?: string;
}

/** A column as `describeTable` returns it. */
export interface ColumnInfo {
  name: string;
  /** The database's type with its length, precision or scale: varchar(20), decimal(10,2), VARCHAR2(20 BYTE). */
  type: string;
  nullable: boolean;
  /** The column's comment: SQL Server's MS_Description, COMMENT ON (Oracle, PostgreSQL), MySQL's COMMENT. */
  comment?: string;
}

/** A table or view as `describeTable` returns it. No columns: it isn't there, or the user can't read it. */
export interface TableInfo {
  columns: ColumnInfo[];
  comment?: string;
}

/** What one statement run by `runQuery` returned. */
export interface QueryResult {
  /** Column names in order. The same name can appear twice (two tables' `id`). */
  columns: string[];
  /** At most the rows asked for, values normalized like `readRows`, with date and time columns as text. */
  rows: JsonValue[][];
  /** The statement returned more rows than were asked for. */
  more: boolean;
}

/**
 * A read-only view of a database. Every method must work with SELECT permission only:
 * no triggers, no CDC, no setting changes.
 */
export interface DbAdapter {
  readonly dialect: string;
  /** Called at each checkpoint too, so tables created after recording started are watched as well. */
  listTables(): Promise<ListedTable[]>;
  primaryKey(table: TableRef): Promise<string[]>;
  countRows(table: TableRef): Promise<number>;
  readRows(table: TableRef): Promise<Row[]>;
  /**
   * Optional, so that a checkpoint re-reads only the parts of a table that changed. The database
   * spreads the rows over `buckets` buckets (all rows go to bucket 0 when `key` is empty) and gives
   * each row a signature that changes whenever the row does: a row version where the database keeps
   * one, otherwise a hash of the row's values. A row must stay in its bucket while it exists (the
   * bucket is a hash of its key, or of its physical location); a row that moves changes both buckets.
   * Returns the non-empty buckets. The sums must equal the sums of the signatures `readBuckets`
   * returns for the same rows.
   */
  bucketSums?(table: TableRef, key: string[], buckets: number): Promise<Map<number, BucketSum>>;
  /** Rows of the given buckets (all buckets when `which` is omitted), normalized like `readRows`. */
  readBuckets?(table: TableRef, key: string[], buckets: number, which?: number[]): Promise<BucketedRow[]>;
  /** Optional. Drops what the adapter cached about a table (column lists...): it was created again, altered, or is gone. */
  forget?(table: TableRef): void;
  /** Optional, for `ashiato schema`: the views the user can read, in the schemas `listTables` looks at. */
  listViews?(): Promise<TableRef[]>;
  /** Optional, for `ashiato schema`: the columns and comments of a table or view. */
  describeTable?(table: TableRef): Promise<TableInfo>;
  /**
   * Optional, for `ashiato query`: runs one statement someone wrote (a person, or an AI in a chat)
   * and returns its first `maxRows` rows. The caller has checked it is a SELECT; where the database
   * has read-only transactions the statement runs in one, as a second guard, and nothing is committed.
   */
  runQuery?(sql: string, maxRows: number): Promise<QueryResult>;
  close(): Promise<void>;
}
