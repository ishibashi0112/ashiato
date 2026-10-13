import type { DbAdapter, TableInfo } from "../adapters/types.js";
import { tableId } from "../core/diff.js";
import type { TableRef } from "../core/types.js";
import type { Lang } from "../export/text.js";
import { DIALECT_NAMES, markdownCell } from "./markdown.js";

const TEXT = {
  en: {
    title: "# Database tables",
    intro: (db: string) =>
      `Written by \`ashiato schema\` from the ${db} catalog (read-only): columns, types, primary keys and comments. Run it again after the tables change.`,
    tables: "## Tables",
    views: "## Views",
    key: (cols: string[]) => `Primary key: ${cols.length ? cols.join(", ") : "(none)"}`,
    header: (comments: boolean) => `| Column | Type | Null |${comments ? " Comment |" : ""}`,
    unreadable: (why: string) => `Could not be read: ${why}`,
    none: "(none)",
  },
  ja: {
    title: "# DB のテーブル定義",
    intro: (db: string) =>
      `${db} のカタログから \`ashiato schema\` が書き出しました(参照のみ)。列・型・主キー・コメントです。テーブルが変わったら、もう一度実行してください。`,
    tables: "## テーブル",
    views: "## ビュー",
    key: (cols: string[]) => `主キー:${cols.length ? cols.join(", ") : "(なし)"}`,
    header: (comments: boolean) => `| 列 | 型 | Null |${comments ? " コメント |" : ""}`,
    unreadable: (why: string) => `読み取れませんでした:${why}`,
    none: "(なし)",
  },
};

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

/** The tables' and views' definitions as Markdown, for an AI in a chat that writes SQL against them. */
export async function schemaMarkdown(
  db: DbAdapter,
  options: { tables?: string[]; views?: boolean; lang: Lang },
): Promise<{ markdown: string; tables: number; views: number; unreadable: string[] }> {
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

  const section = async (ref: TableRef, isTable: boolean) => {
    let info: TableInfo;
    let key: string[] = [];
    try {
      info = await db.describeTable!(ref);
      if (isTable) key = await db.primaryKey(ref);
    } catch (e) {
      unreadable.push(tableId(ref));
      return [`### ${tableId(ref)}`, "", t.unreadable(e instanceof Error ? e.message : String(e))];
    }
    const comments = info.columns.some((c) => c.comment);
    const lines = [`### ${tableId(ref)}${info.comment ? ` — ${markdownCell(info.comment)}` : ""}`, ""];
    if (isTable) lines.push(t.key(key), "");
    lines.push(t.header(comments), `| --- | --- | --- |${comments ? " --- |" : ""}`);
    for (const c of info.columns) {
      const cells = [markdownCell(c.name), markdownCell(c.type), c.nullable ? "NULL" : "NOT NULL"];
      if (comments) cells.push(c.comment ? markdownCell(c.comment) : "");
      lines.push(`| ${cells.join(" | ")} |`);
    }
    return lines;
  };

  const out = [t.title, "", t.intro(DIALECT_NAMES[db.dialect] ?? db.dialect), "", t.tables];
  if (!tables.length) out.push("", t.none);
  for (const ref of tables) out.push("", ...(await section(ref, true)));
  if (views.length) {
    out.push("", t.views);
    for (const ref of views) out.push("", ...(await section(ref, false)));
  }
  return { markdown: `${out.join("\n")}\n`, tables: tables.length, views: views.length, unreadable };
}
