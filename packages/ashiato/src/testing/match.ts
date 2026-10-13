import { tableId } from "../core/diff.js";
import { exactDecimal } from "../core/normalize.js";
import type { Diff, JsonValue, Row, TableDiff, TableRef, UpdatedRow } from "../core/types.js";

/**
 * What a column's value must be: a value, a `RegExp` (tested against the value as text), a
 * function returning true for good values, a `Date` (the same moment; a time without a time zone,
 * as most databases give it, is read as UTC), or an asymmetric matcher of Playwright / Vitest / Jest
 * such as `expect.any(Number)`.
 */
export type ValueMatcher = JsonValue | bigint | Date | RegExp | ((value: JsonValue) => boolean) | AsymmetricMatcher;

/**
 * `expect.any(Number)`, `expect.stringMatching(/x/)`... Playwright types them as `Record<string, any>`;
 * whether they have `asymmetricMatch` is checked when the expectation is.
 */
export type AsymmetricMatcher = Asymmetric | Record<string, any>;

interface Asymmetric {
  asymmetricMatch(actual: unknown): boolean;
}

/**
 * Some of a row's columns and what their values must be. Other columns (and `undefined` ones) can hold
 * anything. (`object` lets in values of an interface type, which have no index signature.)
 */
export type RowPattern = Columns | object;

type Columns = { readonly [column: string]: ValueMatcher | undefined };

/** An updated row: `where` picks it out by its values before the update, `set` lists every column the update changed. */
export interface UpdatePattern {
  where: RowPattern;
  set: RowPattern;
}

/**
 * The changes expected in one table. A list must match the changed rows one to one, a number is just
 * how many rows changed that way. A kind left out means no row changed that way.
 */
export interface TableChanges {
  inserted?: number | readonly RowPattern[];
  updated?: number | readonly UpdatePattern[];
  deleted?: number | readonly RowPattern[];
}

/** Expected changes by table (`name` or `schema.name`, case-insensitive). Tables left out must not change. */
export type ExpectedChanges = Record<string, TableChanges>;

/** The rows that changed in a table. Rows matched by a list are in the list's order. */
export interface TableChangeSet {
  table: TableRef;
  inserted: Row[];
  updated: UpdatedRow[];
  deleted: Row[];
}

/** The changes found, by the table names used in the expectation. */
export type DbChanges = Record<string, TableChangeSet>;

export type MatchResult = { ok: true; changes: DbChanges } | { ok: false; problems: string[] };

/** A watched table as the matcher sees it: absent from the diff when nothing changed in it. */
export interface WatchedTable {
  table: TableRef;
  /** Why it can't be compared (too large, unreadable). */
  skipped?: string;
  /** It could be read before the action but not now: what it changed is unknown, listed or not. */
  lost?: boolean;
}

/**
 * For `ashiato verify`, not exported from the package: in an update's `set`, the column changed by
 * this much (after − before, exactly). `by` is a decimal number as text.
 */
export class ChangeBy {
  constructor(readonly by: string) {}
}

/** For `ashiato verify`, not exported from the package: as a key of an update's `set`, columns the set doesn't list may change too. */
export const OTHER_COLUMNS: unique symbol = Symbol("other columns may change");

export interface MatchOptions {
  /** Tables the expectation doesn't list: they must not change (default), or may change in any way. */
  unlisted?: "unchanged" | "any";
}

const KINDS = ["inserted", "updated", "deleted"] as const;
type Kind = (typeof KINDS)[number];

/** Throws a TypeError for an expectation that isn't shaped right, before anything runs. */
export function checkExpectation(expected: ExpectedChanges): void {
  if (!isPlainObject(expected)) throw new TypeError("expected changes must be an object: { tableName: { inserted, updated, deleted } }");
  for (const [table, changes] of Object.entries(expected)) {
    if (!isPlainObject(changes)) throw new TypeError(`expected changes of "${table}" must be an object with inserted, updated and / or deleted`);
    for (const k of Object.keys(changes)) {
      if (!(KINDS as readonly string[]).includes(k)) throw new TypeError(`unknown kind "${k}" for "${table}" (use inserted, updated or deleted)`);
    }
    for (const kind of KINDS) {
      const v = changes[kind];
      if (v === undefined) continue;
      if (typeof v === "number") {
        if (!Number.isInteger(v) || v < 0) throw new TypeError(`${table}.${kind} must be a row count (a whole number) or a list of rows`);
        continue;
      }
      if (!Array.isArray(v)) throw new TypeError(`${table}.${kind} must be a row count or a list of rows`);
      v.forEach((p: unknown, i) => {
        const where = `${table}.${kind}[${i}]`;
        if (kind === "updated") {
          if (!isPlainObject(p) || !isPlainObject(p.where) || !isPlainObject(p.set)) {
            throw new TypeError(`${where} must be { where: { ...key columns }, set: { ...changed columns } }`);
          }
          checkValues(p.where, `${where}.where`);
          checkValues(p.set, `${where}.set`, true);
        } else if (!isPlainObject(p)) throw new TypeError(`${where} must be an object of column values`);
        else checkValues(p, where);
      });
    }
  }
}

/** Built-in types: `{ name: String }` is a slip for `expect.any(String)`, not a function that accepts values. */
const TYPES = new Set<unknown>([String, Number, Boolean, BigInt, Date, Object, Array, RegExp, Symbol, Buffer]);

function checkValues(pattern: Record<string, unknown>, where: string, set = false): void {
  for (const [col, v] of Object.entries(pattern)) {
    if (v instanceof ChangeBy) {
      if (!set) throw new TypeError(`${where}.${col}: a change by an amount is only for an update's set`);
      continue;
    }
    if (typeof v === "function" && (TYPES.has(v) || /^class\b/.test(Function.prototype.toString.call(v)))) {
      throw new TypeError(`${where}.${col} is the type ${v.name}: for any ${v.name} value, write expect.any(${v.name})`);
    }
    if (v instanceof Date && Number.isNaN(v.getTime())) throw new TypeError(`${where}.${col} is an invalid Date`);
    const ok =
      v === null ||
      v === undefined ||
      ["string", "number", "boolean", "bigint", "function"].includes(typeof v) ||
      v instanceof Date ||
      v instanceof RegExp ||
      isAsymmetric(v);
    if (!ok) throw new TypeError(`${where}.${col} must be a value, a RegExp, a function, a Date or a matcher like expect.any(Number)`);
  }
}

/**
 * Compares the changes found with the expected ones. `watched` are the tables that were watched
 * (the diff only has those that changed).
 */
export function matchChanges(diff: Diff, expected: ExpectedChanges, watched: WatchedTable[], options: MatchOptions = {}): MatchResult {
  const problems: string[] = [];
  const changes: DbChanges = {};
  const byId = new Map(diff.tables.map((t) => [tableId(t.table), t]));
  const claimed = new Set<string>();

  for (const [name, exp] of Object.entries(expected)) {
    const found = resolveTable(name, watched);
    if (typeof found === "string") {
      problems.push(found);
      continue;
    }
    const id = tableId(found.table);
    if (claimed.has(id)) {
      problems.push(`"${name}" names ${id}, which the expectation already lists under another name`);
      continue;
    }
    claimed.add(id);
    if (found.skipped) {
      problems.push(`${id} can't be compared: ${found.skipped}`);
      continue;
    }
    const t = byId.get(id) ?? { table: found.table, key: [], inserted: [], updated: [], deleted: [] };
    const set: TableChangeSet = { table: found.table, inserted: [], updated: [], deleted: [] };
    for (const kind of KINDS) {
      const r = matchKind(t, kind, exp[kind] ?? 0);
      if (r.problems.length) problems.push(...r.problems.map((p) => `${id}: ${p}`));
      // copies: the rows found are the ones the next call compares from, changing them must not change that
      else (set[kind] as unknown[]) = structuredClone(r.rows);
    }
    changes[name] = set;
  }

  if (options.unlisted === "any") return problems.length ? { ok: false, problems } : { ok: true, changes };
  for (const t of diff.tables) {
    const id = tableId(t.table);
    if (claimed.has(id)) continue;
    const parts = KINDS.filter((k) => t[k].length).map((k) => `${t[k].length} ${k}`);
    problems.push(`${id} changed (${parts.join(", ")}), but the expectation doesn't list it:\n${indent(describeTable(t, 5), 4)}`);
  }
  // a table not listed must not change: one that can no longer be read may have
  for (const w of watched) {
    const id = tableId(w.table);
    if (w.lost && !claimed.has(id)) problems.push(`${id} can't be compared, so whether it changed is unknown: ${w.skipped}`);
  }

  return problems.length ? { ok: false, problems } : { ok: true, changes };
}

/**
 * What is wrong with the expectation's tables before anything happens: names that fit several tables,
 * tables listed twice, and tables that can't be compared. A name that fits no table only with
 * `missing` (otherwise the action may create it).
 */
export function tableProblems(expected: ExpectedChanges, watched: WatchedTable[], missing = false): string[] {
  const problems: string[] = [];
  const claimed = new Map<string, string>();
  for (const name of Object.keys(expected)) {
    const found = resolveTable(name, watched);
    if (typeof found === "string") {
      if (missing || / is ambiguous: /.test(found)) problems.push(found);
      continue;
    }
    const id = tableId(found.table);
    if (claimed.has(id)) problems.push(`"${name}" names ${id}, which the expectation already lists as "${claimed.get(id)}"`);
    else if (found.skipped) problems.push(`${id} can't be compared: ${found.skipped}`);
    claimed.set(id, name);
  }
  return problems;
}

function resolveTable(name: string, watched: WatchedTable[]): WatchedTable | string {
  const n = name.trim();
  // schema.name before name, and the case as written before any case (two tables can differ only in case)
  const tries = [
    (w: WatchedTable) => tableId(w.table) === n,
    (w: WatchedTable) => tableId(w.table).toLowerCase() === n.toLowerCase(),
    (w: WatchedTable) => w.table.name === n,
    (w: WatchedTable) => w.table.name.toLowerCase() === n.toLowerCase(),
  ];
  let found: WatchedTable[] = [];
  for (const fits of tries) if (!found.length) found = watched.filter(fits);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) return `"${name}" is ambiguous: ${found.map((w) => tableId(w.table)).join(", ")}. Use schema.name`;
  const names = watched.map((w) => tableId(w.table));
  const shown = names.length > 30 ? `${names.slice(0, 30).join(", ")}, …` : names.join(", ");
  return `"${name}" is not a watched table (watched: ${shown || "none"})`;
}

type KindResult = { rows: unknown[]; problems: string[] };

function matchKind(t: TableDiff, kind: Kind, expected: number | readonly RowPattern[] | readonly UpdatePattern[]): KindResult {
  const actual: (Row | UpdatedRow)[] = t[kind];
  const rowsOf = (n: number) => `${n} ${kind} row${n === 1 ? "" : "s"}`;
  const show = (list: (Row | UpdatedRow)[]) => {
    const lines = list.slice(0, 5).map((r) => describeChange(t, kind, r));
    if (list.length > 5) lines.push(`… ${list.length - 5} more`);
    return lines.map((l) => `\n    ${l}`).join("");
  };
  if (typeof expected === "number") {
    if (actual.length === expected) return { rows: actual, problems: [] };
    return { rows: [], problems: [`${rowsOf(expected)} expected, ${actual.length} found${show(actual)}`] };
  }

  const fits = (i: number, j: number) =>
    kind === "updated" ? updateMismatch(expected[i] as UpdatePattern, actual[j] as UpdatedRow).length === 0 : rowMismatch(expected[i] as RowPattern, actual[j] as Row).length === 0;
  const pairs = maxMatching(expected.length, actual.length, fits);
  const matched = pairs.filter((j) => j >= 0).length;
  if (matched === expected.length && matched === actual.length) return { rows: pairs.map((j) => actual[j]), problems: [] };

  const unmatchedRows = actual.filter((_, j) => !pairs.includes(j));
  const lines: string[] = [];
  const shown = new Set<Row | UpdatedRow>();
  expected.forEach((p, i) => {
    if (pairs[i]! >= 0) return;
    const text = kind === "updated" ? describeUpdatePattern(p as UpdatePattern) : describePattern(p as RowPattern);
    const mismatch = (row: Row | UpdatedRow) => (kind === "updated" ? updateMismatch(p as UpdatePattern, row as UpdatedRow) : rowMismatch(p as RowPattern, row as Row));
    if (actual.some((row) => mismatch(row).length === 0)) {
      lines.push(`expected ${text}: the rows it fits are taken by the other rows expected`);
      return;
    }
    lines.push(`expected ${text}: ${actual.length ? "no row matches" : "not found"}`);
    // the row it is closest to, to show what differs: for an update, first a row its `where` picks
    const rank = (row: Row | UpdatedRow, why: string[]) =>
      (kind === "updated" && rowMismatch((p as UpdatePattern).where, (row as UpdatedRow).before).length ? 1e6 : 0) + why.length;
    let best: { row: Row | UpdatedRow; why: string[]; rank: number } | undefined;
    for (const row of unmatchedRows.length ? unmatchedRows : actual) {
      const why = mismatch(row);
      const r = rank(row, why);
      if (!best || r < best.rank) best = { row, why, rank: r };
    }
    if (best) {
      shown.add(best.row);
      lines.push(`  closest: ${describeChange(t, kind, best.row)}`, ...best.why.map((w) => `    ${w}`));
    }
  });
  // with as many rows as expected, the closest rows above are ones not expected: the rest are listed
  const unexpected = expected.length === actual.length ? unmatchedRows.filter((r) => !shown.has(r)) : unmatchedRows;
  if (unexpected.length) lines.push(`not expected:${show(unexpected).replace(/\n {4}/g, "\n  ")}`);
  const head = expected.length === actual.length ? `${rowsOf(actual.length)} found, but not the expected ones` : `${rowsOf(expected.length)} expected, ${actual.length} found`;
  return { rows: [], problems: [`${head}\n${indent(lines.join("\n"), 4)}`] };
}

/**
 * Pairs patterns with rows, one to one, as many as possible (augmenting paths). Returns the row index
 * of each pattern, or -1.
 */
function maxMatching(patterns: number, rows: number, fits: (i: number, j: number) => boolean): number[] {
  const adj = Array.from({ length: patterns }, (_, i) => Array.from({ length: rows }, (_, j) => j).filter((j) => fits(i, j)));
  const rowOwner = new Array<number>(rows).fill(-1);
  const assign = (i: number, seen: Set<number>): boolean => {
    for (const j of adj[i]!) {
      if (seen.has(j)) continue;
      seen.add(j);
      if (rowOwner[j] === -1 || assign(rowOwner[j]!, seen)) {
        rowOwner[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < patterns; i++) assign(i, new Set());
  const result = new Array<number>(patterns).fill(-1);
  rowOwner.forEach((i, j) => i >= 0 && (result[i] = j));
  return result;
}

/** The column of the row a pattern's column names: as written, or else the one column of that name in any case. */
function columnOf(row: Row, name: string): string | undefined {
  if (name in row) return name;
  const lower = name.toLowerCase();
  const found = Object.keys(row).filter((c) => c.toLowerCase() === lower);
  return found.length === 1 ? found[0] : undefined;
}

/** Why the row doesn't fit the pattern: one entry per column that differs (empty when it fits). */
function rowMismatch(pattern: RowPattern, row: Row, what = ""): string[] {
  const why: string[] = [];
  for (const [name, m] of Object.entries(pattern as Columns)) {
    if (m === undefined) continue;
    const col = columnOf(row, name);
    if (col === undefined) {
      why.push(`no column ${what}${name} (columns: ${Object.keys(row).join(", ")})`);
      continue;
    }
    const actual = row[col]!;
    let ok: boolean;
    let threw = "";
    try {
      ok = valueMatches(m, actual);
    } catch (e) {
      // a function written for the expected row can fail on another row's values (a null): that row doesn't fit
      ok = false;
      threw = ` (the function threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)})`;
    }
    if (!ok) why.push(`${what}${col}: ${describeMismatch(m, actual, name)}${threw}`);
  }
  return why;
}

function updateMismatch(p: UpdatePattern, u: UpdatedRow): string[] {
  const why = rowMismatch(p.where, u.before, "where ");
  // once the row is the right one, say how the update differs
  if (why.length) return why;
  const columns = p.set as Columns;
  const set = Object.keys(columns).filter((k) => columns[k] !== undefined);
  if (!(OTHER_COLUMNS in columns)) {
    for (const c of u.changed) {
      if (!set.some((s) => columnOf(u.after, s) === c)) why.push(`${c} also changed: ${describeValue(u.before[c] ?? null)} → ${describeValue(u.after[c] ?? null)}`);
    }
  }
  const values: Record<string, ValueMatcher | undefined> = {};
  for (const name of set) {
    const m = columns[name];
    if (!(m instanceof ChangeBy)) {
      values[name] = m;
      continue;
    }
    const col = columnOf(u.after, name);
    if (col === undefined) why.push(`no column set ${name} (columns: ${Object.keys(u.after).join(", ")})`);
    else {
      const before = u.before[col] ?? null;
      const after = u.after[col] ?? null;
      const by = decimalDifference(after, before);
      if (by === undefined || by !== exactDecimal(m.by)) why.push(`set ${col}: expected ${describeMatcher(m)}, got ${describeValue(before)} → ${describeValue(after)}`);
    }
  }
  return [...why, ...rowMismatch(values, u.after, "set ")];
}

/** after − before, exactly (as `exactDecimal` gives it), for numbers and decimals read as text; undefined for other values. */
function decimalDifference(after: JsonValue, before: JsonValue): JsonValue | undefined {
  const a = scaled(after);
  const b = scaled(before);
  if (!a || !b) return undefined;
  const scale = Math.max(a.scale, b.scale);
  const n = a.n * 10n ** BigInt(scale - a.scale) - b.n * 10n ** BigInt(scale - b.scale);
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return exactDecimal(`${n < 0n ? "-" : ""}${text}`);
}

function scaled(v: JsonValue): { n: bigint; scale: number } | undefined {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(v).trim());
  if (!m || (!m[2] && !m[3])) return undefined;
  const fraction = m[3] ?? "";
  return { n: BigInt(`${m[1] === "-" ? "-" : ""}${m[2] || "0"}${fraction}`), scale: fraction.length };
}

/** Whether an actual value fits what was expected. */
export function valueMatches(m: ValueMatcher, actual: JsonValue): boolean {
  if (isAsymmetric(m)) return m.asymmetricMatch(actual);
  if (m instanceof RegExp) {
    m.lastIndex = 0;
    return actual !== null && m.test(String(actual));
  }
  if (typeof m === "function") return Boolean((m as (v: JsonValue) => boolean)(actual));
  if (m instanceof Date) {
    if (actual === null || typeof actual === "boolean") return false;
    return timeOf(String(actual)) === m.getTime();
  }
  if (m === null) return actual === null;
  switch (typeof m) {
    case "bigint":
      return actual !== null && typeof actual !== "boolean" && exactDecimal(actual) === exactDecimal(m.toString());
    case "number":
      // big decimals and integers are read as text so they stay exact
      return actual === m || (typeof actual === "string" && exactDecimal(actual) === m);
    case "string":
      return actual === m || (typeof actual === "number" && /^-?(\d+\.?\d*|\.\d+)$/.test(m.trim()) && exactDecimal(m) === actual);
    case "boolean":
      // BIT / NUMBER(1) / TINYINT(1) columns hold 1 and 0; MySQL's BIT(1) is read as bytes (0x01), PostgreSQL's bit(1) as "1"
      return actual === m || (m ? [1, "1", "0x01"] : [0, "0", "0x00"]).includes(actual as never);
  }
  return false;
}

/**
 * The moment a database's date or time text stands for. Text without a time zone is read as UTC
 * (as SQL Server's values are), not in this machine's zone: the same test passes on every machine.
 */
function timeOf(text: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(text.trim());
  if (!m) return Date.parse(text);
  const [, date, time, zone] = m;
  if (!time) return Date.parse(`${date}T00:00:00Z`);
  const z = !zone ? "Z" : /^z$/i.test(zone) ? "Z" : zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return Date.parse(`${date}T${time}${z}`);
}

function isAsymmetric(m: unknown): m is Asymmetric {
  return typeof m === "object" && m !== null && typeof (m as Asymmetric).asymmetricMatch === "function";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

const MAX_TEXT = 80;

export function describeValue(v: JsonValue): string {
  if (typeof v !== "string") return String(v);
  const s = JSON.stringify(v);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 2)}…"` : s;
}

/** `expected "x", got "y"`: two long texts are shown from a little before where they differ, so the difference is seen. */
function describeMismatch(m: ValueMatcher, actual: JsonValue, column: string): string {
  if (typeof m === "string" && typeof actual === "string" && Math.max(m.length, actual.length) > MAX_TEXT - 10) {
    let i = 0;
    while (i < m.length && m[i] === actual[i]) i++;
    const from = Math.max(0, i - 20);
    const part = (s: string) => {
      const shown = JSON.stringify(s.slice(from, from + MAX_TEXT - 20)).slice(1, -1);
      return `"${from > 0 ? "…" : ""}${shown}${from + MAX_TEXT - 20 < s.length ? "…" : ""}"`;
    };
    return `expected ${part(m)}, got ${part(actual)} (they differ from character ${i + 1})`;
  }
  return `expected ${describeMatcher(m, column)}, got ${describeValue(actual)}`;
}

function describeMatcher(m: ValueMatcher | ChangeBy, column?: string): string {
  if (m instanceof ChangeBy) return `a change by ${/^[+-]/.test(m.by) ? m.by : `+${m.by}`}`;
  if (isAsymmetric(m)) {
    const a = m as { toAsymmetricMatcher?: () => string; toString(): string };
    return typeof a.toAsymmetricMatcher === "function" ? a.toAsymmetricMatcher() : String(a);
  }
  if (m instanceof RegExp) return String(m);
  // an arrow function written in the pattern is named after its column: that name says nothing
  if (typeof m === "function") return `a value ${m.name && m.name !== column ? `${m.name}() accepts` : "the function accepts"}`;
  if (m instanceof Date) return m.toISOString();
  if (typeof m === "bigint") return `${m}n`;
  return describeValue(m as JsonValue);
}

const describeColumns = (row: Record<string, unknown>, value: (v: never, column: string) => string) =>
  `{ ${Object.entries(row)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${value(v as never, k)}`)
    .join(", ")} }`;

const describePattern = (p: RowPattern) => describeColumns(p as Columns, describeMatcher);
/** An update's set; `…` when other columns may change too. */
const describeSet = (set: RowPattern) => {
  const text = describePattern(set);
  if (!(OTHER_COLUMNS in set)) return text;
  return text === "{  }" ? "{ … }" : text.replace(/ }$/, ", … }");
};
const describeUpdatePattern = (p: UpdatePattern) => `{ where: ${describePattern(p.where)}, set: ${describeSet(p.set)} }`;
export const describeRow = (r: Row) => describeColumns(r, (v: JsonValue) => describeValue(v));

function keyText(t: { key: string[] }, row: Row): string {
  if (t.key.length === 0) return describeRow(row);
  return t.key.map((k) => `${k}=${describeValue(row[k] ?? null)}`).join(", ");
}

/** One changed row: `+ { ...row }`, `~ id=3  qty: 50 → 40`, `- { ...row }`. */
function describeChange(t: { key: string[] }, kind: Kind, r: Row | UpdatedRow): string {
  if (kind === "updated") {
    const u = r as UpdatedRow;
    return `~ ${keyText(t, u.key)}  ${u.changed.map((c) => `${c}: ${describeValue(u.before[c] ?? null)} → ${describeValue(u.after[c] ?? null)}`).join(", ")}`;
  }
  return `${kind === "inserted" ? "+" : "-"} ${describeRow(r as Row)}`;
}

/** The changed rows of a table, up to `max` per kind. */
export function describeTable(t: TableDiff, max: number): string {
  const lines: string[] = [];
  for (const kind of KINDS) {
    const list: (Row | UpdatedRow)[] = t[kind];
    for (const r of list.slice(0, max)) lines.push(describeChange(t, kind, r));
    if (list.length > max) lines.push(`… ${list.length - max} more ${kind}`);
  }
  return lines.join("\n");
}

/** Every change of a diff, for error messages. */
export function describeDiff(diff: Diff, max = 10): string {
  if (diff.tables.length === 0) return "  (no changes)";
  return diff.tables.map((t) => `  ${tableId(t.table)}\n${indent(describeTable(t, max), 4)}`).join("\n");
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}
