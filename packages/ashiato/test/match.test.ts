import { describe, expect, it } from "vitest";
import type { Diff, TableDiff } from "../src/core/types.js";
import { checkExpectation, matchChanges, valueMatches, type ExpectedChanges, type WatchedTable } from "../src/testing/match.js";

const orders: TableDiff = {
  table: { schema: "dbo", name: "orders" },
  key: ["id"],
  inserted: [
    { id: 1042, customer_id: 7, qty: 10, note: null },
    { id: 1043, customer_id: 8, qty: 1, note: "rush" },
  ],
  updated: [],
  deleted: [],
};
const stock: TableDiff = {
  table: { schema: "dbo", name: "stock" },
  key: ["item_id"],
  inserted: [],
  updated: [{ key: { item_id: 3 }, before: { item_id: 3, qty: 50, at: "a" }, after: { item_id: 3, qty: 40, at: "b" }, changed: ["qty", "at"] }],
  deleted: [],
};
const diff = (...tables: TableDiff[]): Diff => ({ from: "", to: "", tables });
const watched: WatchedTable[] = [{ table: orders.table }, { table: stock.table }, { table: { schema: "dbo", name: "audit_log" } }];
const problems = (d: Diff, e: ExpectedChanges, w = watched) => {
  const r = matchChanges(d, e, w);
  return r.ok ? [] : r.problems;
};

describe("matchChanges", () => {
  it("matches rows one to one in any order, and returns them in the expectation's order", () => {
    const r = matchChanges(
      diff(orders, stock),
      {
        ORDERS: { inserted: [{ customer_id: 8 }, { id: expect.any(Number), customer_id: 7, note: null }] },
        "dbo.stock": { updated: [{ where: { item_id: 3 }, set: { qty: 40, at: "b" } }] },
      },
      watched,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes.ORDERS!.inserted.map((x) => x.id)).toEqual([1043, 1042]);
    expect(r.changes["dbo.stock"]!.updated[0]!.after.qty).toBe(40);
  });

  it("checks counts, and that kinds and tables left out did not change", () => {
    expect(problems(diff(orders, stock), { orders: { inserted: 2 }, stock: { updated: 1 } })).toEqual([]);
    expect(problems(diff(orders), { orders: { inserted: 1 } })).toEqual([
      expect.stringMatching(/^dbo\.orders: 1 inserted row expected, 2 found\n {4}\+ \{ id: 1042,/),
    ]);
    const p = problems(diff(orders, stock), { orders: { inserted: 2 } });
    expect(p).toEqual([expect.stringMatching(/^dbo\.stock changed \(1 updated\), but the expectation doesn't list it:\n {4}~ item_id=3 {2}qty: 50 → 40, at: "a" → "b"/)]);
    expect(problems(diff(orders), { orders: { inserted: 2, deleted: [] }, audit_log: {} })).toEqual([]);
  });

  it("says which expected row matched nothing, and how the closest row differs", () => {
    const [p] = problems(diff(orders), { orders: { inserted: [{ customer_id: 7, qty: 10 }, { customer_id: 8, qty: 2 }] } });
    expect(p).toContain("dbo.orders: 2 inserted rows found, but not the expected ones");
    expect(p).toContain("expected { customer_id: 8, qty: 2 }: no row matches");
    expect(p).toContain('closest: + { id: 1043, customer_id: 8, qty: 1, note: "rush" }');
    expect(p).toContain("qty: expected 2, got 1");

    const [missing] = problems(diff(), { orders: { inserted: [{ customer_id: 7 }] } });
    expect(missing).toBe("dbo.orders: 1 inserted row expected, 0 found\n    expected { customer_id: 7 }: not found");

    const [extra] = problems(diff(orders), { orders: { inserted: [{ customer_id: 7 }] } });
    expect(extra).toMatch(/1 inserted row expected, 2 found\n {4}not expected:\n {6}\+ \{ id: 1043/);
  });

  it("requires every changed column in set, and where to pick the row", () => {
    expect(problems(diff(stock), { stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] } })[0]).toContain('at also changed: "a" → "b"');
    expect(problems(diff(stock), { stock: { updated: [{ where: { item_id: 4 }, set: { qty: 40, at: "b" } }] } })[0]).toContain("where item_id: expected 4, got 3");
    expect(problems(diff(stock), { stock: { updated: [{ where: { item_id: 3 }, set: { qty: 41, at: "b" } }] } })[0]).toContain("set qty: expected 41, got 40");
    // columns are found in any case (Oracle's are upper case)
    expect(problems(diff(stock), { stock: { updated: [{ where: { ITEM_ID: 3 }, set: { QTY: 40, At: "b" } }] } })).toEqual([]);
  });

  it("reports unknown, ambiguous and uncomparable tables", () => {
    expect(problems(diff(), { order: {} })).toEqual(['"order" is not a watched table (watched: dbo.orders, dbo.stock, dbo.audit_log)']);
    const two: WatchedTable[] = [{ table: { schema: "a", name: "t" } }, { table: { schema: "b", name: "t" } }];
    expect(problems(diff(), { t: {} }, two)).toEqual(['"t" is ambiguous: a.t, b.t. Use schema.name']);
    expect(problems(diff(), { "b.T": {} }, two)).toEqual([]);
    expect(problems(diff(), { orders: {} }, [{ table: orders.table, skipped: "it has 200000 rows (more than maxRows)" }])).toEqual([
      "dbo.orders can't be compared: it has 200000 rows (more than maxRows)",
    ]);
    expect(problems(diff(), { orders: {}, "dbo.orders": {} })).toEqual(['"dbo.orders" names dbo.orders, which the expectation already lists under another name']);
  });

  it("names a column the rows don't have", () => {
    expect(problems(diff(orders), { orders: { inserted: [{ id: 1042, qty_typo: 1 }, { id: 1043 }] } })[0]).toContain("no column qty_typo (columns: id, customer_id, qty, note)");
  });
});

describe("valueMatches", () => {
  it("compares values across the types databases return", () => {
    expect(valueMatches(1.5, "1.5")).toBe(true);
    expect(valueMatches("1.50", 1.5)).toBe(true);
    expect(valueMatches("007", 7)).toBe(false);
    expect(valueMatches(12345678901234567890n, "12345678901234567890")).toBe(true);
    expect(valueMatches(true, 1)).toBe(true);
    expect(valueMatches(false, 0)).toBe(true);
    expect(valueMatches(true, 0)).toBe(false);
    expect(valueMatches(null, null)).toBe(true);
    expect(valueMatches(null, 0)).toBe(false);
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11T00:00:00.000Z")).toBe(true);
    expect(valueMatches(/^ord-\d+$/g, "ord-12")).toBe(true);
    expect(valueMatches(/^ord-\d+$/g, "ord-12")).toBe(true); // lastIndex of a global RegExp doesn't carry over
    expect(valueMatches((v) => typeof v === "number" && v > 3, 4)).toBe(true);
    expect(valueMatches(expect.stringContaining("ab"), "xaby")).toBe(true);
  });
});

describe("checkExpectation", () => {
  it("rejects shapes that can't be meant", () => {
    expect(() => checkExpectation({ orders: { added: 1 } } as never)).toThrow('unknown kind "added" for "orders"');
    expect(() => checkExpectation({ orders: { inserted: -1 } })).toThrow("must be a row count");
    expect(() => checkExpectation({ orders: { inserted: {} } } as never)).toThrow("must be a row count or a list of rows");
    expect(() => checkExpectation({ orders: { updated: [{ id: 1 }] } } as never)).toThrow("orders.updated[0] must be { where:");
    expect(() => checkExpectation({ orders: { inserted: [{ meta: { a: 1 } }] } } as never)).toThrow("orders.inserted[0].meta must be a value");
    expect(() => checkExpectation({ orders: { inserted: [{ id: expect.any(Number), at: new Date(), n: /x/, f: () => true, u: undefined }] } })).not.toThrow();
  });
});
