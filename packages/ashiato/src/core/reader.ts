import type { DbAdapter, ListedTable } from "../adapters/types.js";
import { tableId } from "./diff.js";
import { takeSnapshot } from "./snapshot.js";
import type { Snapshot, TableRef } from "./types.js";

export interface ReaderOptions {
  /**
   * Tables to watch. Matched case-insensitively against `name` or `schema.name`. Default: all tables,
   * including tables created later.
   */
  tables?: string[];
  maxRows?: number;
  /** Re-read only the parts of each table that changed (see `RecorderOptions.incremental`). Default true. */
  incremental?: boolean;
  rowsPerBucket?: number;
}

export interface Read {
  snapshot: Snapshot;
  /** The tables listed for this read: the ones the snapshot holds. */
  listed: TableRef[];
  /** Ids of tables created again or altered since the previous read: they were read in full. */
  reset: string[];
}

/**
 * Lists the watched tables and reads them, keeping what one read needs from the ones before it
 * (primary keys, tables that must be read in full, table versions). Used by the recorder and by
 * the test helpers.
 */
export class TableReader {
  /** As listed at the latest read, with their versions. */
  private watched: ListedTable[] = [];
  private readonly keyCache = new Map<string, string[]>();
  private readonly fullRead = new Map<string, string>();

  constructor(
    private readonly db: DbAdapter,
    private readonly options: ReaderOptions = {},
  ) {}

  /** The watched tables, as of the latest read. */
  get tables(): TableRef[] {
    return this.watched.map(ref);
  }

  /** Resolves the watched tables (throws when a table pattern matches none) and reads them. */
  async start(): Promise<Snapshot> {
    const listed = selectTables(await this.db.listTables(), this.options.tables);
    const snapshot = await this.snapshot(listed.map(ref));
    this.watched = listed;
    return snapshot;
  }

  /**
   * Lists the tables again and reads them, re-reading only what changed since `previous`. Tables
   * created since the previous read are read too, tables that are gone are not, and tables created
   * again or altered (or listed in `reset`) are read in full.
   */
  async read(previous: Snapshot, reset?: ReadonlySet<string>): Promise<Read> {
    const listed = await this.listAgain();
    const changed = this.resetChanged(listed);
    const all = new Set([...changed, ...(reset ?? [])]);
    const base = all.size ? { ...previous, tables: previous.tables.map((t) => (all.has(tableId(t.table)) ? { ...t, buckets: undefined } : t)) } : previous;
    const snapshot = await this.snapshot(listed.map(ref), base);
    this.watched = listed;
    return { snapshot, listed: listed.map(ref), reset: changed };
  }

  /** Tables the database can't read incrementally, so each read takes them in full, with the reason. */
  fullReadTables(): { table: TableRef; reason: string }[] {
    return this.watched.filter((t) => this.fullRead.has(tableId(t))).map((t) => ({ table: ref(t), reason: this.fullRead.get(tableId(t))! }));
  }

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
   * column lists, why bucket reads failed). Returns the ones still there: they are read in full again.
   */
  private resetChanged(listed: ListedTable[]): string[] {
    const now = new Map(listed.map((t) => [tableId(t), t]));
    const reset: string[] = [];
    for (const t of this.watched) {
      const id = tableId(t);
      const n = now.get(id);
      if (n && n.version === t.version) continue;
      this.keyCache.delete(id);
      this.fullRead.delete(id);
      this.db.forget?.(ref(t));
      if (n) reset.push(id);
    }
    return reset;
  }

  private snapshot(tables: TableRef[], previous?: Snapshot): Promise<Snapshot> {
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
export const ref = (t: TableRef): TableRef => (t.schema === undefined ? { name: t.name } : { schema: t.schema, name: t.name });
