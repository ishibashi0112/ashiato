import type { BucketedRow, DbAdapter } from "../adapters/types.js";
import { tableId } from "./diff.js";
import type { Row, Snapshot, TableRef, TableSnapshot } from "./types.js";

export interface SnapshotOptions {
  /** Tables with more rows than this are skipped (reported, not read). Default 100,000. */
  maxRows?: number;
  /** Cached primary keys, keyed by table id. Filled on first use. */
  keyCache?: Map<string, string[]>;
  /** The previous snapshot. Tables read by buckets are then re-read only where they changed. */
  previous?: Snapshot;
  /** Read tables by buckets when the adapter supports it. Default true. */
  incremental?: boolean;
  /** Rows per bucket the bucket count aims for. Default 256. */
  rowsPerBucket?: number;
  /** Tables that can't be read by buckets, with the reason. They are read in full. Filled on failure. */
  fullRead?: Map<string, string>;
}

/** With more changed buckets than this, the whole table is read (also keeps IN lists under Oracle's limit of 1000). */
const MAX_CHANGED = 500;
const MAX_BUCKETS = 4096;

export async function takeSnapshot(db: DbAdapter, tables: TableRef[], options: SnapshotOptions = {}): Promise<Snapshot> {
  const maxRows = options.maxRows ?? 100_000;
  const keyCache = options.keyCache ?? new Map<string, string[]>();
  const fullRead = options.fullRead ?? new Map<string, string>();
  const byBuckets = (options.incremental ?? true) && !!db.bucketSums && !!db.readBuckets;
  const previous = new Map((options.previous?.tables ?? []).map((t) => [tableId(t.table), t]));
  const takenAt = new Date().toISOString();
  const result: TableSnapshot[] = [];

  for (const table of tables) {
    const id = tableId(table);
    let key = keyCache.get(id) ?? [];
    try {
      if (!keyCache.has(id)) {
        key = await db.primaryKey(table);
        keyCache.set(id, key);
      }
      if (byBuckets && !fullRead.has(id)) {
        try {
          result.push(await readByBuckets(db, table, key, previous.get(id), maxRows, options.rowsPerBucket ?? 256));
          continue;
        } catch (e) {
          // e.g. a column type the row hash can't take, or an old server version: read the table in
          // full, and keep doing so if that works (if it doesn't, the table itself is unreadable)
          const full = await readFull(db, table, key, maxRows);
          fullRead.set(id, (e as Error).message);
          result.push(full);
          continue;
        }
      }
      result.push(await readFull(db, table, key, maxRows));
    } catch (e) {
      // one unreadable table (dropped, no permission...) must not stop the others from being recorded
      result.push({ table, key, rows: [], rowCount: 0, skipped: true, error: (e as Error).message });
    }
  }

  return { takenAt, tables: result };
}

async function readFull(db: DbAdapter, table: TableRef, key: string[], maxRows: number): Promise<TableSnapshot> {
  const rowCount = await db.countRows(table);
  if (rowCount > maxRows) return { table, key, rows: [], rowCount, skipped: true };
  const rows = await db.readRows(table);
  return { table, key, rows, rowCount: rows.length };
}

const bucketsFor = (rows: number, key: string[], perBucket: number) =>
  key.length === 0 ? 1 : Math.min(MAX_BUCKETS, Math.max(1, Math.ceil(rows / perBucket)));

/**
 * Asks the database for each bucket's row count and signature sum, and reads only the buckets
 * whose sum differs from the previous snapshot's. The sums kept are computed from the rows
 * actually read, so they always describe the rows held, even if the table changed in between.
 */
async function readByBuckets(
  db: DbAdapter,
  table: TableRef,
  key: string[],
  prev: TableSnapshot | undefined,
  maxRows: number,
  perBucket: number,
): Promise<TableSnapshot> {
  const p = prev?.buckets;
  let total: number | undefined;
  let count: number | undefined;
  if (p) {
    const sums = await db.bucketSums!(table, key, p.count);
    total = 0;
    for (const s of sums.values()) total += s.count;
    if (total > maxRows) return { table, key, rows: [], rowCount: total, skipped: true };
    // keep the bucket count unless the table has grown well beyond it
    if (bucketsFor(total, key, perBucket) <= p.count * 4) {
      count = p.count;
      const changed: number[] = [];
      for (const b of new Set([...sums.keys(), ...p.sums.keys()])) {
        const s = sums.get(b);
        if ((s ? `${s.count}:${s.sum}` : undefined) !== p.sums.get(b)) changed.push(b);
      }
      if (changed.length === 0) {
        return { table, key, rows: prev!.rows, rowCount: prev!.rowCount, buckets: { ...p, changed: new Set() } };
      }
      if (changed.length <= MAX_CHANGED && changed.length <= count / 2) {
        const only = new Set(changed);
        const rows = new Map(p.rows);
        const kept = new Map(p.sums);
        for (const b of changed) {
          rows.delete(b);
          kept.delete(b);
        }
        group(await db.readBuckets!(table, key, count, changed), rows, kept, only);
        return build(table, key, count, rows, kept, only);
      }
    }
  }
  if (total === undefined) {
    total = await db.countRows(table);
    if (total > maxRows) return { table, key, rows: [], rowCount: total, skipped: true };
  }
  count ??= bucketsFor(total, key, perBucket);
  const rows = new Map<number, Row[]>();
  const sums = new Map<number, string>();
  group(await db.readBuckets!(table, key, count), rows, sums);
  return build(table, key, count, rows, sums, undefined);
}

function group(read: BucketedRow[], rows: Map<number, Row[]>, sums: Map<number, string>, only?: Set<number>): void {
  const acc = new Map<number, { n: number; sum: bigint; rows: Row[] }>();
  for (const r of read) {
    if (only && !only.has(r.bucket)) continue;
    let a = acc.get(r.bucket);
    if (!a) acc.set(r.bucket, (a = { n: 0, sum: 0n, rows: [] }));
    a.n++;
    a.sum += BigInt(r.sig);
    a.rows.push(r.row);
  }
  for (const [b, a] of acc) {
    rows.set(b, a.rows);
    sums.set(b, `${a.n}:${a.sum}`);
  }
}

function build(
  table: TableRef,
  key: string[],
  count: number,
  rows: Map<number, Row[]>,
  sums: Map<number, string>,
  changed: Set<number> | undefined,
): TableSnapshot {
  const all = [...rows.values()].flat();
  return { table, key, rows: all, rowCount: all.length, buckets: { count, rows, sums, ...(changed ? { changed } : {}) } };
}
