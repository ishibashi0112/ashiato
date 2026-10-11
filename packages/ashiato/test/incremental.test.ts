import { describe, expect, it } from "vitest";
import type { BucketedRow, BucketSum, DbAdapter, ListedTable } from "../src/adapters/types.js";
import { Recorder } from "../src/core/recorder.js";
import type { Row, Step, TableRef } from "../src/core/types.js";

/**
 * An in-memory database whose bucket queries behave like the real adapters': a hash of the key
 * picks the bucket, and each row carries a version that grows on every insert and update.
 */
class FakeDb implements DbAdapter {
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

const items = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, qty: 10, note: `item ${from + i}` }));
const only = (step: Step) => {
  const [t, ...rest] = step.diff.tables;
  expect(rest).toEqual([]);
  return t!;
};
const sorted = (step: Step) =>
  step.diff.tables.map((t) => ({
    table: t.table.name,
    inserted: [...t.inserted].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    deleted: [...t.deleted].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    updated: [...t.updated].sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key))),
  }));

describe("incremental reads", () => {
  it("re-reads only the buckets that changed", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(1000));
    const recorder = new Recorder(db, { rowsPerBucket: 10 });
    await recorder.start();
    expect(db.reads).toEqual([{ table: "stock", which: undefined }]);

    db.reads.length = 0;
    expect((await recorder.checkpoint("idle")).diff.tables).toEqual([]);
    expect(db.reads).toEqual([]);

    db.update("stock", (r) => r.id === 500, { qty: 9 });
    const upd = only(await recorder.checkpoint("update"));
    expect(upd.updated).toEqual([
      { key: { id: 500 }, before: { id: 500, qty: 10, note: "item 500" }, after: { id: 500, qty: 9, note: "item 500" }, changed: ["qty"] },
    ]);
    expect(db.reads).toHaveLength(1);
    expect(db.reads[0]!.which).toHaveLength(1);

    db.reads.length = 0;
    db.insert("stock", { id: 2000, qty: 1, note: "new" });
    db.delete("stock", (r) => r.id === 7);
    const ins = only(await recorder.checkpoint("insert + delete"));
    expect(ins.inserted).toEqual([{ id: 2000, qty: 1, note: "new" }]);
    expect(ins.deleted).toEqual([{ id: 7, qty: 10, note: "item 7" }]);
    expect(ins.updated).toEqual([]);
    expect(db.reads[0]!.which!.length).toBeLessThanOrEqual(2);

    // a key change moves the row to another bucket: both are re-read
    db.update("stock", (r) => r.id === 8, { id: 3000 });
    const moved = only(await recorder.checkpoint("key change"));
    expect(moved.deleted.map((r) => r.id)).toEqual([8]);
    expect(moved.inserted.map((r) => r.id)).toEqual([3000]);
  });

  it("finds the same changes as reading every row", async () => {
    const db = new FakeDb();
    db.create("a", ["id"], items(300));
    db.create("b", ["x", "y"], items(200).map((r) => ({ x: r.id % 7, y: r.id, v: r.qty })));
    db.create("logs", [], [{ m: "start" }]);
    const fast = new Recorder(db, { rowsPerBucket: 8 });
    const full = new Recorder(db, { incremental: false });
    await fast.start();
    await full.start();
    let seed = 42;
    const rand = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
    let changes = 0;
    for (let round = 0; round < 30; round++) {
      for (let k = rand(5); k > 0; k--) {
        const [op, id, value] = [rand(6), 1 + rand(300), rand(5)];
        if (op === 0) db.insert("a", { id: 1000 + round * 10 + k, qty: value, note: "n" });
        if (op === 1) db.update("a", (r) => r.id === id, { qty: value });
        if (op === 2) db.delete("a", (r) => r.id === id);
        if (op === 3) db.update("b", (r) => r.y === id, { v: value });
        if (op === 4) db.insert("logs", { m: `round ${round}` });
        if (op === 5) db.update("a", (r) => r.id === id, { id: 5000 + round * 10 + k });
      }
      const [x, y] = [await fast.checkpoint(`r${round}`), await full.checkpoint(`r${round}`)];
      expect(sorted(x)).toEqual(sorted(y));
      changes += y.diff.tables.length;
    }
    expect(changes).toBeGreaterThan(20);
  });

  it("keeps the rows it read, even when the app writes between the sums and the read", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(100));
    const recorder = new Recorder(db, { rowsPerBucket: 10 });
    await recorder.start();
    db.update("stock", (r) => r.id === 1, { qty: 1 });
    // the app changes another row while the changed bucket is being read
    db.duringRead = () => {
      db.duringRead = undefined;
      db.update("stock", (r) => r.id === 2, { qty: 2 });
    };
    const first = await recorder.checkpoint("first");
    const second = await recorder.checkpoint("second");
    const all = [...first.diff.tables, ...second.diff.tables].flatMap((t) => t.updated.map((u) => u.key.id));
    // each change is reported exactly once
    expect(all.sort()).toEqual([1, 2]);
    db.reads.length = 0;
    expect((await recorder.checkpoint("idle")).diff.tables).toEqual([]);
    expect(db.reads).toEqual([]);
  });

  it("reads a table in full when its bucket queries fail, and says why", async () => {
    const db = new FakeDb();
    db.create("geo", ["id"], items(50));
    db.failBuckets.add("geo");
    const recorder = new Recorder(db);
    await recorder.start();
    expect(recorder.fullReadTables()).toEqual([{ table: { name: "geo" }, reason: "FOR JSON cannot serialize CLR objects" }]);
    db.update("geo", (r) => r.id === 3, { qty: 1 });
    expect(only(await recorder.checkpoint("update")).updated).toHaveLength(1);
  });

  it("re-buckets a table that grew well beyond its bucket count", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(5));
    const recorder = new Recorder(db, { rowsPerBucket: 10 });
    await recorder.start();
    for (const r of items(995, 6)) db.insert("stock", r);
    expect(only(await recorder.checkpoint("bulk insert")).inserted).toHaveLength(995);
    db.reads.length = 0;
    db.update("stock", (r) => r.id === 600, { qty: 0 });
    expect(only(await recorder.checkpoint("update")).updated).toHaveLength(1);
    // spread over about 100 buckets now, so a single change re-reads one small bucket
    expect(db.reads[0]!.which).toHaveLength(1);
  });

  it("skips tables over max rows using the database's counts, and compares them again once they shrink", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(40));
    const recorder = new Recorder(db, { maxRows: 50, rowsPerBucket: 10 });
    await recorder.start();
    for (const r of items(20, 100)) db.insert("stock", r);
    const big = await recorder.checkpoint("grow");
    expect(big.diff.tables).toEqual([]);
    expect(big.skipped).toEqual([{ table: { name: "stock" }, reason: "60 rows (more than max rows 50)" }]);
    db.delete("stock", (r) => Number(r.id) >= 100);
    expect((await recorder.checkpoint("shrink")).skipped?.[0]?.reason).toMatch(/not read at the previous checkpoint/);
    db.update("stock", (r) => r.id === 1, { qty: 0 });
    expect(only(await recorder.checkpoint("update")).updated).toHaveLength(1);
  });

  it("reads a table without a primary key only when it changed", async () => {
    const db = new FakeDb();
    db.create("logs", [], [{ m: "a" }, { m: "b" }]);
    const recorder = new Recorder(db);
    await recorder.start();
    db.reads.length = 0;
    await recorder.checkpoint("idle");
    expect(db.reads).toEqual([]);
    db.insert("logs", { m: "c" });
    expect(only(await recorder.checkpoint("log")).inserted).toEqual([{ m: "c" }]);
  });

  it("watches a table created while recording, re-reading only what changed from then on", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(10));
    const recorder = new Recorder(db, { rowsPerBucket: 10 });
    await recorder.start();
    db.create("work", ["id"], items(100));
    db.reads.length = 0;
    const created = await recorder.checkpoint("create");
    expect(created.addedTables).toEqual([{ name: "work" }]);
    expect(only(created).inserted).toHaveLength(100);
    expect(db.reads).toEqual([{ table: "work", which: undefined }]);
    expect(recorder.session.tables).toEqual([{ name: "stock" }, { name: "work" }]);

    db.reads.length = 0;
    db.update("work", (r) => r.id === 50, { qty: 0 });
    expect(only(await recorder.checkpoint("update")).updated).toHaveLength(1);
    expect(db.reads).toHaveLength(1);
    expect(db.reads[0]!.which).toHaveLength(1);
  });

  it("reads a table created again in full, with what was cached about it forgotten", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(100));
    db.failBuckets.add("stock");
    const recorder = new Recorder(db, { rowsPerBucket: 10 });
    await recorder.start();
    expect(recorder.fullReadTables()).toHaveLength(1);

    // same rows, but now keyed by note: the cached key [id] must not be used
    db.failBuckets.clear();
    db.create("stock", ["note"], items(100));
    db.update("stock", (r) => r.id === 5, { qty: 0 });
    db.reads.length = 0;
    const step = await recorder.checkpoint("re-create");
    expect(db.forgotten).toEqual(["stock"]);
    expect(step.addedTables).toBeUndefined();
    expect(only(step).key).toEqual(["note"]);
    expect(only(step).updated.map((u) => [u.key, u.changed])).toEqual([[{ note: "item 5" }, ["qty"]]]);
    expect(only(step).inserted).toEqual([]);
    // bucket reads work for the new table: it is no longer read in full
    expect(db.reads).toEqual([{ table: "stock", which: undefined }]);
    expect(recorder.fullReadTables()).toEqual([]);

    db.reads.length = 0;
    expect((await recorder.checkpoint("idle")).diff.tables).toEqual([]);
    expect(db.reads).toEqual([]);
    expect(db.forgotten).toEqual(["stock"]);
  });

  it("stops reading a table that is gone, and says so once", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(3));
    db.create("work", ["id"], items(2));
    const recorder = new Recorder(db);
    await recorder.start();
    db.drop("work");
    const sync = await recorder.checkpoint("outside actions", "sync", { dropIfEmpty: true });
    expect(sync?.removedTables).toEqual([{ name: "work" }]);
    expect(sync?.diff.tables).toEqual([]);
    expect(sync?.skipped).toBeUndefined();
    expect(db.forgotten).toEqual(["work"]);
    expect(recorder.session.tables).toEqual([{ name: "stock" }]);
    expect(await recorder.checkpoint("outside actions", "sync", { dropIfEmpty: true })).toBeNull();

    // created again later: a new table, compared with nothing
    db.create("work", ["id"], items(1));
    const back = await recorder.checkpoint("create again");
    expect(back.addedTables).toEqual([{ name: "work" }]);
    expect(only(back).inserted).toEqual(items(1));
  });

  it("keeps a checkpoint that would be dropped for having no changes when a table appeared", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(1));
    const recorder = new Recorder(db);
    await recorder.start();
    db.create("empty", ["id"]);
    const sync = await recorder.checkpoint("outside actions", "sync", { dropIfEmpty: true });
    expect(sync?.addedTables).toEqual([{ name: "empty" }]);
    expect(sync?.diff.tables).toEqual([]);
  });

  it("keeps watching the same tables when listing them fails", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(2));
    const recorder = new Recorder(db);
    await recorder.start();
    db.listTables = () => Promise.reject(new Error("connection reset"));
    db.update("stock", (r) => r.id === 1, { qty: 0 });
    const step = await recorder.checkpoint("update");
    expect(only(step).updated).toHaveLength(1);
    expect(step.removedTables).toBeUndefined();
    expect(db.forgotten).toEqual([]);
  });

  it("keeps a checkpoint that would be dropped for having no changes when a table just became unreadable", async () => {
    const db = new FakeDb();
    db.create("stock", ["id"], items(10));
    const recorder = new Recorder(db);
    await recorder.start();
    db.unreadable.add("stock");
    const sync = await recorder.checkpoint("outside actions", "sync", { dropIfEmpty: true });
    expect(sync?.skipped).toEqual([{ table: { name: "stock" }, reason: "could not be read: permission denied for table stock" }]);
    // still unreadable: nothing new to say, so an empty sync is dropped again
    expect(await recorder.checkpoint("outside actions", "sync", { dropIfEmpty: true })).toBeNull();
  });
});
