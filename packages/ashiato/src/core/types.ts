/** A row as read from the database, with values already normalized to JSON-safe types. */
export type Row = Record<string, JsonValue>;

export type JsonValue = string | number | boolean | null;

export interface TableRef {
  /** Schema / owner. Omitted for databases without schemas (SQLite). */
  schema?: string;
  name: string;
}

export interface TableSnapshot {
  table: TableRef;
  /** Primary key columns. Empty when the table has no primary key. */
  key: string[];
  rows: Row[];
  /** True when the table was not read: more rows than `maxRows`, or reading it failed (see `error`). */
  skipped?: boolean;
  error?: string;
  rowCount: number;
}

/** A watched table a step could not compare, and why. */
export interface SkippedTable {
  table: TableRef;
  reason: string;
}

export interface Snapshot {
  takenAt: string;
  tables: TableSnapshot[];
}

export interface UpdatedRow {
  /** Primary key values identifying the row. */
  key: Row;
  before: Row;
  after: Row;
  /** Columns whose value changed. */
  changed: string[];
}

export interface TableDiff {
  table: TableRef;
  key: string[];
  inserted: Row[];
  deleted: Row[];
  updated: UpdatedRow[];
}

export interface Diff {
  from: string;
  to: string;
  tables: TableDiff[];
}

export interface RequestInfo {
  kind: "http" | "rpc" | "message";
  /** HTTP method, or the RPC method name. */
  method: string;
  /** URL for HTTP requests. */
  url?: string;
  status?: number;
  error?: string;
  durationMs?: number;
}

/** What the user did in the browser that led to a checkpoint (sent by the Vite plugin). */
export interface ActionInfo {
  /** "click" | "submit" | "change" | "enter" | "request" (a request with no user action, e.g. on page load) */
  type: string;
  /** Human-readable target, e.g. `button "Save"`. */
  target?: string;
  /** Page path when the action happened. */
  page?: string;
  startedAt: string;
  requests: RequestInfo[];
}

export interface Step {
  id: number;
  label: string;
  at: string;
  /** Free-form origin of the checkpoint, e.g. "manual", "http", or an RPC method name. */
  source?: string;
  action?: ActionInfo;
  diff: Diff;
  /** Watched tables this step could not compare (too large, or unreadable). Their changes are not in `diff`. */
  skipped?: SkippedTable[];
  durationMs: number;
}

export interface Session {
  version: 1;
  id: string;
  startedAt: string;
  dialect: string;
  tables: TableRef[];
  steps: Step[];
}
