import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/adapters/index.js";
import { DbChangesError, watchDb, type DbWatcher } from "../src/testing/watch.js";
import { FakeDb } from "./fakedb.js";
import { createAppDb } from "./helpers.js";

let watcher: DbWatcher | undefined;
afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
});

const later = (ms: number, fn: () => void) => () => void setTimeout(fn, ms);

// counts the connections the watcher opens and closes
const opened = vi.hoisted(() => ({ open: 0, closed: 0 }));
vi.mock("../src/adapters/index.js", async (original) => {
  const real = await original<typeof import("../src/adapters/index.js")>();
  return {
    ...real,
    connect: async (url: string) => {
      const db = await real.connect(url);
      opened.open++;
      const close = db.close.bind(db);
      db.close = async () => {
        opened.closed++;
        await close();
      };
      return db;
    },
  };
});

describe("expectChanges", () => {
  it("waits for the action's changes and returns them", async () => {
    const { file, db } = createAppDb();
    watcher = watchDb(`sqlite:${file}`, { ignoreColumns: ["updated_at"], settleMs: 50 });
    db.exec("INSERT INTO audit_log VALUES ('before the watcher started')");

    // the app writes a moment after the click
    const changes = await watcher.expectChanges(
      later(300, () => db.exec("INSERT INTO orders VALUES (1042, 7, 10, '2026-10-11'); UPDATE stock SET qty = 40 WHERE item_id = 3")),
      {
        orders: { inserted: [{ id: expect.any(Number), customer_id: 7, qty: 10 }] },
        stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
      },
    );
    expect(changes.orders!.inserted).toEqual([{ id: 1042, customer_id: 7, qty: 10, updated_at: "2026-10-11" }]);

    // the next action is compared from just before it: the earlier changes and ignored columns don't count
    db.exec("INSERT INTO audit_log VALUES ('between actions')");
    await watcher.expectChanges(() => db.exec("UPDATE orders SET updated_at = '2026-10-12'"), {});
    await watcher.expectChanges(() => db.exec("DELETE FROM orders WHERE id = 1042"), { orders: { deleted: [{ id: 1042 }] } });
  });

  it("fails with what differs and what changed, once the timeout is over", async () => {
    const { file, db } = createAppDb();
    watcher = watchDb(`sqlite:${file}`, { timeout: 400, settleMs: 50 });
    const started = Date.now();
    const error = await watcher
      .expectChanges(() => db.exec("INSERT INTO orders VALUES (1, 7, 9, NULL); INSERT INTO audit_log VALUES ('x')"), {
        orders: { inserted: [{ customer_id: 7, qty: 10 }] },
      })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(error).toBeInstanceOf(DbChangesError);
    const message = (error as Error).message;
    expect(message).toContain("Database changes don't match (waited 0.4s after the action):");
    expect(message).toContain("orders: 1 inserted row found, but not the expected ones");
    expect(message).toContain("qty: expected 10, got 9");
    expect(message).toContain("audit_log changed (1 inserted), but the expectation doesn't list it");
    expect(message).toMatch(/Changes found:\n {2}audit_log\n {4}\+ \{ message: "x" \}\n {2}orders\n {4}\+ \{ id: 1, customer_id: 7, qty: 9, updated_at: null \}/);
    expect((error as DbChangesError).diff.tables).toHaveLength(2);
  });

  it("doesn't pass while later writes of the action are still coming", async () => {
    const { file, db } = createAppDb();
    watcher = watchDb(`sqlite:${file}`, { timeout: 1000, settleMs: 300 });
    const error = await watcher
      .expectChanges(
        () => {
          db.exec("INSERT INTO orders VALUES (1, 7, 9, NULL)");
          setTimeout(() => db.exec("INSERT INTO audit_log VALUES ('written a moment later')"), 150);
        },
        { orders: { inserted: 1 } },
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain("audit_log changed (1 inserted)");
  });

  it("checks that nothing changed", async () => {
    const { file, db } = createAppDb();
    watcher = watchDb(`sqlite:${file}`, { timeout: 300, settleMs: 100 });
    await expect(watcher.expectChanges(() => undefined, {})).resolves.toEqual({});
    await expect(watcher.expectChanges(later(30, () => db.exec("DELETE FROM stock WHERE item_id = 4")), {})).rejects.toThrow(
      /stock changed \(1 deleted\), but the expectation doesn't list it:\n {4}- \{ item_id: 4, qty: 20 \}/,
    );
  });

  it("rejects a bad expectation before running the action, and an unreadable table before acting", async () => {
    const db = new FakeDb();
    db.create("orders", ["id"]);
    db.create("big", ["id"], [{ id: 1 }, { id: 2 }]);
    watcher = watchDb(db, { maxRows: 1 });
    let ran = false;
    await expect(watcher.expectChanges(() => (ran = true), { orders: { inserted: "1" } } as never)).rejects.toThrow(TypeError);
    await expect(watcher.expectChanges(() => (ran = true), {}, { ignoreColumns: ["x"] } as never)).rejects.toThrow(
      "ignoreColumns can't be set per call, only for the watcher",
    );
    await expect(watcher.expectChanges(() => (ran = true), { orders: {}, ORDERS: {} })).rejects.toThrow('"ORDERS" names orders, which the expectation already lists as "orders"');
    await expect(watcher.expectChanges(() => (ran = true), { big: { inserted: 1 } })).rejects.toThrow(
      "big can't be compared: it has 2 rows (more than maxRows)",
    );
    expect(ran).toBe(false);
  });

  it("compares from before the action when reading only the parts that changed", async () => {
    const db = new FakeDb();
    db.create("items", ["id"], Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, qty: 1 })));
    watcher = watchDb(db, { settleMs: 50, pollMs: 20 });
    // changes land over several reads: each read must still compare from the baseline
    const changes = await watcher.expectChanges(
      () => {
        db.update("items", (r) => r.id === 5, { qty: 2 });
        setTimeout(() => db.insert("items", { id: 3000, qty: 1 }), 60);
        setTimeout(() => db.delete("items", (r) => r.id === 7), 120);
      },
      { items: { inserted: [{ id: 3000 }], updated: [{ where: { id: 5 }, set: { qty: 2 } }], deleted: [{ id: 7 }] } },
    );
    expect(changes.items!.deleted).toEqual([{ id: 7, qty: 1 }]);
    // only the changed parts were read again
    const last = db.reads.at(-1)!;
    expect(last.which?.length).toBeLessThan(10);
  });

  it("watches tables the action creates, and reports a table it can't find", async () => {
    const db = new FakeDb();
    db.create("orders", ["id"]);
    watcher = watchDb(db, { settleMs: 20, timeout: 200 });
    await watcher.expectChanges(() => db.create("imports", ["id"], [{ id: 1 }]), { imports: { inserted: [{ id: 1 }] } });
    await expect(watcher.expectChanges(() => undefined, { order: {} })).rejects.toThrow('"order" is not a watched table (watched: orders, imports)');
  });

  it("connects lazily and says when there is no database", async () => {
    const saved = process.env.ASHIATO_DB_URL;
    delete process.env.ASHIATO_DB_URL;
    try {
      watcher = watchDb(undefined);
      await expect(watcher.expectChanges(() => undefined, {})).rejects.toThrow("No database to watch: pass a connection URL or set ASHIATO_DB_URL");
    } finally {
      if (saved !== undefined) process.env.ASHIATO_DB_URL = saved;
    }
  });

  it("closes a connection whose start failed, and closes after the calls made before", async () => {
    const { file } = createAppDb();
    opened.open = opened.closed = 0;
    const w = watchDb(`sqlite:${file}`, { tables: ["nope"], settleMs: 10 });
    for (let i = 0; i < 3; i++) await expect(w.expectChanges(() => undefined, {})).rejects.toThrow("nope");
    await w.close();
    expect(opened).toEqual({ open: 3, closed: 3 });

    const w2 = watchDb(`sqlite:${file}`, { settleMs: 10 });
    const first = w2.expectChanges(() => undefined, {});
    const closing = w2.close();
    await expect(first).resolves.toEqual({});
    await expect(w2.expectChanges(() => undefined, {})).rejects.toThrow("this database watcher is closed");
    await Promise.all([closing, w2.close()]);
    expect(opened).toEqual({ open: 4, closed: 4 });
  });

  it("leaves an adapter it was given open", async () => {
    const { file } = createAppDb();
    const adapter = await connect(`sqlite:${file}`);
    const w = watchDb(adapter, { settleMs: 10 });
    await w.expectChanges(() => undefined, {});
    await w.close();
    expect((await adapter.listTables()).length).toBe(3);
    await adapter.close();
  });
});
