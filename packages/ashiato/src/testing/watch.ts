import { connect } from "../adapters/index.js";
import type { DbAdapter } from "../adapters/types.js";
import { diffSnapshots, tableId } from "../core/diff.js";
import { TableReader } from "../core/reader.js";
import type { Diff, Snapshot } from "../core/types.js";
import { checkExpectation, describeDiff, matchChanges, tableProblems, type DbChanges, type ExpectedChanges, type WatchedTable } from "./match.js";

export interface ExpectOptions {
  /** How long to wait for the expected changes after the action. Default 5000ms. */
  timeout?: number;
  /**
   * Once the changes match, how long they must stay as they are: writes that come a little later
   * (a second request) would otherwise be missed. Also how long "no changes" is waited for. Default 300ms.
   */
  settleMs?: number;
  /** Time between reads while waiting. Default 100ms. */
  pollMs?: number;
}

export interface WatchOptions extends ExpectOptions {
  /** Tables to watch (`name` or `schema.name`, case-insensitive). Default: all. Tables not watched are never checked. */
  tables?: string[];
  /** Columns ignored when detecting updates (e.g. `updated_at`). */
  ignoreColumns?: string[];
  /** Tables with more rows than this are not read, so not checked. Default 100,000. */
  maxRows?: number;
  /** Re-read only the parts of tables that changed. Default true. */
  incremental?: boolean;
}

/** Thrown when the changes don't match. `diff` is what changed. */
export class DbChangesError extends Error {
  constructor(
    message: string,
    readonly diff: Diff,
  ) {
    super(message);
    this.name = "DbChangesError";
  }
}

/**
 * Connects lazily (on first use), so it can be created at the top of a test file:
 *
 *   const db = watchDb(process.env.ASHIATO_DB_URL, { ignoreColumns: ["updated_at"] });
 *   await db.expectChanges(() => page.getByRole("button", { name: "Save" }).click(), {
 *     orders: { inserted: [{ customer_id: 7, qty: 10 }] },
 *   });
 */
export function watchDb(db: string | DbAdapter | undefined, options: WatchOptions = {}): DbWatcher {
  return new DbWatcher(db, options);
}

/**
 * Watches a database with read-only access and checks what an action changed in it. Calls are run
 * one at a time.
 */
export class DbWatcher {
  private adapter?: DbAdapter;
  private reader?: TableReader;
  /** The latest snapshot read: the next action is compared from it, read again first. */
  private last?: Snapshot;
  private starting?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(
    private readonly source: string | DbAdapter | undefined,
    private readonly options: WatchOptions = {},
  ) {}

  /**
   * Runs `action`, then waits until the database changes match `expected`: every table listed changed
   * exactly as described, and no other watched table changed. Resolves to the changes found.
   */
  expectChanges(action: () => unknown, expected: ExpectedChanges, options: ExpectOptions = {}): Promise<DbChanges> {
    try {
      if (this.closing) throw new Error("this database watcher is closed");
      checkExpectation(expected);
      checkOptions(options);
      checkTimes(this.options, "watcher option");
    } catch (e) {
      return Promise.reject(e);
    }
    const run = this.queue.then(() => this.run(action, expected, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Closes the connection (when this watcher opened it), once the calls made before have finished. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.queue;
      await this.starting?.catch(() => undefined);
      if (typeof this.source === "string" || this.source === undefined) await this.adapter?.close();
      this.adapter = undefined;
    })();
    return this.closing;
  }

  private start(): Promise<void> {
    this.starting ??= (async () => {
      const source = this.source ?? process.env.ASHIATO_DB_URL;
      if (!source) throw new Error("No database to watch: pass a connection URL or set ASHIATO_DB_URL");
      const db = typeof source === "string" ? await connect(source) : source;
      const reader = new TableReader(db, this.options);
      try {
        this.last = await reader.start();
      } catch (e) {
        // the next call connects again: don't leave this connection open
        if (db !== source) await db.close().catch(() => undefined);
        throw e;
      }
      this.adapter = db;
      this.reader = reader;
    })();
    // a failed connection is tried again by the next call
    this.starting.catch(() => (this.starting = undefined));
    return this.starting;
  }

  private async run(action: () => unknown, expected: ExpectedChanges, options: ExpectOptions): Promise<DbChanges> {
    const o = { timeout: 5000, settleMs: 300, pollMs: 100, ...defined(this.options), ...defined(options) };
    await this.start();
    const reader = this.reader!;
    const baseline = (await reader.read(this.last!)).snapshot;
    this.last = baseline;
    // a listed table that can't be read now, or a name that fits two tables, won't be right a moment later: say so before acting
    const problems = tableProblems(expected, watchedIn(baseline, baseline));
    if (problems.length) throw new Error(problems.join("\n"));

    await action();

    const deadline = Date.now() + o.timeout;
    const reset = new Set<string>();
    let settled: { since: number; text: string } | undefined;
    for (;;) {
      // read from the baseline, so the changes are the action's whole changes, not since the last read
      const read = await reader.read(baseline, reset);
      for (const id of read.reset) reset.add(id);
      this.last = read.snapshot;
      const diff = diffSnapshots(baseline, read.snapshot, { ignoreColumns: this.options.ignoreColumns });
      const result = matchChanges(diff, expected, watchedIn(baseline, read.snapshot));
      const now = Date.now();
      if (result.ok) {
        const text = JSON.stringify(diff.tables);
        if (settled?.text !== text) settled = { since: now, text };
        if (now - settled.since >= o.settleMs || now >= deadline) return result.changes;
        await sleep(Math.max(o.pollMs, settled.since + o.settleMs - now));
        continue;
      }
      settled = undefined;
      if (now >= deadline) {
        const waited = Math.round(o.timeout / 1000 * 10) / 10;
        throw new DbChangesError(
          `Database changes don't match (waited ${waited}s after the action):\n\n${result.problems.map((p) => `  ${p}`).join("\n")}\n\nChanges found:\n${describeDiff(diff)}`,
          // a copy: its rows are the snapshot the next call compares from
          structuredClone(diff),
        );
      }
      await sleep(o.pollMs);
    }
  }
}

/** The tables watched now, with those that can't be compared (unreadable now, or at the baseline). */
function watchedIn(baseline: Snapshot, now: Snapshot): WatchedTable[] {
  const base = new Map(baseline.tables.map((t) => [tableId(t.table), t]));
  return now.tables.map((t) => {
    const b = base.get(tableId(t.table));
    const why = (s: { error?: string; rowCount: number }) => (s.error ? `it could not be read: ${s.error}` : `it has ${s.rowCount} rows (more than maxRows)`);
    if (t.skipped) return { table: t.table, skipped: why(t), ...(b && !b.skipped ? { lost: true } : {}) };
    if (b?.skipped) return { table: t.table, skipped: `${why(b)} before the action` };
    return { table: t.table };
  });
}

const EXPECT_OPTIONS = ["timeout", "settleMs", "pollMs"];

function checkOptions(options: unknown): void {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null) throw new TypeError("options must be an object: { timeout, settleMs, pollMs }");
  const other = Object.keys(options).filter((k) => !EXPECT_OPTIONS.includes(k));
  if (other.length) throw new TypeError(`${other.join(", ")} can't be set per call, only for the watcher (test.use({ ashiato: { ... } }) or watchDb()). Per call: ${EXPECT_OPTIONS.join(", ")}`);
  checkTimes(options as ExpectOptions, "option");
}

/** A timeout of NaN (`Number(process.env.X)` unset) or "1000" would never be reached: waiting would never end. */
function checkTimes(options: ExpectOptions, what: string): void {
  for (const k of EXPECT_OPTIONS) {
    const v = options[k as keyof ExpectOptions];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new TypeError(`${what} ${k} must be a number of milliseconds (got ${typeof v === "string" ? JSON.stringify(v) : String(v)})`);
  }
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
