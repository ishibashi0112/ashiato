/**
 * Steps as text for AI agents (and `ashiato steps`). Without values, an agent learns which tables,
 * columns and how many rows changed, but none of the rows' values, nor anything else that may hold
 * them: URL queries, the text of what was clicked (a cell, a link) and the app's and database's error messages.
 */
import { countChanges, tableId } from "../core/diff.js";
import type { ActionInfo, Diff, JsonValue, RequestInfo, Row, Step, TableDiff } from "../core/types.js";

export interface TextOptions {
  /** Show the rows' values (default: only tables, columns and counts). */
  values?: boolean;
  /** Rows shown of each kind (inserted, updated, deleted) per table. Default 20. */
  maxRows?: number;
}

const json = (v: JsonValue | Row | undefined) => JSON.stringify(v ?? null);
/** A URL's query can carry values (`?name=...`): left out with them. */
const withoutQuery = (url: string) => url.replace(/[?#].*$/s, (q) => (q.length > 1 ? "?…" : ""));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * `button "Save"` stays when the browser marked its text as the app's own wording (a button's caption,
 * a field's label); a link, a cell, an option, a row made clickable can show data, so only its kind is kept.
 */
const targetShape = (target: string, caption: boolean | undefined) => (caption ? target : target.split('"')[0]!.trim() || undefined);

/** The action without what may hold values: the page's query, the clicked text, error messages. */
function actionShape(a: ActionInfo): ActionInfo {
  const { target, ...rest } = a;
  const shown = target && targetShape(target, a.caption);
  return {
    ...rest,
    ...(shown ? { target: shown } : {}),
    ...(a.page ? { page: withoutQuery(a.page) } : {}),
    requests: a.requests.map(requestShape),
  };
}

const requestShape = (r: RequestInfo): RequestInfo => ({ ...r, ...(r.url ? { url: withoutQuery(r.url) } : {}), ...(r.error ? { error: "(message not shown)" } : {}) });

/** The step's label, rebuilt from its action when the label came from the page. */
export function labelShape(step: Step): string {
  const a = step.action;
  if (!a) return step.label;
  // a request on its own is labelled with its URL (or WebView2 method)
  if (a.type === "request") return withoutQuery(step.label);
  const target = a.target && targetShape(a.target, a.caption);
  return target ? `${a.type} ${target}` : a.type;
}

/** A database's error message can quote a row's value ("Conversion failed when converting the varchar value 'A12'"). */
const reasonShape = (reason: string) => (reason.startsWith("could not be read") ? "could not be read (the database's message is not shown)" : reason);

/** One line: `#3 click button "Save" (POST /api/orders): orders +1 ~1, stock ~1`. */
export function stepLine(step: Step, options: Pick<TextOptions, "values"> = { values: true }): string {
  const via = step.source && !["manual", "http", "ui", "mcp", "cli"].includes(step.source) && step.source !== step.label ? ` (${step.source})` : "";
  const tables = step.diff.tables.map((t) => {
    const c = countChanges({ ...step.diff, tables: [t] });
    return `${tableId(t.table)} ${[c.inserted && `+${c.inserted}`, c.updated && `~${c.updated}`, c.deleted && `-${c.deleted}`].filter(Boolean).join(" ")}`;
  });
  const notes = [
    ...(step.addedTables ?? []).map((t) => `new table ${tableId(t)}`),
    ...(step.removedTables ?? []).map((t) => `table ${tableId(t)} gone`),
    ...(step.skipped?.length ? [`${plural(step.skipped.length, "table")} not compared`] : []),
  ];
  const label = options.values ? step.label : labelShape(step);
  return `#${step.id} ${label}${via}: ${[tables.length ? tables.join(", ") : "no changes", ...notes].join("; ")}`;
}

/** Everything about one step: when, what the user did, what the page sent, and what changed. */
export function stepText(step: Step, options: TextOptions = {}): string {
  const max = options.maxRows ?? 20;
  const lines = [`#${step.id} ${options.values ? step.label : labelShape(step)}`, `at: ${step.at} (checkpoint took ${step.durationMs}ms)`];
  const a = step.action && (options.values ? step.action : actionShape(step.action));
  if (a) {
    if (a.type !== "request") lines.push(`action: ${a.type}${a.target ? ` ${a.target}` : ""}${a.page ? ` on ${a.page}` : ""}, at ${a.lastAt ?? a.startedAt}`);
    const requests = a.requests.map((r) => {
      const result = r.error ? ` failed: ${r.error}` : r.status !== undefined ? ` ${r.status}` : "";
      return `${r.kind === "http" ? `${r.method} ${r.url ?? ""}` : `${r.kind === "rpc" ? "WebView2 call" : "WebView2 message"} ${r.method}`}${result}${r.durationMs !== undefined ? ` (${r.durationMs}ms)` : ""}`;
    });
    if (requests.length) lines.push(`requests: ${requests.join("; ")}`);
  } else if (step.source === "sync") {
    lines.push("changed while nothing was being done in the app");
  }
  for (const t of step.addedTables ?? []) lines.push(`new table: ${tableId(t)} (its rows show as inserted)`);
  for (const t of step.removedTables ?? []) lines.push(`table gone: ${tableId(t)} (dropped, renamed or no longer readable)`);
  for (const s of step.skipped ?? []) lines.push(`not compared: ${tableId(s.table)} (${options.values ? s.reason : reasonShape(s.reason)})`);
  if (step.diff.tables.length === 0) lines.push("changes: none");
  else lines.push("changes:", ...step.diff.tables.flatMap((t) => tableLines(t, options.values ?? false, max)));
  return lines.join("\n");
}

function tableLines(t: TableDiff, values: boolean, max: number): string[] {
  const key = t.key.length ? `key: ${t.key.join(", ")}` : "no primary key";
  const changed = [...new Set(t.updated.flatMap((u) => u.changed))];
  const counts = [plural(t.inserted.length, "row") + " inserted", `${t.updated.length} updated${changed.length ? ` (${changed.join(", ")})` : ""}`, `${t.deleted.length} deleted`];
  const lines = [`  ${tableId(t.table)} (${key}): ${counts.join(", ")}`];
  if (!values) {
    const columns = Object.keys(t.inserted[0] ?? {});
    if (columns.length) lines.push(`    inserted rows have: ${columns.join(", ")}`);
    return lines;
  }
  const more = (list: unknown[], kind: string) => (list.length > max ? [`    … ${list.length - max} more ${kind} rows`] : []);
  for (const r of t.inserted.slice(0, max)) lines.push(`    + ${json(r)}`);
  lines.push(...more(t.inserted, "inserted"));
  for (const u of t.updated.slice(0, max)) lines.push(`    ~ ${json(u.key)}: ${u.changed.map((c) => `${c} ${json(u.before[c])} → ${json(u.after[c])}`).join(", ")}`);
  lines.push(...more(t.updated, "updated"));
  for (const r of t.deleted.slice(0, max)) lines.push(`    - ${json(r)}`);
  lines.push(...more(t.deleted, "deleted"));
  return lines;
}

/** A step for JSON output without values: what changed, in counts and column names (and the action without what may hold values). */
export function stepShape(step: Step) {
  return {
    id: step.id,
    label: labelShape(step),
    at: step.at,
    ...(step.source ? { source: step.source } : {}),
    ...(step.action ? { action: actionShape(step.action) } : {}),
    tables: step.diff.tables.map((t) => ({
      table: tableId(t.table),
      key: t.key,
      inserted: t.inserted.length,
      updated: t.updated.length,
      deleted: t.deleted.length,
      changedColumns: [...new Set(t.updated.flatMap((u) => u.changed))],
    })),
    ...(step.addedTables ? { addedTables: step.addedTables.map(tableId) } : {}),
    ...(step.removedTables ? { removedTables: step.removedTables.map(tableId) } : {}),
    ...(step.skipped ? { skipped: step.skipped.map((s) => ({ table: tableId(s.table), reason: reasonShape(s.reason) })) } : {}),
  };
}

/**
 * `orders +1, stock ~1 (qty)`: what changed, in counts and the columns updated (empty when nothing
 * did). With `direction`, a number column every update raised or lowered says so: `stock ~1 (qty↓)`.
 */
export function changesLine(diff: Diff, options: { direction?: boolean } = {}): string {
  return diff.tables
    .map((t) => {
      const counts = [t.inserted.length && `+${t.inserted.length}`, t.updated.length && `~${t.updated.length}`, t.deleted.length && `-${t.deleted.length}`].filter(Boolean);
      const columns = [...new Set(t.updated.flatMap((u) => u.changed))].map((c) => (options.direction ? c + directionOf(t, c) : c));
      return `${tableId(t.table)} ${counts.join(" ")}${columns.length ? ` (${columns.join(", ")})` : ""}`;
    })
    .join(", ");
}

/** ↑ when every update of the column raised a number, ↓ when every one lowered it, else nothing. */
function directionOf(t: TableDiff, column: string): string {
  const number = (v: JsonValue | undefined) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);
  const signs = new Set(
    t.updated
      .filter((u) => u.changed.includes(column))
      .map((u) => {
        const before = number(u.before[column]);
        const after = number(u.after[column]);
        return before === undefined || after === undefined ? 0 : Math.sign(after - before);
      }),
  );
  return signs.size === 1 && signs.has(1) ? "↑" : signs.size === 1 && signs.has(-1) ? "↓" : "";
}

/**
 * How changes differ from the expected ones (`matchChanges`' problems) without the rows' values:
 * the lines that say which table and how many rows, the expected patterns (written by whoever
 * expected them) and which columns differ are kept; the rows found and their values are left out.
 */
export function problemShape(problem: string): string {
  const [first = "", ...rest] = problem.split("\n");
  const out = [first.replace(/could not be read: .*$/, "could not be read (the database's message is not shown)").replace(/:$/, "")];
  let unexpected: { at: number; n: number } | undefined;
  for (const line of rest) {
    const indent = /^\s*/.exec(line)![0];
    const text = line.slice(indent.length);
    if (unexpected && indent.length > unexpected.at) {
      unexpected.n++;
      continue;
    }
    unexpected = undefined;
    if (/^expected .*: (?:no row matches|not found|the rows it fits are taken by the other rows expected)$/.test(text)) out.push(line);
    else if (/^not expected:/.test(text)) {
      unexpected = { at: indent.length, n: 0 };
      out.push(`${indent}not expected: (rows not shown)`);
    } else {
      // `qty: expected 3, got 2`, `set qty: expected +10, got 50 → 45`, `where id: ...`, `qty also changed: 1 → 2`
      const differs = /^((?:where |set )?[^:\s][^:]*?): expected (.*?), got /.exec(text);
      const also = /^([^:\s][^:]*?) also changed: /.exec(text);
      const column = /^no column .*$/.exec(text);
      if (differs) out.push(`${indent}${differs[1]}: expected ${differs[2]}, got another value`);
      else if (also) out.push(`${indent}${also[1]} also changed`);
      else if (column) out.push(line);
      // the closest row, rows found: left out
    }
  }
  return out.join("\n");
}
