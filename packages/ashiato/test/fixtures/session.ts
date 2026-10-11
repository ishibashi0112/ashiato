import type { Session } from "../../src/core/types.js";

/** A saved session with the kinds of steps and values an evidence export has to handle. */
export function sampleSession(): Session {
  const t0 = Date.parse("2026-10-11T04:00:00.000Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  return {
    version: 1,
    id: "s1",
    startedAt: at(0),
    dialect: "mssql",
    tables: [
      { schema: "dbo", name: "orders" },
      { schema: "dbo", name: "stock" },
      { schema: "dbo", name: "audit_log" },
      { schema: "dbo", name: "big" },
    ],
    steps: [
      {
        id: 1,
        label: 'click button "保存"',
        at: at(10),
        source: "POST /api/orders, GET /api/orders",
        action: {
          type: "click",
          target: 'button "保存"',
          page: "/orders/new",
          tab: "tab1",
          startedAt: at(9),
          requests: [
            { kind: "http", method: "POST", url: "/api/orders", status: 200, durationMs: 31 },
            { kind: "http", method: "GET", url: "/api/orders", status: 200, durationMs: 8 },
          ],
        },
        diff: {
          from: at(0),
          to: at(10),
          tables: [
            {
              table: { schema: "dbo", name: "orders" },
              key: ["id"],
              inserted: [{ id: 1042, customer: "山田 太郎", qty: 10, note: null, code: "00123", big_id: "9007199254740993", flag: true }],
              deleted: [],
              updated: [],
            },
            {
              table: { schema: "dbo", name: "stock" },
              key: ["item_id"],
              inserted: [],
              deleted: [],
              updated: [
                { key: { item_id: 3 }, before: { item_id: 3, qty: 50, name: "ねじ" }, after: { item_id: 3, qty: 40, name: "ねじ" }, changed: ["qty"] },
              ],
            },
          ],
        },
        durationMs: 12,
      },
      {
        id: 2,
        label: "outside actions",
        at: at(20),
        source: "sync",
        diff: {
          from: at(10),
          to: at(20),
          tables: [
            {
              table: { schema: "dbo", name: "audit_log" },
              key: [],
              inserted: [{ message: "line1\r\nline2 \u0001 _x0041_ <tag> & \"q\"" }],
              deleted: [{ message: "old" }],
              updated: [],
            },
          ],
        },
        skipped: [{ table: { schema: "dbo", name: "big" }, reason: "200000 rows (more than max rows 100000)" }],
        durationMs: 5,
      },
      { id: 3, label: "checkpoint 3", at: at(30), source: "manual", diff: { from: at(20), to: at(30), tables: [] }, durationMs: 3 },
      {
        id: 4,
        label: 'click button "削除"',
        at: at(40),
        source: "orders.delete",
        action: { type: "click", target: 'button "削除"', page: "/orders/1042", tab: "tab1", startedAt: at(39), requests: [{ kind: "rpc", method: "orders.delete", error: "timeout" }] },
        diff: {
          from: at(30),
          to: at(40),
          tables: [{ table: { schema: "dbo", name: "orders" }, key: ["id"], inserted: [], updated: [], deleted: [{ id: 1042, customer: "山田 太郎", qty: 10, note: null, code: "00123", big_id: "9007199254740993", flag: true }] }],
        },
        durationMs: 9,
      },
      {
        id: 5,
        label: "checkpoint 5",
        at: at(50),
        source: "manual",
        diff: { from: at(40), to: at(50), tables: [] },
        addedTables: [{ schema: "dbo", name: "empty_new" }],
        removedTables: [{ schema: "dbo", name: "old_work" }],
        durationMs: 3,
      },
    ],
  };
}
