import { randomBytes } from "node:crypto";
import type { DbAdapter, TableInfo } from "../adapters/types.js";
import { tableId } from "../core/diff.js";
import type { JsonValue, TableRef } from "../core/types.js";
import type { Lang } from "../export/text.js";
import { DIALECT_NAMES, markdownCell } from "./markdown.js";
import {
  type ColumnProfile,
  type DataRules,
  inferReferences,
  PROFILE_DEFAULTS,
  profileTable,
  type Reference,
  type SampleCell,
  type TableProfile,
} from "./profile.js";

const count = (n: number) => n.toLocaleString("en-US");

const TEXT = {
  en: {
    title: "# Database tables",
    intro: (db: string) =>
      `Written by \`ashiato schema\` from the ${db} catalog (read-only): columns, types, primary keys and comments. Run it again after the tables change.`,
    dataIntro: (date: string) =>
      `With \`--data\`, it also describes the rows as of ${date}: row counts, references (foreign keys, and relations inferred from the values), and for each column the share of NULLs, the number of distinct values, the values of codes with their counts, ranges and formats. In formats, 9 is a digit, A / a a letter, あ / ア kana and 漢 a kanji; a letter that is the same in every value is written as itself. The values of the columns marked "hidden" are not written (data-rules.json changes which).`,
    tables: "## Tables",
    views: "## Views",
    key: (cols: string[]) => `Primary key: ${cols.length ? cols.join(", ") : "(none)"}`,
    header: (comments: boolean, data: boolean) => `| Column | Type | Null |${comments ? " Comment |" : ""}${data ? " Data |" : ""}`,
    unreadable: (why: string) => `Could not be read: ${why}`,
    notShown: "(the database's message is not shown)",
    none: "(none)",
    rows: (n: number, read?: number) => `Rows: ${count(n)}${read !== undefined ? ` (the column figures come from the first ${count(read)})` : ""}`,
    references: (parts: string[]) => `References: ${parts.join("; ")}`,
    declared: "foreign key",
    inferred: "inferred: every value is found there",
    hidden: "hidden",
    allNull: "all NULL",
    nulls: (pct: string) => `NULL ${pct}%`,
    unique: "no duplicates",
    distinct: (n: number) => `${count(n)} distinct`,
    range: (a: string, b: string) => (a === b ? a : `${a} to ${b}`),
    format: (f: string[]) => `format ${f.join(" / ")}`,
    length: (a: number, b: number) => (a === b ? `${count(a)} characters` : `${count(a)} to ${count(b)} characters`),
    notRead: "(not read)",
    failed: "(could not be read)",
    samples: (n: number, ordered: boolean) => `Sample rows (${ordered ? `the ${n} with the highest primary key` : `${n}`}; hidden columns replaced):`,
    chars: (n: number) => `(${count(n)} characters)`,
    date: "(date)",
  },
  ja: {
    title: "# DB のテーブル定義",
    intro: (db: string) =>
      `${db} のカタログから \`ashiato schema\` が書き出しました(参照のみ)。列・型・主キー・コメントです。テーブルが変わったら、もう一度実行してください。`,
    dataIntro: (date: string) =>
      `\`--data\` で ${date} 時点のデータの姿も書き足しています。件数・参照(外部キーと、値から推定したつながり)と、各列の NULL の割合・値の種類の数・区分の値と件数・範囲・書式です。書式は数字を 9、英字を A / a、かなを あ / ア、漢字を 漢 で表し、どの値でも同じ英字はそのまま書きます。「隠した列」の値は書いていません(data-rules.json で変えられます)。`,
    tables: "## テーブル",
    views: "## ビュー",
    key: (cols: string[]) => `主キー:${cols.length ? cols.join(", ") : "(なし)"}`,
    header: (comments: boolean, data: boolean) => `| 列 | 型 | Null |${comments ? " コメント |" : ""}${data ? " データ |" : ""}`,
    unreadable: (why: string) => `読み取れませんでした:${why}`,
    notShown: "(DB のメッセージは表示しません)",
    none: "(なし)",
    rows: (n: number, read?: number) => `件数:${count(n)} 行${read !== undefined ? `(各列のデータは先頭 ${count(read)} 行から)` : ""}`,
    references: (parts: string[]) => `参照:${parts.join("、")}`,
    declared: "外部キー",
    inferred: "推定:値がすべて見つかる",
    hidden: "隠した列",
    allNull: "すべて NULL",
    nulls: (pct: string) => `NULL ${pct}%`,
    unique: "重複なし",
    distinct: (n: number) => `${count(n)} 種`,
    range: (a: string, b: string) => (a === b ? a : `${a}〜${b}`),
    format: (f: string[]) => `書式 ${f.join(" / ")}`,
    length: (a: number, b: number) => (a === b ? `${count(a)} 文字` : `${count(a)}〜${count(b)} 文字`),
    notRead: "(読みません)",
    failed: "(読めませんでした)",
    samples: (n: number, ordered: boolean) => `見本の行(${ordered ? `主キーの大きい順に ${n} 行` : `${n} 行`}。隠した列は置き換えています):`,
    chars: (n: number) => `(${count(n)} 文字)`,
    date: "(日付)",
  },
};
type Text = (typeof TEXT)[Lang];

/** `*` and `?` patterns, or exact names (`name` or `schema.name`), case-insensitive. Throws when an exact name matches nothing. */
export function pickTables<T extends TableRef>(all: T[], patterns?: string[]): T[] {
  const wanted = (patterns ?? []).map((p) => p.trim()).filter(Boolean);
  if (!wanted.length) return all;
  const regex = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  const tests = wanted.map((p) => ({ p, re: regex(p) }));
  const hit = (t: T, re: RegExp) => re.test(t.name) || re.test(tableId(t));
  const missing = tests.filter(({ p, re }) => !/[*?]/.test(p) && !all.some((t) => hit(t, re))).map(({ p }) => p);
  if (missing.length) throw new Error(`Tables not found: ${missing.join(", ")}`);
  return all.filter((t) => tests.some(({ re }) => hit(t, re)));
}

/** One table's or view's definition: a `### ` heading, its primary key and its columns. */
export interface SchemaSection {
  table: TableRef;
  isTable: boolean;
  lines: string[];
}

/** `--data`: describe the tables' rows too. */
export interface DataOptions {
  rules?: DataRules;
  /** Sample rows per table (default 0: none). */
  samples?: number;
  /** Tables with more rows are described from their first `sampleRows` (defaults: 1,000,000 and 100,000). */
  largeTable?: number;
  sampleRows?: number;
  /** The date written in the intro (default: today, on this machine). */
  date?: string;
}

/** The definitions of the tables and views picked, each as its own Markdown section, tables first. */
export async function schemaSections(
  db: DbAdapter,
  /** `errors: false`: a table that can't be read doesn't say why (the database's message may hold values). */
  options: { tables?: string[]; views?: boolean; lang: Lang; errors?: boolean; data?: DataOptions },
): Promise<{ sections: SchemaSection[]; unreadable: string[]; problems: string[]; hidden: number }> {
  if (!db.describeTable) throw new Error(`ashiato schema can't read table definitions on ${db.dialect}`);
  const t = TEXT[options.lang];
  const byId = (a: TableRef, b: TableRef) => tableId(a).localeCompare(tableId(b));
  const allTables = await db.listTables();
  const allViews = options.views === false || !db.listViews ? [] : await db.listViews();
  // picked together: a name may be a table's or a view's
  const picked = pickTables([...allTables, ...allViews], options.tables);
  const tables = picked.filter((x) => allTables.includes(x)).sort(byId);
  const views = picked.filter((x) => allViews.includes(x)).sort(byId);
  const unreadable: string[] = [];
  const problems: string[] = [];

  type Described = { ref: TableRef; isTable: boolean; info?: TableInfo; key: string[]; why?: string; profile?: TableProfile };
  const describe = async (ref: TableRef, isTable: boolean): Promise<Described> => {
    try {
      const info = await db.describeTable!(ref);
      return { ref, isTable, info, key: isTable ? await db.primaryKey(ref) : [] };
    } catch (e) {
      unreadable.push(tableId(ref));
      return { ref, isTable, key: [], why: options.errors === false ? t.notShown : e instanceof Error ? e.message : String(e) };
    }
  };
  const described: Described[] = [];
  for (const ref of tables) described.push(await describe(ref, true));
  for (const ref of views) described.push(await describe(ref, false));

  const data = options.data;
  if (data) {
    const profileOptions = {
      largeTable: data.largeTable ?? PROFILE_DEFAULTS.largeTable,
      sampleRows: data.sampleRows ?? PROFILE_DEFAULTS.sampleRows,
      samples: data.samples ?? 0,
      rules: data.rules ?? {},
      key: randomBytes(32),
    };
    for (const d of described) {
      if (!d.isTable || !d.info?.columns.length) continue;
      try {
        d.profile = await profileTable(db, d.ref, d.info, d.key, profileOptions);
        problems.push(...d.profile.problems);
      } catch (e) {
        problems.push(`${tableId(d.ref)}: ${(e as Error).message}`);
      }
    }
    const candidates = described.flatMap((d) => (d.profile && d.info ? [{ table: d.ref, columns: d.info.columns.map((c) => c.name), key: d.key, profile: d.profile }] : []));
    problems.push(...(await inferReferences(db, candidates, profileOptions)));
  }

  const sections = described.map((d): SchemaSection => {
    if (!d.info) return { table: d.ref, isTable: d.isTable, lines: [`### ${tableId(d.ref)}`, "", t.unreadable(d.why ?? "")] };
    const info = d.info;
    const p = d.profile;
    const comments = info.columns.some((c) => c.comment);
    const lines = [`### ${tableId(d.ref)}${info.comment ? ` — ${markdownCell(info.comment)}` : ""}`, ""];
    if (d.isTable) lines.push(t.key(d.key), "");
    if (p) {
      lines.push(t.rows(p.rows, p.read < p.rows ? p.read : undefined));
      if (p.references.length) lines.push(t.references(p.references.map((r) => referenceText(r, t))));
      lines.push("");
    }
    const header = t.header(comments, Boolean(p));
    lines.push(header, `|${" --- |".repeat(header.split("|").length - 2)}`);
    info.columns.forEach((c, i) => {
      const cells = [markdownCell(c.name), markdownCell(c.type), c.nullable ? "NULL" : "NOT NULL"];
      if (comments) cells.push(c.comment ? markdownCell(c.comment) : "");
      if (p) cells.push(p.columns[i] ? dataCell(p.columns[i]!, p.read, t) : "");
      lines.push(`| ${cells.join(" | ")} |`);
    });
    if (p?.samples?.rows.length) {
      const s = p.samples;
      lines.push("", t.samples(s.rows.length, s.ordered), "", `| ${s.columns.map(markdownCell).join(" | ")} |`, `|${" --- |".repeat(s.columns.length)}`);
      for (const r of s.rows) lines.push(`| ${r.map((c) => sampleText(c, t)).join(" | ")} |`);
    }
    return { table: d.ref, isTable: d.isTable, lines };
  });
  const hidden = described.reduce((n, d) => n + (d.profile?.columns.filter((c) => c.hidden).length ?? 0), 0);
  return { sections, unreadable, problems, hidden };
}

function referenceText(r: Reference, t: Text): string {
  const list = (cols: string[]) => (cols.length === 1 ? cols[0]! : `(${cols.join(", ")})`);
  const target = r.referencedColumns.length === 1 ? `${tableId(r.references)}.${r.referencedColumns[0]}` : `${tableId(r.references)} ${list(r.referencedColumns)}`;
  return `${list(r.columns)} → ${target}(${r.inferred ? t.inferred : t.declared})`;
}

/** A number or date as the chat reads it: a value, not a Markdown cell's NULL. */
const plain = (v: JsonValue | undefined) => markdownCell(v ?? null);

function dataCell(c: ColumnProfile, read: number, t: Text): string {
  if (c.kind === "skip") return t.notRead;
  if (c.failed) return t.failed;
  if (read === 0) return "";
  const parts: string[] = [];
  if (c.hidden) parts.push(t.hidden);
  const nulls = c.nulls ?? 0;
  if (nulls === read) return [...parts, t.allNull].join(" · ");
  if (nulls > 0) {
    const pct = (nulls / read) * 100;
    parts.push(t.nulls(pct < 1 ? "<1" : pct > 99 && pct < 100 ? ">99" : String(Math.round(pct))));
  }
  if (c.values) {
    parts.push(c.values.map((v) => `${plain(v.value)} (${count(v.count)})`).join(", "));
    return parts.join(" · ");
  }
  if (c.distinct !== undefined) parts.push(c.distinct === read - nulls ? t.unique : t.distinct(c.distinct));
  if (c.min !== undefined && c.max !== undefined && c.min !== null && c.max !== null) parts.push(t.range(plain(c.min), plain(c.max)));
  if (c.formats) parts.push(t.format(c.formats.map((f) => markdownCell(f))));
  else if (c.minLength !== undefined && c.maxLength !== undefined) parts.push(t.length(c.minLength, c.maxLength));
  return parts.join(" · ");
}

function sampleText(c: SampleCell, t: Text): string {
  if ("value" in c) return markdownCell(c.value);
  if ("standIn" in c) return markdownCell(c.standIn);
  if ("length" in c) return t.chars(c.length);
  if ("date" in c) return t.date;
  return "…";
}

/** The tables' and views' definitions as Markdown, for an AI in a chat that writes SQL against them. */
export async function schemaMarkdown(
  db: DbAdapter,
  options: { tables?: string[]; views?: boolean; lang: Lang; data?: DataOptions },
): Promise<{ markdown: string; tables: number; views: number; unreadable: string[]; problems: string[]; hidden: number }> {
  const t = TEXT[options.lang];
  const { sections, unreadable, problems, hidden } = await schemaSections(db, options);
  const tables = sections.filter((s) => s.isTable);
  const views = sections.filter((s) => !s.isTable);
  const out = [t.title, "", t.intro(DIALECT_NAMES[db.dialect] ?? db.dialect), ""];
  if (options.data) out.push(t.dataIntro(options.data.date ?? today()), "");
  out.push(t.tables);
  if (!tables.length) out.push("", t.none);
  for (const s of tables) out.push("", ...s.lines);
  if (views.length) {
    out.push("", t.views);
    for (const s of views) out.push("", ...s.lines);
  }
  const markdown = `${out.join("\n")}\n`;
  return { markdown, tables: tables.length, views: views.length, unreadable, problems, hidden };
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
