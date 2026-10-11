import type { Row, TableRef } from "../core/types.js";

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
  close(): Promise<void>;
}
