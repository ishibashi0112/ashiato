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

/** `bucketSums` query rows with columns b (bucket), n (row count) and s (signature sum as text). */
export function toSums(rows: Record<string, unknown>[]): Map<number, BucketSum> {
  return new Map(rows.map((r) => [Number(r.b), { count: Number(r.n), sum: BigInt(String(r.s).trim()) }]));
}

/** `IN (...)` list of bucket numbers. */
export function bucketList(which: number[]): string {
  return which.map((b) => String(Math.trunc(Number(b)))).join(", ");
}
