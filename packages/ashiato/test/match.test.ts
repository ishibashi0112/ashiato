import { describe, expect, it } from "vitest";
import type { Diff, TableDiff } from "../src/core/types.js";
import type { Expect } from "@playwright/test";
import { checkExpectation, matchChanges, tableProblems, valueMatches, type ExpectedChanges, type WatchedTable } from "../src/testing/match.js";

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

    // a row two patterns fit: the second isn't shown a "closest" row that fits it
    const [twice] = problems(diff(orders), { orders: { inserted: [{ customer_id: 7 }, { qty: 10 }] } });
    expect(twice).toContain("expected { qty: 10 }: the rows it fits are taken by the other rows expected");
    expect(twice).toContain("not expected:\n      + { id: 1043");
    // with as many rows as expected, every row not expected is shown
    const [both] = problems(diff(orders), { orders: { inserted: [{ customer_id: 9 }, { customer_id: 10 }] } });
    expect(both).toContain("closest: + { id: 1042");
    expect(both).toContain("not expected:\n      + { id: 1043");
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

    // known before the action: everything but a name that fits no table yet
    expect(tableProblems({ t: {}, order: {} }, two)).toEqual(['"t" is ambiguous: a.t, b.t. Use schema.name']);
    expect(tableProblems({ orders: {}, "dbo.orders": {} }, watched)).toEqual(['"dbo.orders" names dbo.orders, which the expectation already lists as "orders"']);
  });

  it("names a column the rows don't have", () => {
    expect(problems(diff(orders), { orders: { inserted: [{ id: 1042, qty_typo: 1 }, { id: 1043 }] } })[0]).toContain("no column qty_typo (columns: id, customer_id, qty, note)");
  });

  it("shows, for an update, the row its where picks as the closest one", () => {
    const two: TableDiff = {
      ...stock,
      updated: [
        { key: { item_id: 3 }, before: { item_id: 3, qty: 50, version: 1 }, after: { item_id: 3, qty: 40, version: 2 }, changed: ["qty", "version"] },
        { key: { item_id: 4 }, before: { item_id: 4, qty: 20, version: 1 }, after: { item_id: 4, qty: 15, version: 2 }, changed: ["qty", "version"] },
      ],
    };
    const [p] = problems(diff(two), { stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40, version: 2 } }, { where: { item_id: 4 }, set: { qty: 15 } }] } });
    expect(p).toContain("closest: ~ item_id=4  qty: 20 → 15, version: 1 → 2\n        version also changed: 1 → 2");
    expect(p).not.toContain("not expected");
  });

  it("shows where two long texts differ", () => {
    const long = "Deliver to the back door of the warehouse, between 9 and 12, and call 03-1234-5678 first";
    const t: TableDiff = { ...orders, inserted: [{ id: 1, note: long }] };
    const [p] = problems(diff(t), { orders: { inserted: [{ note: long.replace("5678", "5679") }] } });
    expect(p).toContain('note: expected "…and call 03-1234-5679 first", got "…and call 03-1234-5678 first" (they differ from character 82)');
  });

  it("takes a function that throws on another row's value as not fitting it", () => {
    const t: TableDiff = { ...orders, inserted: [{ id: 1, code: null }, { id: 2, code: "ORD-2" }] };
    const startsWith = (v: unknown) => (v as string).startsWith("ORD-");
    expect(problems(diff(t), { orders: { inserted: [{ code: startsWith }, { id: 1 }] } })).toEqual([]);
    const none: TableDiff = { ...orders, inserted: [{ id: 1, code: null }, { id: 2, code: "X-2" }] };
    const [p] = problems(diff(none), { orders: { inserted: [{ code: startsWith }, { id: 2 }] } });
    expect(p).toMatch(/code: expected a value startsWith\(\) accepts, got null \(the function threw TypeError: Cannot read properties of null/);
    // an arrow function written in the pattern is named after its column: not shown as qty()
    expect(problems(diff(orders), { orders: { inserted: [{ qty: (v) => v === 3 }, { id: 1043 }] } })[0]).toContain("qty: expected a value the function accepts, got 10");
  });

  it("tells a table that can no longer be read apart from one that didn't change", () => {
    const lost: WatchedTable[] = [{ table: orders.table }, { table: stock.table, skipped: "it could not be read: connection lost", lost: true }];
    expect(problems(diff(orders), { orders: { inserted: 2 } }, lost)).toEqual(["dbo.stock can't be compared, so whether it changed is unknown: it could not be read: connection lost"]);
    // one that could not be read before the action either is just not watched
    expect(problems(diff(orders), { orders: { inserted: 2 } }, [{ table: orders.table }, { table: stock.table, skipped: "it has 200000 rows (more than maxRows)" }])).toEqual([]);
  });

  it("returns copies of the rows found", () => {
    const r = matchChanges(diff(orders), { orders: { inserted: 2 } }, watched);
    if (!r.ok) throw new Error(r.problems.join());
    r.changes.orders!.inserted[0]!.note = "changed";
    expect(orders.inserted[0]!.note).toBe(null);
  });

  it("names tables that differ only in case by the case written", () => {
    const cased: WatchedTable[] = [{ table: { schema: "public", name: "User" } }, { table: { schema: "public", name: "user" } }];
    const users = (name: string): TableDiff => ({ table: { schema: "public", name }, key: ["id"], inserted: [{ id: 1 }], updated: [], deleted: [] });
    expect(problems(diff(users("User")), { "public.User": { inserted: 1 } }, cased)).toEqual([]);
    expect(problems(diff(users("User")), { User: { inserted: 1 } }, cased)).toEqual([]);
    expect(problems(diff(users("user")), { USER: { inserted: 1 } }, cased)).toEqual(['"USER" is ambiguous: public.User, public.user. Use schema.name', expect.stringContaining("public.user changed")]);
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
    // without a time zone: UTC, on any machine
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11 00:00:00")).toBe(true);
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11 00:00:00.000000")).toBe(true);
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11")).toBe(true);
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11 09:00:00+09")).toBe(true);
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11 09:00:00+0900")).toBe(true);
    expect(valueMatches(new Date("2026-10-11T00:00:00Z"), "2026-10-11 00:00:01")).toBe(false);
    // MySQL BIT(1) is read as bytes, PostgreSQL bit(1) as text
    expect(valueMatches(true, "0x01")).toBe(true);
    expect(valueMatches(false, "0x00")).toBe(true);
    expect(valueMatches(true, "1")).toBe(true);
    expect(valueMatches(false, "0x01")).toBe(false);
    expect(valueMatches(/^ord-\d+$/g, "ord-12")).toBe(true);
    expect(valueMatches(/^ord-\d+$/g, "ord-12")).toBe(true); // lastIndex of a global RegExp doesn't carry over
    expect(valueMatches((v) => typeof v === "number" && v > 3, 4)).toBe(true);
    expect(valueMatches(expect.stringContaining("ab"), "xaby")).toBe(true);
  });
});

// Playwright types its matchers as Record<string, any>: they must fit where values go (checked by tsc)
export function playwrightMatchersFit(e: Expect<object>): ExpectedChanges {
  return { orders: { inserted: [{ id: e.any(Number), note: e.stringContaining("x") }], updated: [{ where: { id: 1 }, set: { at: e.anything() } }] } };
}

describe("checkExpectation", () => {
  it("rejects shapes that can't be meant", () => {
    expect(() => checkExpectation({ orders: { added: 1 } } as never)).toThrow('unknown kind "added" for "orders"');
    expect(() => checkExpectation({ orders: { inserted: -1 } })).toThrow("must be a row count");
    expect(() => checkExpectation({ orders: { inserted: {} } } as never)).toThrow("must be a row count or a list of rows");
    expect(() => checkExpectation({ orders: { updated: [{ id: 1 }] } } as never)).toThrow("orders.updated[0] must be { where:");
    expect(() => checkExpectation({ orders: { inserted: [{ meta: { a: 1 } }] } } as never)).toThrow("orders.inserted[0].meta must be a value");
    expect(() => checkExpectation({ orders: { inserted: [{ id: expect.any(Number), at: new Date(), n: /x/, f: () => true, u: undefined }] } })).not.toThrow();
    expect(() => checkExpectation({ orders: { inserted: [{ at: new Date("x") }] } })).toThrow("orders.inserted[0].at is an invalid Date");
    // a type is a slip for expect.any(type): as a function it would accept almost anything
    expect(() => checkExpectation({ orders: { inserted: [{ name: String }] } })).toThrow("orders.inserted[0].name is the type String: for any String value, write expect.any(String)");
    expect(() => checkExpectation({ orders: { updated: [{ where: { id: 1 }, set: { at: Date } }] } })).toThrow("orders.updated[0].set.at is the type Date");
  });
});

// rows of an interface type (no index signature) and lists made `as const` fit too (checked by tsc)
interface NewOrder {
  customer_id: number;
  qty: number;
}
export function typedRowsFit(order: NewOrder): ExpectedChanges {
  const rows = [{ qty: 1 }] as const;
  return { orders: { inserted: [order], deleted: rows }, stock: { updated: [{ where: order, set: { qty: (v) => v !== null } }] } };
}
