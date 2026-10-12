import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import type { DbAdapter } from "../src/adapters/types.js";
import { Recorder } from "../src/core/recorder.js";
import { createAppDb } from "./helpers.js";

let adapter: DbAdapter | undefined;
afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
});

describe("sqlite adapter", () => {
  it("lists tables and primary keys through a read-only connection", async () => {
    const { file } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    expect((await adapter.listTables()).map((t) => t.name)).toEqual(["audit_log", "orders", "stock"]);
    expect(await adapter.primaryKey({ name: "orders" })).toEqual(["id"]);
    expect(await adapter.primaryKey({ name: "audit_log" })).toEqual([]);
    expect(await adapter.countRows({ name: "stock" })).toBe(2);
  });

  it("lists ordinary tables only, including ones whose name starts like sqlite_", async () => {
    const { file, db } = createAppDb();
    db.exec("CREATE TABLE sqlitex (id INTEGER PRIMARY KEY); CREATE VIRTUAL TABLE docs USING fts5(body)");
    adapter = await connect(`sqlite:${file}`);
    expect((await adapter.listTables()).map((t) => t.name)).toEqual(["audit_log", "orders", "sqlitex", "stock"]);
  });

  it("refuses to write", async () => {
    const { file } = createAppDb();
    const { DatabaseSync } = await import("node:sqlite");
    const ro = new DatabaseSync(file, { readOnly: true });
    expect(() => ro.exec("INSERT INTO stock VALUES (9, 1)")).toThrow();
    ro.close();
  });
});

describe("Recorder", () => {
  it("records what each action changed, step by step", async () => {
    const { file, db } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter, { ignoreColumns: ["updated_at"] });
    // tests generated from the session watch the database the same way
    expect((await recorder.start()).options).toEqual({ ignoreColumns: ["updated_at"] });

    db.exec("INSERT INTO orders VALUES (1042, 7, 10, '2026-10-11'); UPDATE stock SET qty = 40 WHERE item_id = 3; INSERT INTO audit_log VALUES ('saved')");
    const save = await recorder.checkpoint("click Save");

    db.exec("UPDATE orders SET updated_at = '2026-10-12' WHERE id = 1042");
    const touch = await recorder.checkpoint("touch only");

    db.exec("DELETE FROM orders WHERE id = 1042");
    const del = await recorder.checkpoint("click Delete", "http");

    const byTable = Object.fromEntries(save.diff.tables.map((t) => [t.table.name, t]));
    expect(byTable.orders?.inserted).toEqual([{ id: 1042, customer_id: 7, qty: 10, updated_at: "2026-10-11" }]);
    expect(byTable.stock?.updated).toEqual([
      { key: { item_id: 3 }, before: { item_id: 3, qty: 50 }, after: { item_id: 3, qty: 40 }, changed: ["qty"] },
    ]);
    expect(byTable.audit_log?.inserted).toEqual([{ message: "saved" }]);

    expect(touch.diff.tables).toEqual([]);
    expect(del.diff.tables[0]?.deleted[0]?.id).toBe(1042);
    expect(del.source).toBe("http");
    expect(recorder.session.steps.map((s) => s.label)).toEqual(["click Save", "touch only", "click Delete"]);
  });

  it("watches only the selected tables and reports unknown ones", async () => {
    const { file } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const session = await new Recorder(adapter, { tables: ["STOCK"] }).start();
    expect(session.tables).toEqual([{ name: "stock" }]);
    await expect(new Recorder(adapter, { tables: ["nope"] }).start()).rejects.toThrow("Tables not found: nope");
  });

  it("skips tables over maxRows instead of reading them", async () => {
    const { file } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter, { maxRows: 1 });
    await recorder.start();
    expect(recorder.skippedTables().map((s) => s.table.name)).toEqual(["stock"]);
  });

  it("reports tables a step could not compare, and keeps recording the others", async () => {
    const { file, db } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter, { maxRows: 2 });
    await recorder.start();

    // stock grows past maxRows: it must not silently look unchanged
    db.exec("INSERT INTO stock VALUES (5, 1); INSERT INTO orders VALUES (1, 1, 1, 'x')");
    const grown = await recorder.checkpoint("grow");
    expect(grown.diff.tables.map((t) => t.table.name)).toEqual(["orders"]);
    expect(grown.skipped).toEqual([{ table: { name: "stock" }, reason: "3 rows (more than max rows 2)" }]);

    // a dropped table is no longer watched
    db.exec("DELETE FROM stock WHERE item_id = 5; DROP TABLE audit_log; UPDATE orders SET qty = 2");
    const dropped = await recorder.checkpoint("drop");
    expect(dropped.diff.tables.map((t) => t.table.name)).toEqual(["orders"]);
    expect(dropped.removedTables).toEqual([{ name: "audit_log" }]);
    expect(dropped.skipped?.map((s) => [s.table.name, s.reason])).toEqual([
      ["stock", "not read at the previous checkpoint, so nothing to compare with yet"],
    ]);

    db.exec("UPDATE stock SET qty = 0");
    const back = await recorder.checkpoint("back");
    expect(back.diff.tables.map((t) => t.table.name)).toEqual(["stock"]);
  });

  it("watches tables created after recording started", async () => {
    const { file, db } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter);
    await recorder.start();

    db.exec("CREATE TABLE work (id INTEGER PRIMARY KEY, total INTEGER); INSERT INTO work VALUES (1, 100), (2, 200)");
    const created = await recorder.checkpoint("create");
    expect(created.addedTables).toEqual([{ name: "work" }]);
    expect(created.diff.tables.map((t) => [t.table.name, t.inserted])).toEqual([
      [
        "work",
        [
          { id: 1, total: 100 },
          { id: 2, total: 200 },
        ],
      ],
    ]);
    expect(recorder.session.tables.map((t) => t.name)).toEqual(["audit_log", "orders", "stock", "work"]);

    db.exec("UPDATE work SET total = 150 WHERE id = 1");
    const upd = await recorder.checkpoint("update");
    expect(upd.addedTables).toBeUndefined();
    expect(upd.diff.tables[0]?.updated).toEqual([{ key: { id: 1 }, before: { id: 1, total: 100 }, after: { id: 1, total: 150 }, changed: ["total"] }]);

    db.exec("DROP TABLE work");
    const gone = await recorder.checkpoint("drop");
    expect(gone.removedTables).toEqual([{ name: "work" }]);
    expect(gone.diff.tables).toEqual([]);
    expect(gone.skipped).toBeUndefined();
    expect((await recorder.checkpoint("idle")).removedTables).toBeUndefined();
  });

  it("watches only new tables that match the selected names", async () => {
    const { file, db } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter, { tables: ["orders"] });
    await recorder.start();
    db.exec("CREATE TABLE work (id INTEGER PRIMARY KEY); INSERT INTO work VALUES (1)");
    // orders created again, in the same step: still watched, and compared with its rows before
    db.exec("INSERT INTO orders VALUES (1, 1, 1, 'x'); DROP TABLE orders; CREATE TABLE orders (id INTEGER PRIMARY KEY, qty INTEGER)");
    db.exec("INSERT INTO orders VALUES (2, 5)");
    const step = await recorder.checkpoint("create");
    expect(step.addedTables).toBeUndefined();
    expect(step.removedTables).toBeUndefined();
    expect(step.diff.tables.map((t) => [t.table.name, t.inserted])).toEqual([["orders", [{ id: 2, qty: 5 }]]]);
    expect(recorder.session.tables).toEqual([{ name: "orders" }]);
  });

  it("uses the new definition of a table created again or altered", async () => {
    const { file, db } = createAppDb();
    db.exec("INSERT INTO orders VALUES (1, 7, 10, 'a'), (2, 7, 20, 'b')");
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter, { tables: ["orders"] });
    await recorder.start();

    // an added column is NULL in every row: no row changed, except the one the app wrote
    db.exec("ALTER TABLE orders ADD COLUMN note TEXT; UPDATE orders SET note = 'rush' WHERE id = 2");
    const altered = await recorder.checkpoint("alter");
    expect(altered.diff.tables[0]?.updated.map((u) => [u.key, u.changed])).toEqual([[{ id: 2 }, ["note"]]]);

    // created again without a primary key: the cached key must not be used
    db.exec("DROP TABLE orders; CREATE TABLE orders (id INTEGER, qty INTEGER); INSERT INTO orders VALUES (1, 10), (2, 25)");
    const recreated = await recorder.checkpoint("re-create");
    const t = recreated.diff.tables[0]!;
    expect(t.key).toEqual([]);
    // compared as whole rows, so the dropped columns make every row differ
    expect(t.deleted.map((r) => r.id)).toEqual([1, 2]);
    expect(t.inserted).toEqual([
      { id: 1, qty: 10 },
      { id: 2, qty: 25 },
    ]);
  });

  it("reads integers beyond 2^53 exactly", async () => {
    const { file, db } = createAppDb();
    db.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO big VALUES (1, 9007199254740993)");
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter, { tables: ["big"] });
    await recorder.start();
    db.exec("UPDATE big SET n = 9007199254740995");
    const step = await recorder.checkpoint("bump");
    expect(step.diff.tables[0]?.updated[0]).toMatchObject({ before: { id: 1, n: "9007199254740993" }, after: { n: "9007199254740995" } });
  });

  it("serializes concurrent checkpoints", async () => {
    const { file, db } = createAppDb();
    adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter);
    await recorder.start();
    db.exec("UPDATE stock SET qty = 1 WHERE item_id = 4");
    const [a, b] = await Promise.all([recorder.checkpoint("a"), recorder.checkpoint("b")]);
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a.diff.tables).toHaveLength(1);
    expect(b.diff.tables).toHaveLength(0);
  });
});
