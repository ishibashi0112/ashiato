import { describe, expect, it } from "vitest";
import { diffSnapshots } from "../src/core/diff.js";
import { normalizeValue } from "../src/core/normalize.js";
import type { Snapshot } from "../src/core/types.js";

const snap = (rows: Record<string, unknown>[], key = ["id"], at = "t"): Snapshot => ({
  takenAt: at,
  tables: [{ table: { name: "orders" }, key, rows: rows as never, rowCount: rows.length }],
});

describe("diffSnapshots", () => {
  it("detects inserted, updated and deleted rows by primary key", () => {
    const before = snap([
      { id: 1, qty: 5, note: "a" },
      { id: 2, qty: 3, note: "b" },
    ]);
    const after = snap([
      { id: 1, qty: 10, note: "a" },
      { id: 3, qty: 1, note: "c" },
    ]);
    const [t] = diffSnapshots(before, after).tables;
    expect(t?.inserted).toEqual([{ id: 3, qty: 1, note: "c" }]);
    expect(t?.deleted).toEqual([{ id: 2, qty: 3, note: "b" }]);
    expect(t?.updated).toEqual([
      { key: { id: 1 }, before: { id: 1, qty: 5, note: "a" }, after: { id: 1, qty: 10, note: "a" }, changed: ["qty"] },
    ]);
  });

  it("supports composite keys", () => {
    const before = snap([{ a: 1, b: 1, v: "x" }], ["a", "b"]);
    const after = snap([{ a: 1, b: 1, v: "y" }, { a: 1, b: 2, v: "z" }], ["a", "b"]);
    const [t] = diffSnapshots(before, after).tables;
    expect(t?.updated[0]?.key).toEqual({ a: 1, b: 1 });
    expect(t?.inserted).toHaveLength(1);
  });

  it("ignores configured columns when detecting updates", () => {
    const before = snap([{ id: 1, qty: 5, updated_at: "2026-01-01" }]);
    const after = snap([{ id: 1, qty: 5, updated_at: "2026-01-02" }]);
    expect(diffSnapshots(before, after, { ignoreColumns: ["UPDATED_AT"] }).tables).toEqual([]);
    expect(diffSnapshots(before, after).tables).toHaveLength(1);
  });

  it("omits tables without changes", () => {
    const s = snap([{ id: 1 }]);
    expect(diffSnapshots(s, s).tables).toEqual([]);
  });

  it("compares tables without a key as multisets, keeping duplicates", () => {
    const before = snap([{ v: 1 }, { v: 1 }, { v: 2 }], []);
    const after = snap([{ v: 1 }, { v: 3 }, { v: 2 }], []);
    const [t] = diffSnapshots(before, after).tables;
    expect(t?.inserted).toEqual([{ v: 3 }]);
    expect(t?.deleted).toEqual([{ v: 1 }]);
    expect(t?.updated).toEqual([]);
  });

  it("skips tables that were too large to read", () => {
    const before = snap([{ id: 1 }]);
    const after: Snapshot = { takenAt: "t2", tables: [{ ...before.tables[0]!, rows: [], skipped: true, rowCount: 10 }] };
    expect(diffSnapshots(before, after).tables).toEqual([]);
  });
});

describe("normalizeValue", () => {
  it("turns driver values into comparable JSON values", () => {
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue(10n)).toBe("10");
    expect(normalizeValue(new Date("2026-10-11T00:00:00Z"))).toBe("2026-10-11T00:00:00.000Z");
    expect(normalizeValue(Buffer.from([1, 255]))).toBe("0x01ff");
    expect(normalizeValue({ toString: () => "12.50" })).toBe("12.50");
    expect(normalizeValue({ a: 1 })).toBe('{"a":1}');
  });
});
