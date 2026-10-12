/**
 * Playwright fixtures: `expectDbChanges(action, expected)` runs an action and checks what it changed
 * in the database, with read-only access.
 *
 *   import { test, expect } from "ashiato/playwright";
 *
 *   test.use({ ashiato: { ignoreColumns: ["updated_at"] } }); // the database: ASHIATO_DB_URL
 *
 *   test("save an order", async ({ page, expectDbChanges }) => {
 *     await page.goto("/orders/new");
 *     await expectDbChanges(() => page.getByRole("button", { name: "Save" }).click(), {
 *       orders: { inserted: [{ id: expect.any(Number), customer_id: 7, qty: 10 }] },
 *       stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
 *     });
 *   });
 */
import { test as base, expect } from "@playwright/test";
import type { DbChanges, ExpectedChanges } from "../testing/match.js";
import { watchDb, type DbWatcher, type ExpectOptions, type WatchOptions } from "../testing/watch.js";

export interface AshiatoOptions extends WatchOptions {
  /** Connection URL of the database the app writes to. Default: the ASHIATO_DB_URL environment variable. */
  db?: string;
}

/**
 * Runs `action`, then waits until the database changes match `expected`: every table listed changed
 * exactly as described, and no other watched table changed. Resolves to the changes found.
 */
export type ExpectDbChanges = (action: () => unknown, expected: ExpectedChanges, options?: ExpectOptions) => Promise<DbChanges>;

export interface AshiatoFixtures {
  expectDbChanges: ExpectDbChanges;
}

export interface AshiatoWorkerFixtures {
  /** Set with `test.use({ ashiato: { ... } })` or in the config's `use`. */
  ashiato: AshiatoOptions;
  /** One connection per worker, opened when a test first checks the database. */
  ashiatoDb: DbWatcher;
}

export const test = base.extend<AshiatoFixtures, AshiatoWorkerFixtures>({
  ashiato: [{}, { scope: "worker", option: true }],
  ashiatoDb: [
    async ({ ashiato }, use) => {
      const { db, ...options } = ashiato;
      const watcher = watchDb(db, options);
      await use(watcher);
      await watcher.close();
    },
    { scope: "worker" },
  ],
  expectDbChanges: async ({ ashiatoDb }, use) => {
    await use((action, expected, options) =>
      // boxed: a failure points at the test's line, not at this file
      base.step(`expect database changes: ${summarize(expected)}`, () => ashiatoDb.expectChanges(action, expected, options), { box: true }),
    );
  },
});

export { expect };
export type { AsymmetricMatcher, DbChanges, ExpectedChanges, RowPattern, TableChangeSet, TableChanges, UpdatePattern, ValueMatcher } from "../testing/match.js";
export { DbChangesError, DbWatcher, watchDb, type ExpectOptions, type WatchOptions } from "../testing/watch.js";

/** `orders +1, stock ~2`, for the step's title in the report. */
function summarize(expected: ExpectedChanges): string {
  // a wrong expectation gets its own message from expectChanges
  if (typeof expected !== "object" || expected === null) return String(expected);
  const count = (v: number | readonly unknown[] | undefined) => (typeof v === "number" ? v : (v?.length ?? 0));
  const kinds = [["+", "inserted"], ["~", "updated"], ["-", "deleted"]] as const;
  const parts = Object.entries(expected).map(([name, c]) => {
    const n = kinds.filter(([, k]) => count(c?.[k]) > 0).map(([sign, k]) => `${sign}${count(c?.[k])}`);
    return `${name} ${n.length ? n.join(" ") : "unchanged"}`;
  });
  return parts.length ? parts.join(", ") : "none";
}
