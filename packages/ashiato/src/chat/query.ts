import type { DbAdapter, QueryResult } from "../adapters/types.js";
import type { JsonValue } from "../core/types.js";
import { localTime, zoneOf, type Lang } from "../export/text.js";
import { markdownCell, codeFence, DIALECT_NAMES } from "./markdown.js";
import { readOnlyProblem, splitStatements, type Problem, type Statement } from "./sql.js";

/** A .sql file to run: its name as shown in the report (a relative path) and its text. */
export interface SqlFile {
  name: string;
  text: string;
}

export interface Planned {
  file: string;
  statement: Statement;
  /** Set when the statement doesn't only read: then nothing is run. */
  problem?: Problem;
}

export interface Outcome extends Planned {
  result?: QueryResult;
  /** The database's error message. */
  error?: string;
  ms: number;
}

/** The statements of the files, each checked to only read. */
export function planQueries(files: SqlFile[], dialect: string): Planned[] {
  return files.flatMap((f) =>
    splitStatements(f.text, dialect).map((statement) => {
      const problem = readOnlyProblem(statement.sql, dialect);
      return problem ? { file: f.name, statement, problem } : { file: f.name, statement };
    }),
  );
}

/** Runs the statements one after another; one that fails doesn't stop the others. */
export async function runPlanned(db: DbAdapter, planned: Planned[], maxRows: number, onDone?: (o: Outcome) => void): Promise<Outcome[]> {
  if (!db.runQuery) throw new Error(`ashiato query can't run statements on ${db.dialect}`);
  const outcomes: Outcome[] = [];
  for (const p of planned) {
    if (p.problem) throw new Error(`${p.file}:${p.statement.line}: ${p.problem.message}`);
    const started = performance.now();
    let outcome: Outcome;
    try {
      const result = await db.runQuery(p.statement.sql, maxRows);
      outcome = { ...p, result, ms: Math.round(performance.now() - started) };
    } catch (e) {
      outcome = { ...p, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - started) };
    }
    outcomes.push(outcome);
    onDone?.(outcome);
  }
  return outcomes;
}

const TEXT = {
  en: {
    title: "# Database check results",
    intro: (db: string, at: string, max: number) => `Run read-only by \`ashiato query\` on ${db} (${at}). At most ${max} rows per statement.`,
    where: (file: string, line: number) => `${file}, line ${line}`,
    untitled: (file: string, line: number) => `${file}, line ${line}`,
    rows: (n: number, ms: number) => (n === 0 ? `No rows (${ms} ms).` : `${n} row${n === 1 ? "" : "s"} (${ms} ms).`),
    more: (n: number, ms: number) => `The first ${n} rows (there are more; ${ms} ms).`,
    error: (ms: number, message: string) => `**Error** (${ms} ms): ${message}`,
    noTable: "(The statement returned no rows to show.)",
    noName: "(no name)",
    refusedTitle: "# Database check results (nothing was run)",
    refusedIntro: "Some statements don't only read, so ashiato query ran none of them. Change these so that they only read (SELECT):",
    problem: (p: Problem) => p.message,
  },
  ja: {
    title: "# DB 確認の結果",
    intro: (db: string, at: string, max: number) => `${db} で \`ashiato query\` が参照専用で実行した結果です(${at})。1 文につき先頭 ${max} 行までです。`,
    where: (file: string, line: number) => `${file} の ${line} 行目`,
    untitled: (file: string, line: number) => `${file} の ${line} 行目の文`,
    rows: (n: number, ms: number) => (n === 0 ? `0 行(該当なし。${ms} ms)` : `${n} 行(${ms} ms)`),
    more: (n: number, ms: number) => `先頭 ${n} 行(続きがあります。${ms} ms)`,
    error: (ms: number, message: string) => `**エラー**(${ms} ms):${message}`,
    noTable: "(表示する行を返さない文でした)",
    noName: "(名前なし)",
    refusedTitle: "# DB 確認の結果(実行していません)",
    refusedIntro: "参照(SELECT)だけではない文があるため、ashiato query は 1 文も実行していません。次の文を、参照だけの文に直してください。",
    problem: (p: Problem) => {
      switch (p.code) {
        case "not-select":
          return `SELECT か WITH で始まる文だけを実行します(この文は ${p.word ?? "?"} で始まっています)`;
        case "several":
          return "1 つの文の中に、別の文が入っている可能性があります。引用符の対応を確かめてください";
        case "writes":
          return `${p.word} を含む文は実行しません(参照だけの文にしてください。同じ名前の列は引用符で囲みます)`;
        case "locks":
          return `${p.word} は行をロックするため実行しません`;
        case "sequence":
          return "NEXT VALUE FOR はシーケンスを進めるため実行しません";
      }
    },
  },
};

function table(result: QueryResult, noName: string): string {
  const header = result.columns.map((c) => (c === "" ? noName : markdownCell(c)));
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of result.rows) lines.push(`| ${row.map((v: JsonValue) => markdownCell(v)).join(" | ")} |`);
  return lines.join("\n");
}

/** The results as Markdown, to paste into a chat: each statement with its comment, its SQL and its rows. */
export function queryReport(outcomes: Outcome[], options: { dialect: string; lang: Lang; maxRows: number; at?: Date }): string {
  const t = TEXT[options.lang];
  const at = options.at ?? new Date();
  const out = [t.title, "", t.intro(DIALECT_NAMES[options.dialect] ?? options.dialect, `${localTime(at.toISOString())} ${zoneOf(at)}`, options.maxRows)];
  outcomes.forEach((o, i) => {
    const { file, statement } = o;
    const heading = statement.title ? statement.title.split("\n")[0]! : t.untitled(file, statement.line);
    out.push("", `## ${i + 1}. ${heading}`, "");
    // the rest of a comment longer than one line, then where the statement is
    const more = statement.title.split("\n").slice(1).filter(Boolean);
    if (more.length) out.push(...more, "");
    out.push(t.where(file, statement.line), "", codeFence(statement.sql, "sql"), "");
    if (o.error !== undefined) out.push(t.error(o.ms, o.error));
    else if (o.result) {
      if (o.result.columns.length) out.push(table(o.result, t.noName), "");
      else out.push(t.noTable, "");
      out.push(o.result.more ? t.more(o.result.rows.length, o.ms) : t.rows(o.result.rows.length, o.ms));
    }
  });
  return `${out.join("\n")}\n`;
}

/** What to send back when a statement doesn't only read (nothing was run): which ones, and why. */
export function refusedReport(planned: Planned[], lang: Lang): string {
  const t = TEXT[lang];
  const out = [t.refusedTitle, "", t.refusedIntro];
  for (const p of planned.filter((x) => x.problem)) {
    out.push("", `## ${t.where(p.file, p.statement.line)}`, "", t.problem(p.problem!), "", codeFence(p.statement.sql, "sql"));
  }
  return `${out.join("\n")}\n`;
}
