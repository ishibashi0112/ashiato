import { normalizeRow } from "../core/normalize.js";
import type { BucketedRow, BucketSum } from "./types.js";

/**
 * Shared pieces of the bucket queries (see `DbAdapter.bucketSums`). Each adapter builds two
 * expressions: the row's bucket (a hash of its key modulo the bucket count) and its signature.
 */

/** Columns holding the bucket and the signature in `readBuckets` queries. */
export const BUCKET = "__ashiato_b";
export const SIG = "__ashiato_s";
/** Table alias in bucket queries (starts with a letter, as Oracle requires). */
export const ALIAS = "ashiato_t";

export function toBucketedRow(raw: Record<string, unknown>): BucketedRow {
  const { [BUCKET]: bucket, [SIG]: sig, ...row } = raw;
  return { bucket: Number(bucket), sig: String(sig), row: normalizeRow(row) };
}

/**
 * GROUP BY clause for a bucket expression. A single bucket is a plain aggregate instead: SQL Server
 * refuses to group by a constant.
 */
export function groupBy(bucket: string): string {
  return bucket === "0" ? "" : ` GROUP BY ${bucket}`;
}

/** `bucketSums` query rows with columns b (bucket), n (row count) and s (signature sum as text). */
export function toSums(rows: Record<string, unknown>[]): Map<number, BucketSum> {
  // an aggregate without GROUP BY returns one row (n = 0, s = NULL) for an empty table
  const filled = rows.filter((r) => Number(r.n) > 0);
  return new Map(filled.map((r) => [Number(r.b), { count: Number(r.n), sum: BigInt(String(r.s).trim()) }]));
}

/** `IN (...)` list of bucket numbers. */
export function bucketList(which: number[]): string {
  return which.map((b) => String(Math.trunc(Number(b)))).join(", ");
}
