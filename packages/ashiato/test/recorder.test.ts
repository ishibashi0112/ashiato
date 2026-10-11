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
    await recorder.start();

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
