import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DbAdapter, ListedTable } from "../adapters/types.js";
import { diffSnapshots, tableId } from "./diff.js";
import { takeSnapshot } from "./snapshot.js";
import type { ActionInfo, Session, SkippedTable, Snapshot, Step, TableRef, TableSnapshot } from "./types.js";

export interface CheckpointOptions {
  action?: ActionInfo;
  /** Don't record the step when nothing changed. */
  dropIfEmpty?: boolean;
}

export interface RecorderOptions {
  /**
   * Tables to watch. Matched case-insensitively against `name` or `schema.name`. Default: all tables,
   * including tables created while recording.
   */
  tables?: string[];
  ignoreColumns?: string[];
  maxRows?: number;
  /**
   * Re-read only the parts of each table that changed, using row versions or row hashes computed
   * by the database (PostgreSQL, MySQL, SQL Server, Oracle). Default true.
   */
  incremental?: boolean;
  /** Rows per bucket for incremental reads. Smaller buckets mean less to re-read after a change. Default 256. */
  rowsPerBucket?: number;
}

/**
 * Holds the latest snapshot and turns each checkpoint into a step: the rows that changed
 * since the previous checkpoint.
 */
export class Recorder extends EventEmitter<{ step: [Step]; ready: [Session] }> {
  readonly session: Session;
  private last?: Snapshot;
  /** As listed at the latest checkpoint, with their versions. */
  private watched: ListedTable[] = [];
  private readonly keyCache = new Map<string, string[]>();
  private readonly fullRead = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: DbAdapter,
    private readonly options: RecorderOptions = {},
  ) {
    super();
    this.session = {
      version: 1,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      dialect: db.dialect,
      tables: [],
      steps: [],
    };
  }

  /** Resolves the watched tables and takes the baseline snapshot. */
  async start(): Promise<Session> {
    const listed = selectTables(await this.db.listTables(), this.options.tables);
    this.last = await this.snapshot(listed.map(ref));
    this.watch(listed);
    this.emit("ready", this.session);
    return this.session;
  }

  /**
   * Takes a new snapshot and records the changes since the previous one. Calls are serialized.
   * With `dropIfEmpty`, a checkpoint that found no changes is not added to the session and resolves to null.
   */
  checkpoint(label: string, source?: string): Promise<Step>;
  checkpoint(label: string, source: string | undefined, options: CheckpointOptions & { dropIfEmpty: true }): Promise<Step | null>;
  checkpoint(label: string, source?: string, options?: CheckpointOptions): Promise<Step | null>;
  checkpoint(label: string, source = "manual", options: CheckpointOptions = {}): Promise<Step | null> {
    const run = this.queue.then(() => this.doCheckpoint(label, source, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doCheckpoint(label: string, source: string, options: CheckpointOptions): Promise<Step | null> {
    if (!this.last) throw new Error("Recorder.start() must be called first");
    const started = performance.now();
    const listed = await this.listAgain();
    const next = await this.snapshot(listed.map(ref), this.resetChanged(listed));
    const diff = diffSnapshots(this.last, next, { ignoreColumns: this.options.ignoreColumns });
    const skipped = skippedBetween(this.last, next, this.options.maxRows ?? 100_000);
    const before = new Map(this.last.tables.map((t) => [tableId(t.table), t]));
    const listedIds = new Set(listed.map(tableId));
    const added = next.tables.filter((t) => !before.has(tableId(t.table))).map((t) => t.table);
    const removed = this.last.tables.filter((t) => !listedIds.has(tableId(t.table))).map((t) => t.table);
    const newlySkipped = next.tables.some((t) => t.skipped && !before.get(tableId(t.table))?.skipped);
    this.last = next;
    this.watch(listed);
    // a table that just became unreadable, appeared or went away is worth a step even without changes
    if (options.dropIfEmpty && diff.tables.length === 0 && !newlySkipped && !added.length && !removed.length) return null;
    const step: Step = {
      id: this.session.steps.length + 1,
      label,
      at: next.takenAt,
      source,
      ...(options.action ? { action: options.action } : {}),
      diff,
      ...(added.length ? { addedTables: added } : {}),
      ...(removed.length ? { removedTables: removed } : {}),
      ...(skipped.length ? { skipped } : {}),
      durationMs: Math.round(performance.now() - started),
    };
    this.session.steps.push(step);
    this.emit("step", step);
    return step;
  }

  /** Tables the database can't read incrementally, so each checkpoint reads them in full, with the reason. */
  fullReadTables(): { table: TableRef; reason: string }[] {
    return this.watched.filter((t) => this.fullRead.has(tableId(t))).map((t) => ({ table: ref(t), reason: this.fullRead.get(tableId(t))! }));
  }

  /** Tables that were too large to snapshot in the latest snapshot. */
  skippedTables(): { table: TableRef; rowCount: number; error?: string }[] {
    return (this.last?.tables ?? [])
      .filter((t) => t.skipped)
      .map((t) => ({ table: t.table, rowCount: t.rowCount, ...(t.error ? { error: t.error } : {}) }));
  }

  private watch(listed: ListedTable[]): void {
    this.watched = listed;
    this.session.tables = listed.map(ref);
  }

  /**
   * The tables to watch now: tables created since the previous checkpoint are watched from this one
   * on (their rows show as inserted), and tables that are gone are no longer read.
   */
  private async listAgain(): Promise<ListedTable[]> {
    try {
      return matching(await this.db.listTables(), this.options.tables);
    } catch {
      // the same query worked at start: keep the tables (if the database is down, reading them says so)
      return this.watched;
    }
  }

  /**
   * Forgets what was cached about tables that were created again, altered or are gone (primary key,
   * column lists, why bucket reads failed), and returns the previous snapshot without the bucket state
   * of the ones still there, so they are read in full again.
   */
  private resetChanged(listed: ListedTable[]): Snapshot {
    const now = new Map(listed.map((t) => [tableId(t), t]));
    const reset = new Set<string>();
    for (const t of this.watched) {
      const id = tableId(t);
      const n = now.get(id);
      if (n && n.version === t.version) continue;
      this.keyCache.delete(id);
      this.fullRead.delete(id);
      this.db.forget?.(ref(t));
      if (n) reset.add(id);
    }
    const last = this.last!;
    if (reset.size === 0) return last;
    return { ...last, tables: last.tables.map((t) => (reset.has(tableId(t.table)) ? { ...t, buckets: undefined } : t)) };
  }

  private snapshot(tables: TableRef[], previous = this.last): Promise<Snapshot> {
    return takeSnapshot(this.db, tables, {
      maxRows: this.options.maxRows,
      keyCache: this.keyCache,
      previous,
      incremental: this.options.incremental,
      rowsPerBucket: this.options.rowsPerBucket,
      fullRead: this.fullRead,
    });
  }
}

/** Tables that couldn't be compared between two snapshots: skipped in either one. */
function skippedBetween(before: Snapshot, after: Snapshot, maxRows: number): SkippedTable[] {
  const prev = new Map(before.tables.map((t) => [tableId(t.table), t]));
  const reason = (t: TableSnapshot) => (t.error ? `could not be read: ${t.error}` : `${t.rowCount} rows (more than max rows ${maxRows})`);
  const out: SkippedTable[] = [];
  for (const a of after.tables) {
    const b = prev.get(tableId(a.table));
    if (a.skipped) out.push({ table: a.table, reason: reason(a) });
    else if (b?.skipped) out.push({ table: a.table, reason: "not read at the previous checkpoint, so nothing to compare with yet" });
  }
  return out;
}

/** The tables matching the patterns (all tables without patterns). Throws when a pattern matches none. */
export function selectTables<T extends TableRef>(all: T[], patterns?: string[]): T[] {
  const selected = matching(all, patterns);
  const wanted = (patterns ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const missing = wanted.filter((w) => !selected.some((t) => t.name.toLowerCase() === w || tableId(t).toLowerCase() === w));
  if (missing.length) throw new Error(`Tables not found: ${missing.join(", ")}`);
  return selected;
}

function matching<T extends TableRef>(all: T[], patterns?: string[]): T[] {
  const wanted = (patterns ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return all;
  return all.filter((t) => wanted.includes(t.name.toLowerCase()) || wanted.includes(tableId(t).toLowerCase()));
}

/** Just the table's name, without what `listTables` adds (sessions are saved as JSON). */
const ref = (t: TableRef): TableRef => (t.schema === undefined ? { name: t.name } : { schema: t.schema, name: t.name });
