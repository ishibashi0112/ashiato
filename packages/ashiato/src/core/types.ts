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
  /** Set when the table was read by buckets, so the next snapshot can re-read only the buckets that changed. */
  buckets?: BucketState;
}

export interface BucketState {
  /** Number of buckets the rows are spread over. */
  count: number;
  rows: Map<number, Row[]>;
  /** `count:sum` of each non-empty bucket, compared with the database's at the next snapshot. */
  sums: Map<number, string>;
  /** Buckets read again for this snapshot; the others are unchanged since the previous one. Undefined when all were read. */
  changed?: Set<number>;
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
  /** Browser tab the action happened in; matches the tab of its screen replay events. */
  tab?: string;
  startedAt: string;
  /** When the last of the user's events taken as this one action happened (a click after a change, Enter pressed again), if not at startedAt. */
  lastAt?: string;
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
  /** Tables that appeared since the previous step (created, renamed, or newly readable). Watched from this step on; their rows are in `diff` as inserted. */
  addedTables?: TableRef[];
  /** Watched tables that are gone (dropped, renamed, or no longer readable). No longer watched; their rows are not in `diff`. */
  removedTables?: TableRef[];
  /** Watched tables this step could not compare (too large, or unreadable). Their changes are not in `diff`. */
  skipped?: SkippedTable[];
  durationMs: number;
}

/** A screen recording made from the timeline UI. Files live next to the session file. */
export interface VideoInfo {
  id: number;
  file: string;
  mimeType: string;
  startedAt: string;
  endedAt?: string;
}

export interface SessionOptions {
  /** The tables asked for (`--tables`), when not all. */
  tables?: string[];
  ignoreColumns?: string[];
  /** When not the default (100,000). */
  maxRows?: number;
}

export interface Session {
  version: 1;
  id: string;
  startedAt: string;
  dialect: string;
  /** Tables watched as of the latest step (tables created while recording are added). */
  tables: TableRef[];
  /** The recorder's options that decide what the steps show (tests generated from the session use them too). */
  options?: SessionOptions;
  steps: Step[];
  /** Screen replay (rrweb DOM events, one JSON batch per line), next to the session file. */
  replay?: { file: string };
  videos?: VideoInfo[];
}
