import { exactDecimal } from "../core/normalize.js";
import type { JsonValue } from "../core/types.js";
import type { Lang } from "../export/text.js";
import { parseActions, type StepAction } from "./actions.js";
import { ChangeBy, OTHER_COLUMNS, valueMatches, type ExpectedChanges, type RowPattern, type TableChanges, type UpdatePattern } from "../testing/match.js";

/**
 * A verification an AI chat writes for a person to carry out (`checks/<name>.verify.md`): steps as
 * `## ` headings, each with what to do and, after a line `期待する DB の変化:` (`Expected changes:`),
 * one line per expected change:
 *
 *   ## 1. 受注を登録する
 *   受注画面で得意先 C001・品目 A001・数量 3 を入れて「登録」を押す
 *
 *   期待する DB の変化:
 *   - ORDERS: 追加 1 行 (CUSTOMER_CODE=C001, STATUS=10)
 *   - STOCK: 更新 1 行 (ITEM_CODE=A001) → (QTY-=3, UPD_DATE=*)
 *   - ほかの表: 変化なし
 */
export interface VerifyFile {
  /** The `# ` heading. */
  title: string;
  /** The text before the first step. */
  intro: string;
  steps: VerifyStep[];
  /** What is wrong with the file: nothing is checked while there is any. */
  problems: FileProblem[];
  /** What is wrong with the steps' actions: only `verify --auto` and `export-tests` carry them out (a person reads them as text). */
  actionProblems: FileProblem[];
}

export interface VerifyStep {
  /** The heading, without `## `. */
  title: string;
  line: number;
  /** What to do: the step's text before its expected changes (with its actions, as written). */
  body: string;
  /** What `verify --auto` does, from the lines under `操作:` (`Actions:`). Absent when the step has none: a person does it. */
  actions?: StepAction[];
  /** Absent when the step lists no expected changes: what changed is shown, not checked. */
  expect?: StepExpectation;
}

export interface StepExpectation {
  /** The lines as written, without their bullets. */
  lines: string[];
  expected: ExpectedChanges;
  /** Tables not listed must not change (the default), or may change in any way (`ほかの表: 問わない`). */
  unlisted: "unchanged" | "any";
}

export interface FileProblem {
  line: number;
  message: string;
}

const TEXT = {
  en: {
    noSteps: "No steps: write each step as a heading `## 1. what to do`.",
    marker: "Write `Expected changes:` on the line before the expected changes (without it, they are not checked).",
    notBullet: "Write each expected change on a line of its own starting with `- `.",
    shape: "Write it as `TABLE: inserted 1 row (COLUMN=value, ...)`, `TABLE: updated 1 row (COLUMN=value) → (COLUMN=value, ...)`, `TABLE: deleted 1 row (...)` or `TABLE: no changes`.",
    kind: (word: string) => `"${word}" is not a kind of change: use inserted, updated or deleted (追加 / 更新 / 削除), or "no changes".`,
    others: "Write the tables not listed as `other tables: no changes` or `other tables: any`.",
    nothingAndMore: "`no changes` (for the whole step) can't be written with other lines.",
    tableBoth: (table: string) => `${table} is listed as unchanged and as changed.`,
    arrow: "Only an update has `→ (columns after the update)`.",
    count: "Write the number of rows as `1 row` (with a list of column values, at least one).",
    parens: "A list of column values is written in parentheses: `(COLUMN=value, COLUMN=value)`.",
    unclosed: "A parenthesis or quote is not closed.",
    condition: (text: string) => `"${text}" is not COLUMN=value.`,
    delta: "COLUMN+=n / COLUMN-=n (a change by an amount) is only for the columns after an update's →.",
    deltaNumber: (text: string) => `"${text}": after += or -= comes a number.`,
    ellipsis: "`...` (other columns may change too) is only for the columns after an update's →.",
    after: (text: string) => `Unexpected text after the change: "${text}".`,
  },
  ja: {
    noSteps: "手順がありません。手順ごとに「## 1. すること」の見出しを付けてください。",
    marker: "期待する変化の行の前に「期待する DB の変化:」の 1 行を書いてください(無いと照合されません)。",
    notBullet: "期待する変化は 1 行に 1 つ、「- 」で始めて書いてください。",
    shape:
      "「表名: 追加 1 行 (列=値, ...)」「表名: 更新 1 行 (列=値) → (列=値, ...)」「表名: 削除 1 行 (...)」「表名: 変化なし」のどれかの形で書いてください。",
    kind: (word: string) => `「${word}」は変化の種類ではありません。追加・更新・削除か、「変化なし」と書いてください。`,
    others: "書いていない表については「ほかの表: 変化なし」か「ほかの表: 問わない」と書いてください。",
    nothingAndMore: "手順全体の「変化なし」は、ほかの行と一緒に書けません。",
    tableBoth: (table: string) => `${table} を「変化なし」と、変化する表の両方に書いています。`,
    arrow: "「→ (更新後の列)」を書けるのは更新だけです。",
    count: "行数は「1 行」のように書いてください(列の値を書くときは 1 行以上)。",
    parens: "列の値は「(列=値, 列=値)」のように括弧で囲んで書いてください。",
    unclosed: "括弧か引用符が閉じていません。",
    condition: (text: string) => `「${text}」が「列=値」の形になっていません。`,
    delta: "「列+=数」「列-=数」(増減)を書けるのは、更新の → の後の列だけです。",
    deltaNumber: (text: string) => `「${text}」: += か -= の後には数を書いてください。`,
    ellipsis: "「...」(ほかの列も変わってよい)を書けるのは、更新の → の後の列だけです。",
    after: (text: string) => `変化の後に余分な文字があります:「${text}」`,
  },
};
type Text = (typeof TEXT)["en"];

const MARKER = /^(?:期待(?:する)?\s*(?:DB|ＤＢ)\s*の\s*変化|(?:DB|ＤＢ)\s*の\s*変化|期待|expected(?:\s+(?:db|database))?(?:\s+changes)?)\s*[:：]?$/i;
const NOTHING = /^(?:変化なし|変化しない|変更なし|no changes?|unchanged|none)$/i;
const ANY = /^(?:問わない|変化してよい|any|anything)$/i;
const OTHERS = /^(?:(?:ほか|他|その他)の(?:表|テーブル)|other tables)$/i;
const KINDS: Record<string, keyof TableChanges> = {
  追加: "inserted",
  挿入: "inserted",
  更新: "updated",
  削除: "deleted",
  insert: "inserted",
  inserted: "inserted",
  update: "updated",
  updated: "updated",
  delete: "deleted",
  deleted: "deleted",
};

/** Reads a verification file. Its problems are listed, with their lines, rather than thrown. */
export function parseVerifyFile(text: string, lang: Lang): VerifyFile {
  const t = TEXT[lang];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const file: VerifyFile = { title: "", intro: "", steps: [], problems: [], actionProblems: [] };
  const intro: string[] = [];
  let step: { title: string; line: number; body: string[]; items: { line: number; text: string }[] | undefined } | undefined;
  const steps: NonNullable<typeof step>[] = [];
  let fence: string | undefined;

  lines.forEach((raw, i) => {
    const line = i + 1;
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined;
      if (step && !step.items) step.body.push(raw);
      else if (!step) intro.push(raw);
      return;
    }
    if (fenceMark && !step?.items) {
      fence = fenceMark;
      return void (step ? step.body : intro).push(raw);
    }
    const h1 = /^#\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h1 && !step && !file.title) return void (file.title = h1[1]!);
    const h2 = /^##\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h2) {
      step = { title: h2[1]!, line, body: [], items: undefined };
      steps.push(step);
      return;
    }
    if (!step) return void intro.push(raw);
    if (!step.items) {
      // the marker may be a heading or in bold: ### 期待する DB の変化 / **期待する DB の変化:**
      const plain = raw.trim().replace(/^#{3,}\s*/, "").replace(/^(\*\*|__)(.*)\1([:：]?)$/, "$2$3").trim();
      if (MARKER.test(plain)) step.items = [];
      else step.body.push(raw);
      return;
    }
    if (!raw.trim()) return;
    const bullet = /^\s*(?:[-*+・]|\d+[.)])\s+(.*)$/.exec(raw);
    if (!bullet) return void file.problems.push({ line, message: t.notBullet });
    step.items.push({ line, text: bullet[1]!.trim() });
  });

  file.intro = trimLines(intro);
  if (!steps.length) file.problems.push({ line: 1, message: t.noSteps });
  for (const s of steps) {
    const out: VerifyStep = { title: s.title, line: s.line, body: trimLines(s.body) };
    const acted = parseActions(s.body, s.line + 1, lang);
    file.actionProblems.push(...acted.problems);
    if (acted.actions?.length) out.actions = acted.actions;
    const actionLines = new Set(acted.actions?.map((a) => a.line));
    if (s.items) {
      const parsed = expectation(s.items, t);
      file.problems.push(...parsed.problems);
      out.expect = parsed.expect;
    } else {
      // expected changes without the line above them would never be checked
      const looksExpected = s.body.findIndex((l, i) => {
        if (actionLines.has(s.line + 1 + i)) return false;
        const item = /^\s*[-*+・]\s+(.+?)\s*[:：]\s*(.*)$/.exec(l);
        return item && (NOTHING.test(item[2]!.replace(/[。.]$/, "")) || typeof change(item[2]!, t) !== "string");
      });
      if (looksExpected >= 0) file.problems.push({ line: s.line + 1 + looksExpected, message: t.marker });
    }
    file.steps.push(out);
  }
  file.problems.sort((a, b) => a.line - b.line);
  file.actionProblems.sort((a, b) => a.line - b.line);
  return file;
}

/**
 * Expected changes written as a verification's lines (`orders: inserted 1 row (customer_id=7)`,
 * `other tables: any`), for `expectDbChanges`: the expectation, or what is wrong with the lines (line
 * numbers count from 1). The language of the messages follows the lines unless given.
 */
export function parseExpectedLines(lines: readonly string[], lang?: Lang): { expect: StepExpectation; problems: FileProblem[] } {
  const items = lines
    .map((text, i) => ({ line: i + 1, text: String(text).replace(/^\s*(?:[-*+・]|\d+[.)])\s+/, "").trim() }))
    .filter((i) => i.text);
  const t = TEXT[lang ?? (lines.some((l) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(String(l))) ? "ja" : "en")];
  return expectation(items, t);
}

const trimLines = (lines: string[]) => lines.join("\n").replace(/^\s*\n|\s+$/g, "");

function expectation(items: { line: number; text: string }[], t: Text): { expect: StepExpectation; problems: FileProblem[] } {
  const problems: FileProblem[] = [];
  const expect: StepExpectation = { lines: items.map((i) => i.text), expected: {}, unlisted: "unchanged" };
  // patterns and counts by table (the spelling first written) and kind
  const tables = new Map<string, { name: string; unchanged?: number; kinds: Partial<Record<keyof TableChanges, { patterns: unknown[]; count: number }>> }>();
  const table = (name: string) => {
    const key = name.toLowerCase();
    if (!tables.has(key)) tables.set(key, { name, kinds: {} });
    return tables.get(key)!;
  };
  let nothing = false;

  for (const { line, text } of items) {
    const problem = (message: string) => problems.push({ line, message });
    const plain = text.replace(/[。.]$/, "").trim();
    if (NOTHING.test(plain)) {
      nothing = true;
      continue;
    }
    const colon = /^(.+?)\s*[:：]\s*(.*)$/.exec(plain);
    if (!colon) {
      problem(t.shape);
      continue;
    }
    const name = unquote(colon[1]!);
    const rest = colon[2]!;
    if (OTHERS.test(name)) {
      if (NOTHING.test(rest)) expect.unlisted = "unchanged";
      else if (ANY.test(rest)) expect.unlisted = "any";
      else problem(t.others);
      continue;
    }
    if (NOTHING.test(rest)) {
      table(name).unchanged ??= line;
      continue;
    }
    const parsed = change(rest, t);
    if (typeof parsed === "string") {
      problem(parsed);
      continue;
    }
    const entry = (table(name).kinds[parsed.kind] ??= { patterns: [], count: 0 });
    if (parsed.pattern) for (let n = 0; n < parsed.count; n++) entry.patterns.push(parsed.pattern);
    else entry.count += parsed.count;
  }

  if (nothing && items.length > 1) problems.push({ line: items[0]!.line, message: t.nothingAndMore });
  for (const { name, unchanged, kinds } of tables.values()) {
    if (unchanged !== undefined && Object.keys(kinds).length) problems.push({ line: unchanged, message: t.tableBoth(name) });
    const changes: Record<string, unknown> = {};
    for (const [kind, { patterns, count }] of Object.entries(kinds)) {
      if (!patterns.length) changes[kind] = count;
      else {
        // rows only counted fit any pattern: any row, or any update
        const any = kind === "updated" ? { where: {}, set: { [OTHER_COLUMNS]: true } } : {};
        changes[kind] = [...patterns, ...Array.from({ length: count }, () => any)];
      }
    }
    expect.expected[name] = changes as TableChanges;
  }
  return { expect, problems };
}

type Change = { kind: keyof TableChanges; count: number; pattern?: RowPattern | UpdatePattern };

/** `追加 1 行 (A=1)`, `更新 2 行 (A=1) → (B=2, ...)`, `削除 (A=1)`. */
function change(text: string, t: Text): Change | string {
  const m = /^(\p{L}+)\s*(?:([\d０-９]+)\s*(?:行|件|rows?)(?![\p{L}\p{N}]))?\s*(.*)$/iu.exec(text);
  if (!m) return t.shape;
  const kind = KINDS[m[1]!.toLowerCase()];
  if (!kind) return t.kind(m[1]!);
  let rest = m[3]!;
  // full-width digits (１ 行) are digits too
  const count = m[2] === undefined ? undefined : Number(m[2].replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10)));

  let where: Conditions | undefined;
  if (/^[(（]/.test(rest)) {
    const g = group(rest, t, kind === "updated" ? "where" : "row");
    if (typeof g === "string") return g;
    where = g.conditions;
    rest = g.rest;
  }
  let set: Conditions | undefined;
  const arrow = /^(?:→|->|=>|⇒)\s*/.exec(rest);
  if (arrow) {
    if (kind !== "updated") return t.arrow;
    rest = rest.slice(arrow[0].length);
    if (!/^[(（]/.test(rest)) return t.parens;
    const g = group(rest, t, "set");
    if (typeof g === "string") return g;
    set = g.conditions;
    rest = g.rest;
  }
  if (rest.trim()) return /^[^(（]*=/.test(rest) ? t.parens : t.after(rest.trim());
  if (count === undefined && !where && !set) return t.count;
  if (count === 0 && (where || set)) return t.count;

  if (kind !== "updated") return { kind, count: count ?? 1, ...(where ? { pattern: where.values } : {}) };
  if (!where && !set) return { kind, count: count ?? 1 };
  const setValues: Record<string | symbol, unknown> = set ? { ...set.values } : {};
  // without → (...), or with ... in it, other columns may change
  if (!set || set.others) setValues[OTHER_COLUMNS] = true;
  return { kind, count: count ?? 1, pattern: { where: where?.values ?? {}, set: setValues } };
}

interface Conditions {
  values: Record<string, unknown>;
  /** `...` was written: other columns may change. */
  others: boolean;
}

/** `(A=1, B='x, y', C+=2, ...)` and what follows it. */
function group(text: string, t: Text, where: "row" | "where" | "set"): { conditions: Conditions; rest: string } | string {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  let i = 1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      current += c;
      if (c === quote) {
        if (text[i + 1] === quote) current += text[++i];
        else quote = undefined;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "," || c === "、" || c === "，") {
      parts.push(current);
      current = "";
    } else if (c === ")" || c === "）") break;
    else current += c;
  }
  if (quote || i >= text.length) return t.unclosed;
  parts.push(current);
  const conditions: Conditions = { values: {}, others: false };
  for (const part of parts.map((p) => p.trim())) {
    if (!part) continue;
    if (/^(?:\.{3}|…)$/.test(part)) {
      if (where !== "set") return t.ellipsis;
      conditions.others = true;
      continue;
    }
    const c = /^(.+?)\s*([+\-＋－]?[=＝])\s*(.*)$/.exec(part);
    if (!c || !c[1]!.trim()) return t.condition(part);
    const column = unquote(c[1]!);
    const op = c[2]!.replace("＋", "+").replace("－", "-").replace("＝", "=");
    if (op !== "=") {
      if (where !== "set") return t.delta;
      const n = c[3]!.trim();
      if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(n)) return t.deltaNumber(part);
      conditions.values[column] = new ChangeBy(`${op === "-=" ? "-" : ""}${n}`);
      continue;
    }
    conditions.values[column] = expectedValue(c[3]!.trim());
  }
  return { conditions, rest: text.slice(i + 1).trim() };
}

/** `[dbo].[ORDERS]`, `"ORDERS"`, `` `ORDERS` `` → dbo.ORDERS, ORDERS. */
const unquote = (name: string) => name.trim().replace(/[[\]"`]/g, "");

/**
 * A value as written: `NULL`, `*` (any value), `'text'` or text. Compared as a person reads it:
 * 10 and 10.00 are equal, 0001 and 1 are not, 1 is true for a bit column, trailing spaces (CHAR
 * columns) don't count, and a date (2026-10-13) fits any time of that day.
 */
export function expectedValue(written: string) {
  const quoted = /^'(.*)'$/s.exec(written) ?? /^"(.*)"$/s.exec(written);
  const text = quoted ? quoted[1]!.replace(quoted[0][0] === "'" ? /''/g : /""/g, quoted[0][0]!) : written;
  const special = quoted ? undefined : /^null$/i.test(written) ? "null" : written === "*" ? "any" : undefined;
  return {
    asymmetricMatch: (actual: JsonValue) => (special === "any" ? true : special === "null" ? actual === null : sameValue(text, actual)),
    toAsymmetricMatcher: () => written,
  };
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function sameValue(text: string, actual: JsonValue): boolean {
  if (actual === null) return false;
  if (typeof actual === "boolean") return /^(?:1|true)$/i.test(text) ? actual : /^(?:0|false)$/i.test(text) ? !actual : false;
  if (typeof actual === "number") return NUMBER.test(text.trim()) && exactDecimal(text) === actual;
  const a = actual.replace(/\s+$/, "");
  const e = text.replace(/\s+$/, "");
  if (a === e) return true;
  if (NUMBER.test(e) && NUMBER.test(a)) return exactDecimal(a) === exactDecimal(e);
  const date = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/.exec(e);
  if (!date) return false;
  const day = `${date[1]}-${date[2]!.padStart(2, "0")}-${date[3]!.padStart(2, "0")}`;
  if (!date[4]) return new RegExp(`^${day}(?:$|[T ])`).test(a);
  // a time without a time zone, as the database gives it (see valueMatches)
  return valueMatches(new Date(`${day}T${date[4].replace(/^(\d):/, "0$1:")}Z`), actual);
}
