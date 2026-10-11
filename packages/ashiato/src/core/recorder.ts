import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DbAdapter } from "../adapters/types.js";
import { diffSnapshots, tableId } from "./diff.js";
import { takeSnapshot } from "./snapshot.js";
import type { ActionInfo, Session, Snapshot, Step, TableRef } from "./types.js";

export interface CheckpointOptions {
  action?: ActionInfo;
  /** Don't record the step when nothing changed. */
  dropIfEmpty?: boolean;
}

export interface RecorderOptions {
  /** Tables to watch. Matched case-insensitively against `name` or `schema.name`. Default: all tables. */
  tables?: string[];
  ignoreColumns?: string[];
  maxRows?: number;
}

/**
 * Holds the latest snapshot and turns each checkpoint into a step: the rows that changed
 * since the previous checkpoint.
 */
export class Recorder extends EventEmitter<{ step: [Step]; ready: [Session] }> {
  readonly session: Session;
  private last?: Snapshot;
  private watched: TableRef[] = [];
  private readonly keyCache = new Map<string, string[]>();
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
    const all = await this.db.listTables();
    this.watched = selectTables(all, this.options.tables);
    this.session.tables = this.watched;
    this.last = await this.snapshot();
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
    const next = await this.snapshot();
    const diff = diffSnapshots(this.last, next, { ignoreColumns: this.options.ignoreColumns });
    this.last = next;
    if (options.dropIfEmpty && diff.tables.length === 0) return null;
    const step: Step = {
      id: this.session.steps.length + 1,
      label,
      at: next.takenAt,
      source,
      ...(options.action ? { action: options.action } : {}),
      diff,
      durationMs: Math.round(performance.now() - started),
    };
    this.session.steps.push(step);
    this.emit("step", step);
    return step;
  }

  /** Tables that were too large to snapshot in the latest snapshot. */
  skippedTables(): { table: TableRef; rowCount: number }[] {
    return (this.last?.tables ?? []).filter((t) => t.skipped).map((t) => ({ table: t.table, rowCount: t.rowCount }));
  }

  private snapshot(): Promise<Snapshot> {
    return takeSnapshot(this.db, this.watched, { maxRows: this.options.maxRows, keyCache: this.keyCache });
  }
}

export function selectTables(all: TableRef[], patterns?: string[]): TableRef[] {
  if (!patterns || patterns.length === 0) return all;
  const wanted = patterns.map((p) => p.trim().toLowerCase()).filter(Boolean);
  const selected = all.filter((t) => wanted.includes(t.name.toLowerCase()) || wanted.includes(tableId(t).toLowerCase()));
  const missing = wanted.filter((w) => !selected.some((t) => t.name.toLowerCase() === w || tableId(t).toLowerCase() === w));
  if (missing.length) throw new Error(`Tables not found: ${missing.join(", ")}`);
  return selected;
}
