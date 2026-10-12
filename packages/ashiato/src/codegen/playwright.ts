import { tableId } from "../core/diff.js";
import type { JsonValue, Row, Session, Step, TableDiff, TableRef } from "../core/types.js";
import type { Dialog, Interaction } from "./interactions.js";

export interface PlaywrightOptions {
  /** What the user did in the browser, from the screen replay. Without it, the actions are left as TODOs. */
  interactions?: Interaction[];
  /** Shown in the header. */
  sessionFile?: string;
  /** The test's title. */
  name?: string;
}

/** Rows of a kind beyond this are only counted. */
const MAX_ROWS = 20;
/** Values of times within this of the recording are taken for "now": they will differ when the test runs. */
const NOW_MS = 36 * 3600_000;
/** An action's trigger is looked for this long around the moment the action started. */
const TRIGGER_BEFORE_MS = 100;
const TRIGGER_AFTER_MS = 1500;
/** Requests with no user action, this soon after a page load, were made by the page load. */
const PAGE_LOAD_MS = 5000;

const q = (s: string) => JSON.stringify(s);
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;
const key = (s: string) => (IDENTIFIER.test(s) ? s : q(s));

/**
 * A Playwright test that does again what was done while recording (from the screen replay) and,
 * for each step, checks with `expectDbChanges` that the same rows changed.
 */
export function playwrightTest(session: Session, options: PlaywrightOptions = {}): string {
  const interactions = options.interactions ?? [];
  const values = new Values(session);
  const firstPage = interactions.find((i) => i.kind === "goto");
  const origin = firstPage?.value ? originOf(firstPage.value) : undefined;
  const lines: string[] = [];
  const emit = (line = "") => lines.push(line ? `  ${line}` : "");

  const skippedSaid = new Set<string>();
  let cursor = 0;
  /** Plain lines for the interactions before index `end` (or, without `end`, those before time `t`). */
  const before = (t: number, end?: number) => {
    const out: Interaction[] = [];
    while (cursor < interactions.length && (end !== undefined ? cursor < end : interactions[cursor]!.t < t)) out.push(interactions[cursor++]!);
    return out;
  };
  const write = (list: Interaction[]) => {
    for (const i of list) for (const l of actionLines(i, origin)) emit(l);
  };

  for (const step of session.steps) {
    const title = `#${step.id} ${step.label}${requestsOf(step)}`;
    if (step.source === "sync") {
      emit();
      emit(`// ${title}: changed while nothing was being done in the app, so not checked here`);
      continue;
    }
    const action = step.action && step.action.type !== "request" ? step.action : undefined;
    let body: Interaction[] = [];
    let todo: string | undefined;
    if (action) {
      const started = Date.parse(action.lastAt ?? action.startedAt);
      const k = findTrigger(interactions, cursor, started, action.type, action.tab);
      if (k >= 0) {
        write(before(0, k));
        body = [interactions[cursor++]!];
      } else {
        write(before(started));
        todo = `${action.type}${action.target ? ` ${action.target}` : ""} (not found in the screen replay)`;
      }
    } else if (step.action) {
      // requests with no user action: made by a page load just before, or by the page on its own (a timer)
      const started = Date.parse(step.action.startedAt);
      const pending = before(started);
      const load = pending.at(-1);
      if (load?.kind === "goto" && !load.followed && started - load.t < PAGE_LOAD_MS) body = [pending.pop()!];
      write(pending);
      if (!body.length) todo = `nothing: the page sent ${step.label} by itself`;
    } else {
      // a checkpoint taken by hand: what was done since the previous step
      body = before(Date.parse(step.at));
      if (!body.length) todo = `what was done before the checkpoint "${step.label}"`;
    }
    if (!body.length && step.diff.tables.length === 0 && !step.action) {
      emit();
      emit(`// ${title}: no changes`);
      continue;
    }

    emit();
    emit(`// ${title}`);
    for (const t of step.addedTables ?? []) emit(`// ${tableId(t)} was created in this step`);
    for (const t of step.removedTables ?? []) emit(`// ${tableId(t)} went away in this step (dropped, renamed or no longer readable)`);
    for (const s of step.skipped ?? []) {
      // a table too large at every step is said once
      const said = `${tableId(s.table)} ${s.reason.replace(/\d+/g, "")}`;
      if (!skippedSaid.has(said)) emit(`// ${tableId(s.table)} not compared: ${s.reason}`);
      skippedSaid.add(said);
    }
    if (step.action?.requests.some((r) => r.kind !== "http")) emit("// sent to the desktop app (WebView2): run the test against the app hosting this page");
    for (const i of body) for (const d of i.dialogs ?? []) emit(dialogLine(d));
    const expected = expectation(step, values, session.tables);
    const run = body.flatMap((i) => actionLines({ ...i, dialogs: undefined }, origin));
    if (run.length === 1 && !run[0]!.startsWith("//") && !todo) {
      emit(`await expectDbChanges(() => ${run[0]!.replace(/^await /, "").replace(/;$/, "")}, ${expected});`);
    } else {
      emit("await expectDbChanges(async () => {");
      if (todo) emit(`  // TODO: ${todo}`);
      for (const l of run) emit(`  ${l}`);
      emit(`}, ${expected});`);
    }
  }
  const rest = interactions.length - cursor;
  if (rest > 0) {
    emit();
    emit(`// ${rest} more action${rest === 1 ? "" : "s"} after the last step left out`);
  }

  const recorded = localTime(session.startedAt);
  const use = useOptions(session, origin);
  const header = [
    `// Generated by ashiato from ${options.sessionFile ?? "a recording"} (${session.dialect}, ${recorded}).`,
    "// It does again what was done in the browser and checks, step by step, that the same rows change.",
    "// Before running it:",
    "// - put the database back in the state it was in when the recording started (restore a copy, or seed it again),",
    "// - set ASHIATO_DB_URL to that database (read-only access is enough),",
    "// - run tests that check the database one at a time: npx playwright test --workers=1",
    "// Values the database makes up (keys of new rows and values referring to them, times near the recording, row versions)",
    "// are matched with expect.any(): replace them with the exact value where it is always the same.",
    ...(interactions.length ? [] : ["// No screen replay was recorded (the Vite plugin records one): fill in the actions marked TODO."]),
    'import { test, expect } from "ashiato/playwright";',
    "",
    ...(use ? [`test.use(${use});`, ""] : []),
    `test(${q(options.name ?? `recorded ${recorded}`)}, async ({ page, expectDbChanges }) => {`,
  ];
  return `${[...header, ...trimStart(lines), "});"].join("\n")}\n`;
}

/** The trigger of a step's action: the user's click, Enter or change around when it started. */
function findTrigger(list: Interaction[], from: number, started: number, type: string, tab: string | undefined): number {
  const fits = (i: Interaction) => {
    switch (type) {
      case "click":
        return i.kind === "click" || i.kind === "dblclick";
      case "enter":
        return i.kind === "press";
      case "submit":
        return i.kind === "click" || i.kind === "press";
      case "change":
        return i.kind === "fill" || i.kind === "select" || i.kind === "check" || i.kind === "uncheck";
      default:
        return i.kind !== "goto";
    }
  };
  // the closest one: the page stamps the action and its replay event with the same clock
  let best = -1;
  for (let k = from; k < list.length; k++) {
    const i = list[k]!;
    if (i.t > started + TRIGGER_AFTER_MS) break;
    if (i.t < started - TRIGGER_BEFORE_MS || (tab && i.tab !== tab) || !fits(i)) continue;
    if (best < 0 || Math.abs(i.t - started) < Math.abs(list[best]!.t - started)) best = k;
  }
  return best;
}

/** The lines of code that do one interaction. */
function actionLines(i: Interaction, origin: string | undefined): string[] {
  const lines = (i.dialogs ?? []).map(dialogLine);
  if (i.kind === "goto") {
    const url = i.value ?? "";
    const target = origin && originOf(url) === origin ? url.slice(origin.length) || "/" : url;
    lines.push(i.followed ? `// the page went to ${target}` : `await page.goto(${q(target)});`);
    return lines;
  }
  const where = i.locator?.label ?? "an element";
  if (i.unsupported || !i.locator) {
    lines.push(`// TODO: ${i.kind}${i.value !== undefined ? ` ${q(i.value)}` : ""} on ${where}: ${i.unsupported ?? "not found"}`);
    return lines;
  }
  const el = `page.${i.locator.code}`;
  switch (i.kind) {
    case "click":
      lines.push(`await ${el}.click();`);
      break;
    case "dblclick":
      lines.push(`await ${el}.dblclick();`);
      break;
    case "fill":
      lines.push(i.masked ? `await ${el}.fill(""); // TODO: the value typed here was masked when recorded` : `await ${el}.fill(${q(i.value ?? "")});`);
      break;
    case "select":
      lines.push(`await ${el}.selectOption(${q(i.value ?? "")});`);
      break;
    case "check":
    case "uncheck":
      lines.push(`await ${el}.${i.kind}();`);
      break;
    case "press":
      lines.push(`await ${el}.press(${q(i.value ?? "Enter")});`);
      break;
  }
  return lines;
}

/** Answers a dialog the next action opens, as the user did (unanswered, Playwright dismisses it). */
function dialogLine(d: Dialog): string {
  if (d.type === "alert") return `page.once("dialog", (dialog) => dialog.accept()); // alert: ${short(d.message)}`;
  if (d.answer === false || d.answer === null) return `page.once("dialog", (dialog) => dialog.dismiss()); // ${d.type}: ${short(d.message)}`;
  if (d.type === "prompt" && typeof d.answer === "string") {
    if (/^\*+$/.test(d.answer)) return `page.once("dialog", (dialog) => dialog.accept("")); // TODO: the answer was masked when recorded. ${d.type}: ${short(d.message)}`;
    return `page.once("dialog", (dialog) => dialog.accept(${q(d.answer)})); // ${d.type}: ${short(d.message)}`;
  }
  return `page.once("dialog", (dialog) => dialog.accept()); // ${d.type}: ${short(d.message)}`;
}

const short = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

/** `(POST /api/orders)`: what the step's action sent. */
function requestsOf(step: Step): string {
  if (!step.source || ["manual", "http", "ui", "sync", "mcp", "cli"].includes(step.source) || step.label.includes(step.source)) return "";
  return ` (${step.source})`;
}

/** The second argument of expectDbChanges for a step: its changes, as the test should find them. */
function expectation(step: Step, values: Values, tables: TableRef[]): string {
  // keys of rows inserted in this step are made up by the database: so are values referring to them
  for (const t of step.diff.tables) for (const r of t.inserted) values.learn(t, r);
  const parts: string[] = [];
  for (const t of step.diff.tables) {
    const kinds: string[] = [];
    const list = (name: string, rows: string[], count: number) => {
      if (count === 0) return;
      if (count > MAX_ROWS) return void kinds.push(`${name}: ${count},`);
      if (rows.length === 1 && rows[0]!.length <= 100) return void kinds.push(`${name}: [${rows[0]}],`);
      kinds.push(`${name}: [`, ...rows.map((r) => `  ${r},`), "],");
    };
    const many = (n: number) => n > MAX_ROWS;
    list("inserted", many(t.inserted.length) ? [] : t.inserted.map((r) => values.row(t, r, Object.keys(r), true)), t.inserted.length);
    list(
      "updated",
      many(t.updated.length) ? [] : t.updated.map((u) => `{ where: ${values.row(t, u.key, Object.keys(u.key), false)}, set: ${values.row(t, u.after, u.changed, false)} }`),
      t.updated.length,
    );
    list("deleted", many(t.deleted.length) ? [] : t.deleted.map((r) => values.row(t, r, t.key.length ? t.key : Object.keys(r), false)), t.deleted.length);
    const name = tables.filter((x) => x.name === t.table.name).length > 1 ? tableId(t.table) : t.table.name;
    parts.push(`${key(name)}: {`, ...kinds.map((k) => `  ${k}`), "},");
  }
  if (parts.length === 0) return "{}";
  return `{\n${parts.map((p) => `    ${p}`).join("\n")}\n  }`;
}

/** Writes rows as expected values, with expect.any() for the values a test run can't reproduce. */
class Values {
  /** Values the database made up for the keys of new rows, and the tables they are keys of. */
  private readonly generated = new Map<string, Set<string>>();
  private readonly ignore: Set<string>;
  private readonly from: number;
  private readonly to: number;

  constructor(private readonly session: Session) {
    this.ignore = new Set((session.options?.ignoreColumns ?? []).map((c) => c.toLowerCase()));
    const times = [session.startedAt, ...session.steps.map((s) => s.at)].map(Date.parse).filter(Number.isFinite);
    this.from = Math.min(...times) - NOW_MS;
    this.to = Math.max(...times) + NOW_MS;
  }

  /** The key of a row inserted in a table with a one-column key, a number or a UUID, was made up by the database. */
  learn(t: TableDiff, row: Row): void {
    if (t.key.length !== 1) return;
    const v = row[t.key[0]!];
    if (typeof v === "number" || (typeof v === "string" && (/^\d+$/.test(v) || UUID.test(v)))) {
      const tables = this.generated.get(String(v)) ?? new Set();
      this.generated.set(String(v), tables.add(tableId(t.table)));
    }
  }

  row(t: TableDiff, row: Row, columns: string[], inserted: boolean): string {
    const cols = columns.filter((c) => !this.ignore.has(c.toLowerCase()));
    return `{ ${cols.map((c) => `${key(c)}: ${this.value(t, c, row[c] ?? null, inserted)}`).join(", ")} }`;
  }

  private value(t: TableDiff, column: string, v: JsonValue, inserted: boolean): string {
    if (v === null || typeof v === "boolean") return String(v);
    const any = typeof v === "number" ? "expect.any(Number)" : "expect.any(String)";
    // a random id the app made up for a new row
    if (inserted && typeof v === "string" && UUID.test(v)) return any;
    // SQL Server rowversion: a new number, counted for the whole database, on every write
    if (this.session.dialect === "mssql" && typeof v === "string" && ROWVERSION.test(v)) return any;
    if (this.isNow(v) || this.refersToNew(t, column, String(v))) return any;
    return typeof v === "string" ? q(v) : String(v);
  }

  /**
   * The value is the key of a row inserted while recording: the row's own key, or an id column
   * referring to it. `customer_id` refers to a table named like `customers`, when there is one.
   */
  private refersToNew(t: TableDiff, column: string, v: string): boolean {
    const from = this.generated.get(v);
    if (!from) return false;
    const own = t.key.length === 1 && t.key[0] === column;
    if (!own && !ID_COLUMN(column)) return false;
    const stem = column.replace(/[_\-\s]?id$/i, "").toLowerCase();
    if (own || !stem) return from.has(tableId(t.table));
    const named = this.session.tables.filter((x) => {
      const name = x.name.toLowerCase();
      return name.startsWith(stem) || stem.startsWith(name.replace(/e?s$/, ""));
    });
    return named.length ? named.some((x) => from.has(tableId(x))) : true;
  }

  private isNow(v: string | number): boolean {
    let t = NaN;
    if (typeof v === "number") {
      if (v > 1e9 && v < 1e10) t = v * 1000;
      else if (v > 1e12 && v < 1e13) t = v;
    } else {
      const m = DATE.exec(v.trim());
      // offsets as +09:00, +0900 or +09 (PostgreSQL)
      const zone = (z = "") => z.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2").replace(/^([+-]\d{2})$/, "$1:00");
      if (m) t = Date.parse(m[2] ? `${m[1]}T${m[2]}${zone(m[3])}` : `${m[1]}T12:00:00Z`);
    }
    return t >= this.from && t <= this.to;
  }
}

const ROWVERSION = /^0x[0-9a-f]{16}$/i;
const UUID = /^(?:0x)?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
/** customer_id, customerId, 受注ID */
const ID_COLUMN = (c: string) => /(^|[_\-\s])id$/i.test(c) || /[a-z]Id$/.test(c) || /ID$/.test(c);

function useOptions(session: Session, origin: string | undefined): string | undefined {
  const o = session.options ?? {};
  const ashiato = [
    ...(o.tables?.length ? [`tables: [${o.tables.map(q).join(", ")}]`] : []),
    ...(o.ignoreColumns?.length ? [`ignoreColumns: [${o.ignoreColumns.map(q).join(", ")}]`] : []),
    ...(o.maxRows !== undefined ? [`maxRows: ${o.maxRows}`] : []),
  ];
  const parts = [...(origin ? [`baseURL: ${q(origin)}`] : []), ...(ashiato.length ? [`ashiato: { ${ashiato.join(", ")} }`] : [])];
  if (!parts.length) return undefined;
  return `{\n${parts.map((p) => `  ${p},`).join("\n")}\n}`;
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.origin === "null" ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Without the blank line the first step would start with. */
function trimStart(lines: string[]): string[] {
  return lines[0] === "" ? lines.slice(1) : lines;
}
