import type { DbAdapter } from "../adapters/types.js";
import { diffSnapshots, tableId } from "../core/diff.js";
import { formatStep } from "../core/format.js";
import { TableReader, type ReaderOptions } from "../core/reader.js";
import type { Diff, Row, Snapshot, Step, TableDiff, TableRef } from "../core/types.js";
import { localTime, zoneOf, type Lang } from "../export/text.js";
import { matchChanges, tableProblems } from "../testing/match.js";
import { watchedIn } from "../testing/watch.js";
import { codeFence, DIALECT_NAMES, markdownCell } from "./markdown.js";
import type { FileProblem, StepExpectation, VerifyFile, VerifyStep } from "./verifyFile.js";

export type Verdict = "ok" | "ng" | "unchecked" | "skipped" | "not-run" | "error";

export interface StepOutcome {
  step: VerifyStep;
  verdict: Verdict;
  /** What the person typed (what they saw on the screen). */
  memo?: string;
  /** What changed from just before the step to the check. */
  diff?: Diff;
  /** How the changes differ from the expected ones (NG). */
  problems?: string[];
  /** How many times it was checked (the person can check again after NG). */
  checks?: number;
  /** When it was checked, and how long the check took. */
  at?: string;
  ms?: number;
  /** The database's error (the step and the ones after it were not checked). */
  error?: string;
}

export interface VerifyRun {
  startedAt: string;
  /** The tables watched. */
  tables: TableRef[];
  /** Watched tables too large or unreadable to compare, with why. */
  notCompared: { table: TableRef; reason: string }[];
  outcomes: StepOutcome[];
  /** Why nothing was run (the file names tables the database doesn't have). */
  problems?: string[];
}

export interface VerifyOptions extends ReaderOptions {
  lang: Lang;
  ignoreColumns?: string[];
  /** How long the changes are waited for after Enter, when they don't match yet. Default 3000ms. */
  timeout?: number;
  /** How long matching changes must stay as they are. Default 300ms. */
  settleMs?: number;
  pollMs?: number;
  /** Shows `prompt` and resolves to the line typed, or null when input has ended. */
  ask(prompt: string): Promise<string | null>;
  log(text: string): void;
  /** The step was checked (or skipped). */
  onStep?(outcome: StepOutcome, index: number): void;
}

const TEXT = {
  en: {
    ready: (n: number, ms: number) => `Watching ${n} table(s) (read in ${ms} ms).`,
    notCompared: (n: number) => `${n} table(s) can't be compared (too large or unreadable): their changes are not checked.`,
    step: (i: number, n: number, title: string) => `── Step ${i}/${n}: ${title}`,
    expected: "Expected changes:",
    noCheck: "(Changes are recorded, not checked.)",
    prompt: "When you're done, press Enter (type a note first if you like; s: skip this step, q: stop) > ",
    again: "r: check again, Enter: next step, q: stop (type a note first if you like) > ",
    checking: "Checking…",
    ok: "✓ OK",
    ng: "✗ NG: the changes differ from the expected ones:",
    unchecked: "Recorded (not checked).",
    skipped: "Skipped.",
  },
  ja: {
    ready: (n: number, ms: number) => `${n} 個の表を見張ります(${ms} ms で読み取り)。`,
    notCompared: (n: number) => `${n} 個の表は比べられません(大きすぎるか読めない)。その変化は照合しません。`,
    step: (i: number, n: number, title: string) => `── 手順 ${i}/${n}: ${title}`,
    expected: "期待する DB の変化:",
    noCheck: "(この手順は照合しません。変化だけ記録します)",
    prompt: "操作が終わったら Enter(メモがあれば入力してから Enter。s: この手順を飛ばす / q: 終わる) > ",
    again: "r: もう一度照合する / Enter: 次の手順へ / q: 終わる(メモがあれば入力してから) > ",
    checking: "照合しています…",
    ok: "✓ OK",
    ng: "✗ NG: 期待と違います",
    unchecked: "記録しました(照合なし)。",
    skipped: "飛ばしました。",
  },
};

const SKIP = /^(?:s|skip|スキップ|飛ばす)$/i;
const QUIT = /^(?:q|quit|exit|終了|終わる)$/i;
const AGAIN = /^(?:r|retry|再照合|もう一度)$/i;

/**
 * Takes the person through the steps: before each one the tables are read, the person does what it
 * says and presses Enter, and the changes since are compared with the expected ones. Changes that
 * don't match yet are waited for (`timeout`), and after NG the person can check again.
 */
export async function runVerify(db: DbAdapter, file: VerifyFile, options: VerifyOptions): Promise<VerifyRun> {
  const t = TEXT[options.lang];
  const o = { timeout: 3000, settleMs: 300, pollMs: 100, ...options };
  const startedAt = new Date().toISOString();
  const reader = new TableReader(db, options);
  const started = performance.now();
  let last = await reader.start();
  const run: VerifyRun = { startedAt, tables: reader.tables, notCompared: notCompared(last), outcomes: [] };

  // a table the file names that isn't there is a slip of the AI: say so before anyone starts
  const watched = watchedIn(last, last);
  const problems = [...new Set(file.steps.flatMap((s) => (s.expect ? tableProblems(s.expect.expected, watched, true) : [])))];
  if (problems.length) return { ...run, problems };

  o.log(t.ready(run.tables.length, Math.round(performance.now() - started)));
  if (run.notCompared.length) o.log(t.notCompared(run.notCompared.length));
  if (file.intro) o.log(`\n${file.intro}`);

  let quit = false;
  for (const [i, step] of file.steps.entries()) {
    const done = (outcome: StepOutcome) => {
      run.outcomes.push(outcome);
      o.onStep?.(outcome, i);
    };
    if (quit) {
      done({ step, verdict: "not-run" });
      continue;
    }
    let baseline: Snapshot;
    try {
      // just before the person acts, so their earlier steps don't count
      baseline = (await reader.read(last)).snapshot;
    } catch (e) {
      done({ step, verdict: "error", error: (e as Error).message });
      quit = true;
      continue;
    }
    last = baseline;
    o.log(`\n${t.step(i + 1, file.steps.length, step.title)}`);
    if (step.body) o.log(step.body);
    o.log(step.expect ? `\n${t.expected}\n${step.expect.lines.map((l) => `  - ${l}`).join("\n")}` : `\n${t.noCheck}`);

    const answer = await o.ask(t.prompt);
    if (answer === null || QUIT.test(answer.trim())) {
      quit = true;
      done({ step, verdict: "not-run" });
      continue;
    }
    if (SKIP.test(answer.trim())) {
      o.log(t.skipped);
      done({ step, verdict: "skipped" });
      continue;
    }
    const memos = answer.trim() ? [answer.trim()] : [];
    let outcome: StepOutcome;
    let checks = 0;
    for (;;) {
      o.log(t.checking);
      const checkStarted = performance.now();
      try {
        const result = await check(reader, baseline, step.expect, o);
        last = result.snapshot;
        checks++;
        outcome = {
          step,
          verdict: !step.expect ? "unchecked" : result.problems ? "ng" : "ok",
          diff: result.diff,
          ...(result.problems ? { problems: result.problems } : {}),
          checks,
          at: result.snapshot.takenAt,
          ms: Math.round(performance.now() - checkStarted),
        };
      } catch (e) {
        outcome = { step, verdict: "error", error: (e as Error).message };
        quit = true;
        break;
      }
      o.log(formatStep(stepOf(outcome, i)!, 5, false));
      if (outcome.verdict !== "ng") {
        o.log(outcome.verdict === "ok" ? t.ok : t.unchecked);
        break;
      }
      o.log(`${t.ng}\n${outcome.problems!.map((p) => indent(p, 2)).join("\n")}`);
      const next = await o.ask(t.again);
      if (next !== null && AGAIN.test(next.trim())) continue;
      if (next === null || QUIT.test(next.trim())) quit = true;
      else if (next.trim()) memos.push(next.trim());
      break;
    }
    if (memos.length) outcome.memo = memos.join(" / ");
    done(outcome);
  }
  return run;
}

/** A checked step as a step of a session (for the terminal, and to save for `ashiato export` / `show`). */
export function stepOf(o: StepOutcome, index: number, label = o.step.title): Step | undefined {
  if (!o.diff) return undefined;
  return { id: index + 1, label, at: o.at!, source: "verify", diff: o.diff, durationMs: o.ms ?? 0 };
}

/** Reads until the changes since `baseline` match and settle, or until the timeout (then NG). */
async function check(
  reader: TableReader,
  baseline: Snapshot,
  expect: StepExpectation | undefined,
  o: { timeout: number; settleMs: number; pollMs: number; ignoreColumns?: string[] },
): Promise<{ snapshot: Snapshot; diff: Diff; problems?: string[] }> {
  const deadline = Date.now() + o.timeout;
  const reset = new Set<string>();
  let settled: { since: number; text: string } | undefined;
  for (;;) {
    const read = await reader.read(baseline, reset);
    for (const id of read.reset) reset.add(id);
    const diff = diffSnapshots(baseline, read.snapshot, { ignoreColumns: o.ignoreColumns });
    const result = expect ? matchChanges(diff, expect.expected, watchedIn(baseline, read.snapshot), { unlisted: expect.unlisted }) : undefined;
    const now = Date.now();
    if (!result || result.ok) {
      const text = JSON.stringify(diff.tables);
      if (settled?.text !== text) settled = { since: now, text };
      if (now - settled.since >= o.settleMs || now >= deadline) return { snapshot: read.snapshot, diff };
      await sleep(Math.max(o.pollMs, settled.since + o.settleMs - now));
      continue;
    }
    settled = undefined;
    if (now >= deadline) return { snapshot: read.snapshot, diff, problems: result.problems };
    await sleep(o.pollMs);
  }
}

function notCompared(snapshot: Snapshot): { table: TableRef; reason: string }[] {
  return watchedIn(snapshot, snapshot)
    .filter((w) => w.skipped)
    .map((w) => ({ table: w.table, reason: w.skipped! }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const indent = (text: string, n: number) =>
  text
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

const REPORT = {
  en: {
    title: (name: string) => `# Verification results: ${name}`,
    intro: (file: string, db: string, at: string, tables: number) =>
      `A person carried out the steps of \`${file}\`, and \`ashiato verify\` compared what changed in ${db} with what they expect (${at}). Tables watched: ${tables}.`,
    notCompared: (list: string) => `Not compared (too large or unreadable): ${list}.`,
    tally: (counts: string) => `Result: ${counts}`,
    head: ["Step", "Result", "Note"],
    verdict: { ok: "OK", ng: "NG", unchecked: "not checked", skipped: "skipped", "not-run": "not done", error: "error" } as Record<Verdict, string>,
    memo: (text: string) => `Note from the person: ${text}`,
    expected: "Expected changes:",
    noCheck: "No expected changes were written: the changes are shown, not checked.",
    differences: (checks: number) => `How the changes differ${checks > 1 ? ` (checked ${checks} times)` : ""}:`,
    actual: "What changed:",
    nothing: "(no changes)",
    error: (message: string) => `**Error**: ${message}`,
    inserted: (n: number) => `inserted ${n} row${n === 1 ? "" : "s"}`,
    updated: (n: number) => `updated ${n} row${n === 1 ? "" : "s"}`,
    deleted: (n: number) => `deleted ${n} row${n === 1 ? "" : "s"}`,
    changed: "Changed columns",
    more: (n: number) => `… ${n} more`,
    notStartedTitle: (name: string) => `# Verification results: ${name} (not started)`,
    notStarted: (file: string) => `\`ashiato verify\` didn't start, because of what \`${file}\` says. Correct the file:`,
    line: (line: number) => `Line ${line}`,
  },
  ja: {
    title: (name: string) => `# 動作検証の結果: ${name}`,
    intro: (file: string, db: string, at: string, tables: number) =>
      `\`${file}\` の手順を人が操作し、${db} の変化を \`ashiato verify\` が期待と照合した結果です(${at})。見張った表: ${tables} 個。`,
    notCompared: (list: string) => `比べられなかった表(大きすぎるか読めない): ${list}`,
    tally: (counts: string) => `結果: ${counts}`,
    head: ["手順", "判定", "メモ"],
    verdict: { ok: "OK", ng: "NG", unchecked: "照合なし", skipped: "飛ばした", "not-run": "未実施", error: "エラー" } as Record<Verdict, string>,
    memo: (text: string) => `操作した人のメモ: ${text}`,
    expected: "期待する DB の変化:",
    noCheck: "期待する変化が書かれていないため、照合せずに変化だけを載せています。",
    differences: (checks: number) => `期待との違い${checks > 1 ? `(${checks} 回照合)` : ""}:`,
    actual: "実際の変化:",
    nothing: "(変化なし)",
    error: (message: string) => `**エラー**: ${message}`,
    inserted: (n: number) => `追加 ${n} 行`,
    updated: (n: number) => `更新 ${n} 行`,
    deleted: (n: number) => `削除 ${n} 行`,
    changed: "変わった列",
    more: (n: number) => `…ほか ${n} 行`,
    notStartedTitle: (name: string) => `# 動作検証の結果: ${name}(始めていません)`,
    notStarted: (file: string) => `\`${file}\` の内容に次の問題があるため、\`ashiato verify\` は始めていません。ファイルを直してください。`,
    line: (line: number) => `${line} 行目`,
  },
};

/** OK, NG, 照合なし... */
export const verdictText = (verdict: Verdict, lang: Lang) => REPORT[lang].verdict[verdict];

export interface ReportOptions {
  /** The file as the report names it (a relative path). */
  fileName: string;
  dialect: string;
  lang: Lang;
  /** Rows shown per table and kind of change. Default 20. */
  maxRows?: number;
}

/** The results as Markdown, to paste into the chat: a table of the steps, then each step's expected and actual changes. */
export function verifyReport(file: VerifyFile, run: VerifyRun, options: ReportOptions): string {
  const t = REPORT[options.lang];
  const maxRows = options.maxRows ?? 20;
  const at = new Date(run.startedAt);
  const out = [
    t.title(file.title || options.fileName),
    "",
    t.intro(options.fileName, DIALECT_NAMES[options.dialect] ?? options.dialect, `${localTime(run.startedAt)} ${zoneOf(at)}`, run.tables.length),
  ];
  if (run.notCompared.length) {
    const names = run.notCompared.map((n) => tableId(n.table));
    out.push("", t.notCompared(names.length > 20 ? `${names.slice(0, 20).join(", ")}, …(${names.length})` : names.join(", ")));
  }
  const counts = (Object.keys(t.verdict) as Verdict[])
    .map((v) => [v, run.outcomes.filter((o) => o.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${t.verdict[v]} ${n}`);
  out.push("", t.tally(counts.join(" / ")), "", `| ${t.head.join(" | ")} |`, "| --- | --- | --- |");
  for (const o of run.outcomes) out.push(`| ${markdownCell(o.step.title)} | ${t.verdict[o.verdict]} | ${o.memo ? markdownCell(o.memo) : ""} |`);

  for (const o of run.outcomes) {
    out.push("", `## ${o.step.title} — ${t.verdict[o.verdict]}`, "");
    if (o.memo) out.push(t.memo(o.memo), "");
    if (o.step.expect) out.push(t.expected, ...o.step.expect.lines.map((l) => `- ${l}`), "");
    else out.push(t.noCheck, "");
    if (o.error !== undefined) out.push(t.error(o.error), "");
    if (o.problems) out.push(t.differences(o.checks ?? 1), "", codeFence(o.problems.join("\n"), "text"), "");
    if (o.diff) out.push(t.actual, "", ...changes(o.diff, t, maxRows));
  }
  // sections end with a blank line and start with one
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
}

/** What to send back when the file can't be used: its problems, by line. */
export function fileProblemsReport(file: VerifyFile, problems: FileProblem[] | string[], options: Pick<ReportOptions, "fileName" | "lang">): string {
  const t = REPORT[options.lang];
  const out = [t.notStartedTitle(file.title || options.fileName), "", t.notStarted(options.fileName), ""];
  for (const p of problems) out.push(typeof p === "string" ? `- ${p.replace(/\n/g, " ")}` : `- ${t.line(p.line)}: ${p.message}`);
  return `${out.join("\n")}\n`;
}

function changes(diff: Diff, t: (typeof REPORT)["en"], maxRows: number): string[] {
  if (!diff.tables.length) return [t.nothing, ""];
  const out: string[] = [];
  for (const d of diff.tables) {
    const name = `**${tableId(d.table)}**`;
    if (d.inserted.length) out.push(`${name} ${t.inserted(d.inserted.length)}`, "", ...rowsTable(d.inserted, maxRows, t), "");
    if (d.updated.length) out.push(`${name} ${t.updated(d.updated.length)}`, "", ...updatesTable(d, maxRows, t), "");
    if (d.deleted.length) out.push(`${name} ${t.deleted(d.deleted.length)}`, "", ...rowsTable(d.deleted, maxRows, t), "");
  }
  return out;
}

function rowsTable(rows: Row[], maxRows: number, t: (typeof REPORT)["en"]): string[] {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [`| ${columns.map((c) => markdownCell(c)).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
  for (const r of rows.slice(0, maxRows)) lines.push(`| ${columns.map((c) => markdownCell(r[c] ?? null)).join(" | ")} |`);
  if (rows.length > maxRows) lines.push("", t.more(rows.length - maxRows));
  return lines;
}

function updatesTable(d: TableDiff, maxRows: number, t: (typeof REPORT)["en"]): string[] {
  const head = [...d.key, t.changed];
  const lines = [`| ${head.map((c) => markdownCell(c)).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const u of d.updated.slice(0, maxRows)) {
    const changed = u.changed.map((c) => `${markdownCell(c)}: ${markdownCell(u.before[c] ?? null)} → ${markdownCell(u.after[c] ?? null)}`).join("<br>");
    lines.push(`| ${[...d.key.map((k) => markdownCell(u.key[k] ?? null)), changed].join(" | ")} |`);
  }
  if (d.updated.length > maxRows) lines.push("", t.more(d.updated.length - maxRows));
  return lines;
}
