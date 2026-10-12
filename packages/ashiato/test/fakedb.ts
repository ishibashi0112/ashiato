import type { BucketedRow, BucketSum, DbAdapter, ListedTable } from "../src/adapters/types.js";
import type { Row, TableRef } from "../src/core/types.js";

/**
 * An in-memory database whose bucket queries behave like the real adapters': a hash of the key
 * picks the bucket, and each row carries a version that grows on every insert and update.
 */
export class FakeDb implements DbAdapter {
  readonly dialect = "fake";
  private version = 0;
  readonly tables = new Map<string, { key: string[]; rows: { row: Row; version: number }[]; definition: number }>();
  readonly reads: { table: string; which?: number[] }[] = [];
  /** Tables the recorder told to forget their cached metadata. */
  readonly forgotten: string[] = [];
  failBuckets = new Set<string>();
  /** Tables that can't be read at all (dropped, permission revoked). */
  unreadable = new Set<string>();
  /** Runs inside readBuckets, after the sums were taken: simulates the app writing in between. */
  duringRead?: () => void;

  /** Creates the table, or drops and creates it again. */
  create(name: string, key: string[], rows: Row[] = []) {
    this.tables.set(name, { key, rows: rows.map((row) => ({ row, version: ++this.version })), definition: ++this.version });
  }
  drop(name: string) {
    this.tables.delete(name);
  }
  insert(name: string, row: Row) {
    this.t(name).rows.push({ row, version: ++this.version });
  }
  update(name: string, match: (r: Row) => boolean, set: Partial<Row>) {
    for (const r of this.t(name).rows.filter((x) => match(x.row))) {
      r.row = { ...r.row, ...set } as Row;
      r.version = ++this.version;
    }
  }
  delete(name: string, match: (r: Row) => boolean) {
    const t = this.t(name);
    t.rows = t.rows.filter((x) => !match(x.row));
  }
  private t(name: string) {
    if (this.unreadable.has(name)) throw new Error(`permission denied for table ${name}`);
    return this.tables.get(name)!;
  }
  private bucket(key: string[], row: Row, n: number) {
    if (key.length === 0 || n <= 1) return 0;
    let h = 2166136261;
    for (const ch of JSON.stringify(key.map((k) => row[k]))) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) % n;
  }

  async listTables(): Promise<ListedTable[]> {
    return [...this.tables].map(([name, t]) => ({ name, version: String(t.definition) }));
  }
  forget(t: TableRef) {
    this.forgotten.push(t.name);
  }
  async primaryKey(t: TableRef) {
    return this.t(t.name).key;
  }
  async countRows(t: TableRef) {
    return this.t(t.name).rows.length;
  }
  async readRows(t: TableRef) {
    this.reads.push({ table: t.name });
    return this.t(t.name).rows.map((r) => ({ ...r.row }));
  }
  async bucketSums(t: TableRef, key: string[], n: number) {
    if (this.failBuckets.has(t.name)) throw new Error("FOR JSON cannot serialize CLR objects");
    const sums = new Map<number, BucketSum>();
    for (const r of this.t(t.name).rows) {
      const b = this.bucket(key, r.row, n);
      const s = sums.get(b) ?? { count: 0, sum: 0n };
      sums.set(b, { count: s.count + 1, sum: s.sum + BigInt(r.version) });
    }
    return sums;
  }
  async readBuckets(t: TableRef, key: string[], n: number, which?: number[]) {
    if (this.failBuckets.has(t.name)) throw new Error("FOR JSON cannot serialize CLR objects");
    this.duringRead?.();
    this.reads.push({ table: t.name, which });
    const out: BucketedRow[] = [];
    for (const r of this.t(t.name).rows) {
      const bucket = this.bucket(key, r.row, n);
      if (!which || which.includes(bucket)) out.push({ bucket, sig: String(r.version), row: { ...r.row } });
    }
    return out;
  }
  async close() {}
}
