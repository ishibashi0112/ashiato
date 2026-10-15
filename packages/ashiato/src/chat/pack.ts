import type { Page } from "playwright-core";
import type { DbAdapter } from "../adapters/types.js";
import { changesLine, labelShape } from "../agent/text.js";
import { tableId } from "../core/diff.js";
import type { Session, TableRef } from "../core/types.js";
import { localTime, zoneOf, type Lang } from "../export/text.js";
import { formatAria, HIDDEN, isIdSegment, parseAria, shapeAria, toRecord, urlShape } from "./aria.js";
import { codeFence, DIALECT_NAMES } from "./markdown.js";
import { schemaSections, type SchemaSection } from "./schema.js";

/**
 * `ashiato pack`: what a chat needs to write a verification of the app (`checks/*.verify.md`) in one
 * text, in this order, the later parts left out when it doesn't fit: what to write and how, each page's
 * accessibility tree (so the chat names buttons and fields as the page does), which actions changed
 * which tables (from recordings), the tables' definitions, the tests there are already, and code.
 * No rows' values: text on the pages that may show them is replaced with `…` unless `pageText`.
 */

/** One page as the crawl found it. */
export interface PageShot {
  /** The page's path, ids replaced with `:id`. */
  path: string;
  title?: string;
  /** Where it went instead (a redirect to the login page). */
  redirected?: string;
  status?: number;
  /** The accessibility tree, shaped (folded; without the database's values unless asked). */
  tree?: string;
  error?: string;
}

export interface CrawlOptions {
  /** The app's URL: the crawl starts there. */
  app: string;
  /** Paths to visit instead of following links. */
  pages?: string[];
  /** Pages visited at most when following links. Default 20. */
  maxPages?: number;
  /** Keep the pages' text (it may show the database's values). */
  pageText?: boolean;
  log?: (message: string) => void;
}

/** Links the crawl doesn't follow: they may log out, delete or download. */
const RISKY = /log-?out|sign-?out|logoff|ログアウト|サインアウト|delete|remove|destroy|削除|取消|取り消|cancel|キャンセル|download|ダウンロード|export|エクスポート/i;
const FILE = /\.(?:pdf|xlsx?|csv|zip|docx?|pptx?|png|jpe?g|gif|svg|txt|json|xml)$/i;

/** `/orders/1042` → `/orders/:id`: pages that differ only by an id are one page. Hash routes (`#/orders`) count; queries don't. */
export function pagePath(url: string, base?: string): string {
  let u: URL;
  try {
    u = new URL(url, base ?? "http://localhost");
  } catch {
    return url;
  }
  const id = (segment: string) => (isIdSegment(segment) ? ":id" : segment);
  const path = u.pathname.split("/").map(id).join("/");
  const hash = u.hash.startsWith("#/") ? `#${u.hash.slice(1).replace(/[?].*$/, "").split("/").map(id).join("/")}` : "";
  return path + hash;
}

/**
 * Visits the app's pages (the ones given, or those its links lead to, from `app`) and takes each
 * one's accessibility tree once it stops changing. Only links are followed (nothing is clicked), and
 * not those that look like logging out, deleting or downloading.
 */
export async function crawlPages(page: Page, options: CrawlOptions): Promise<PageShot[]> {
  const origin = new URL(options.app).origin;
  const follow = !options.pages?.length;
  const queue = follow ? [options.app] : options.pages!.map((p) => new URL(p, options.app).href);
  const max = follow ? (options.maxPages ?? 20) : queue.length;
  const seen = new Set<string>();
  const shots: PageShot[] = [];
  while (queue.length && shots.length < max) {
    const url = queue.shift()!;
    const path = pagePath(url);
    if (seen.has(path)) continue;
    seen.add(path);
    options.log?.(`  ${path}`);
    let status: number | undefined;
    try {
      const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      status = response?.status();
    } catch (e) {
      // Playwright names the URL, with its query: shaped like the paths
      const error = (e as Error).message.split("\n")[0]!;
      shots.push({ path, error: options.pageText ? error : error.replace(/\bhttps?:\/\/\S+/g, (u) => urlShape(u)) });
      continue;
    }
    const yaml = await settledTree(page);
    const landed = pagePath(page.url());
    if (landed !== path) {
      // a redirect: to a page taken already (the login page), or to one to take under its own path
      if (seen.has(landed)) {
        shots.push({ path, redirected: landed });
        continue;
      }
      seen.add(landed);
    }
    // a page of one record (/orders/:id, /orders/detail?id=1042) may name it in its title and headings
    const record = !options.pageText && toRecord(page.url());
    const tree = formatAria(shapeAria(parseAria(yaml), { text: options.pageText, record }));
    const title = (await page.title().catch(() => "")) || undefined;
    shots.push({
      path,
      title: title && record ? HIDDEN : title,
      ...(landed !== path ? { redirected: landed } : {}),
      ...(status && status >= 400 ? { status } : {}),
      tree,
    });
    if (!follow) continue;
    const links = await page
      .$$eval("a[href]", (as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: a.textContent ?? "", download: a.hasAttribute("download") })))
      .catch(() => [] as { href: string; text: string; download: boolean }[]);
    for (const l of links) {
      let u: URL;
      try {
        u = new URL(l.href);
      } catch {
        continue;
      }
      if (u.origin !== origin || l.download || FILE.test(u.pathname) || RISKY.test(u.pathname) || RISKY.test(l.text.trim())) continue;
      if (!seen.has(pagePath(u.href)) && !queue.some((x) => pagePath(x) === pagePath(u.href))) queue.push(u.href);
    }
  }
  return shots;
}

/**
 * The page's accessibility tree once it has stayed the same for half a second (data loaded after
 * the page itself), for at most 5 seconds. Header cells of tables are marked as such first, so their
 * text (the app's wording) is kept.
 */
async function settledTree(page: Page): Promise<string> {
  const deadline = Date.now() + 5000;
  let last = "";
  for (;;) {
    await page
      .evaluate(() => {
        for (const th of document.querySelectorAll("th:not([scope])")) {
          const row = th.parentElement;
          th.setAttribute("scope", row && [...row.children].every((c) => c.tagName === "TH") ? "col" : "row");
        }
      })
      .catch(() => undefined);
    const now = await page.locator("body").ariaSnapshot({ timeout: 5000 }).catch(() => "");
    if (now === last || Date.now() >= deadline) return now;
    last = now;
    await page.waitForTimeout(500);
  }
}

/** One action from recordings: on which page, what was done, what it sent and what it changed. */
export interface PageAction {
  page: string;
  action: string;
  requests: string[];
  /** `orders +1, stock ~1 (qty)`, by distinct outcome. */
  changes: string[];
  times: number;
}

/**
 * What the recorded actions did, by page, without values: the action as the browser marked it (a
 * button's caption, a field's label; a link or a cell only by its kind), the requests without their
 * queries, and the tables changed with counts and changed columns.
 */
export function pageActions(sessions: Session[], lang: Lang): PageAction[] {
  const none = lang === "ja" ? "変化なし" : "no changes";
  const byKey = new Map<string, PageAction>();
  for (const session of sessions) {
    for (const step of session.steps) {
      const a = step.action;
      if (!a || step.source === "sync") continue;
      const page = a.page ? pagePath(a.page) : "?";
      const requests = [
        ...new Set(a.requests.map((r) => (r.kind === "http" ? `${r.method} ${pagePath(r.url ?? "")}` : `WebView2 ${r.method}`))),
      ];
      const changes = changesLine(step.diff, { direction: true }) || none;
      const action = labelShape(step);
      const key = JSON.stringify([page, action, requests]);
      const found = byKey.get(key);
      if (!found) byKey.set(key, { page, action, requests, changes: [changes], times: 1 });
      else {
        found.times++;
        if (!found.changes.includes(changes)) found.changes.push(changes);
      }
    }
  }
  return [...byKey.values()].sort((x, y) => x.page.localeCompare(y.page));
}

/** Titles of the tests there are already (Playwright's `.spec` files, verifications), so the chat doesn't write them again. */
export interface ExistingTests {
  file: string;
  titles: string[];
}

/** `test("title"` and `test.describe("title"` of a test file. */
export function testTitles(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\btest(?:\.(?:describe|only|skip|fixme|fail|slow|step))*(?:\.(?:only|skip|fixme))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]!);
  return out;
}

export interface PackParts {
  lang: Lang;
  app?: string;
  dialect?: string;
  pages: PageShot[];
  /** The text of the pages was kept. */
  pageText?: boolean;
  actions: PageAction[];
  /** How many recordings the actions come from. */
  recordings: number;
  /** Columns the recordings ignored (`--ignore-columns`): their changes aren't in the actions. */
  ignoredColumns?: string[];
  tables: SchemaSection[];
  tests: ExistingTests[];
  /** Code to add at the end (repomix's output), as much as fits. */
  code?: { name: string; text: string };
  /** At most this many characters. Default 100,000. */
  maxChars?: number;
  at?: Date;
}

export interface Pack {
  markdown: string;
  /** What didn't fit. */
  left: { pages: string[]; actions: string[]; tables: string[]; tests: number; code?: string };
}

const TEXT = {
  en: {
    title: "# Material for writing verifications of this app",
    made: (at: string, app: string | undefined, db: string | undefined) =>
      `Made by \`ashiato pack\` (${at}${app ? `, app: ${app}` : ""}${db ? `, database: ${db}` : ""}).`,
    pages: "## Pages",
    pagesIntro: (hidden: boolean) =>
      `Each page's accessibility tree, as Playwright sees it: the names here are the ones to write in actions.${hidden ? " Text that may show the database's values is replaced with `…`; long lists show their first rows, then how many more." : " Long lists show their first rows, then how many more."}`,
    redirected: (to: string) => `(went to ${to})`,
    status: (n: number) => `(HTTP ${n})`,
    failed: (e: string) => `Could not be opened: ${e}`,
    actions: "## What actions changed in the database (recorded)",
    actionsIntro: (n: number) => `From ${n} recording(s) of \`ashiato record\`: counts and columns only, no values (+ inserted, ~ updated, - deleted; ↑ / ↓: the number went up / down).`,
    ignored: (columns: string) =>
      `The recordings ignore changes of ${columns} (\`--ignore-columns\`): they are not in the changed columns. Leave them out of the expected changes too; the person runs \`ashiato verify\` with the same \`--ignore-columns\`.`,
    actionsHead: "| Action | Requests | Changes | Times |",
    noActions: "No recordings yet: record a session with `ashiato record` (and the Vite plugin) going through the app, and this part is filled in.",
    notRecorded: (list: string) => `Pages with nothing recorded: ${list}.`,
    tables: "## Table definitions",
    tests: "## Tests there are already (don't write them again)",
    code: (name: string) => `## Code (${name})`,
    left: "## Left out (did not fit)",
    leftPages: (list: string) => `Pages: ${list}. Make another pack of them with --pages.`,
    leftActions: (list: string) => `Recorded actions of: ${list}.`,
    leftTables: (n: number, list: string) => `${n} table definition(s): ${list}.`,
    leftTests: (n: number) => `${n} test file(s).`,
    leftCode: (what: string) => `The code, ${what}.`,
    codeCut: (n: number) => `(cut: ${n.toLocaleString("en-US")} more characters)`,
  },
  ja: {
    title: "# このアプリの検証手順を書くための資料",
    made: (at: string, app: string | undefined, db: string | undefined) =>
      `\`ashiato pack\` が作りました(${at}${app ? `、アプリ: ${app}` : ""}${db ? `、DB: ${db}` : ""})。`,
    pages: "## 画面",
    pagesIntro: (hidden: boolean) =>
      `画面ごとのアクセシビリティ木(Playwright から見た画面)です。操作にはここにある名前を書きます。${hidden ? "DB の値が出ている可能性がある文字は「…」に置き換えています。長い一覧は先頭の数行と残りの件数だけです。" : "長い一覧は先頭の数行と残りの件数だけです。"}`,
    redirected: (to: string) => `(${to} に移動しました)`,
    status: (n: number) => `(HTTP ${n})`,
    failed: (e: string) => `開けませんでした: ${e}`,
    actions: "## 画面の操作と DB の変化(記録から)",
    actionsIntro: (n: number) => `\`ashiato record\` の記録 ${n} 件から集めました。件数と列名だけで、値は入れていません(+ 追加、~ 更新、- 削除。↑ / ↓ は数値が増えた / 減った)。`,
    ignored: (columns: string) =>
      `記録では ${columns} の変化を数えていません(\`--ignore-columns\`)。変わった列に出ていないのはそのためです。期待する DB の変化にもこの列は書かないでください(\`ashiato verify\` も同じ \`--ignore-columns\` を付けて実行します)。`,
    actionsHead: "| 操作 | 通信 | DB の変化 | 回数 |",
    noActions: "記録がまだありません。`ashiato record`(と Vite プラグイン)で一通り操作して記録すると、ここに入ります。",
    notRecorded: (list: string) => `記録がない画面: ${list}`,
    tables: "## テーブル定義",
    tests: "## すでにあるテスト(同じものは書かないでください)",
    code: (name: string) => `## コード(${name})`,
    left: "## 入りきらなかったもの",
    leftPages: (list: string) => `画面: ${list}。--pages でこれらの画面だけの資料を作り、続けて貼ってください。`,
    leftActions: (list: string) => `記録した操作: ${list}`,
    leftTables: (n: number, list: string) => `テーブル定義 ${n} 個: ${list}`,
    leftTests: (n: number) => `テストのファイル ${n} 個`,
    leftCode: (what: string) => `コード(${what})`,
    codeCut: (n: number) => `(以下 ${n.toLocaleString("ja-JP")} 文字を省略)`,
  },
};

/** The material, as long as `maxChars` allows: the parts at the end are left out first, then the later pages. */
export function packMarkdown(parts: PackParts): Pack {
  const t = TEXT[parts.lang];
  const max = parts.maxChars ?? 100_000;
  const at = parts.at ?? new Date();
  const left: Pack["left"] = { pages: [], actions: [], tables: [], tests: 0 };

  const head = [t.title, "", t.made(`${localTime(at.toISOString())} ${zoneOf(at)}`, parts.app, parts.dialect ? (DIALECT_NAMES[parts.dialect] ?? parts.dialect) : undefined), "", instructions(parts.lang)].join("\n");

  const pageChunks = parts.pages.map((p) => ({
    name: p.path,
    text: [
      `### ${p.path}${p.title ? ` — ${p.title}` : ""}${p.redirected ? ` ${t.redirected(p.redirected)}` : ""}${p.status ? ` ${t.status(p.status)}` : ""}`,
      "",
      ...(p.error ? [t.failed(p.error)] : p.tree !== undefined ? [codeFence(p.tree || "(empty)", "yaml")] : []),
    ].join("\n"),
  }));

  const recordedPages = [...new Set(parts.actions.map((a) => a.page))];
  const actionChunks = recordedPages.map((page) => ({
    name: page,
    text: [
      `### ${page}`,
      "",
      t.actionsHead,
      "| --- | --- | --- | --- |",
      ...parts.actions.filter((a) => a.page === page).map((a) => `| ${cell(a.action)} | ${cell(a.requests.join(", ") || "—")} | ${cell(a.changes.join(" / "))} | ${a.times} |`),
    ].join("\n"),
  }));
  const notRecorded = parts.pages.filter((p) => !p.error && !p.redirected && !recordedPages.includes(p.path)).map((p) => p.path);

  // the tables the recorded actions changed first: those matter most
  const changed = new Set(parts.actions.flatMap((a) => a.changes.flatMap((c) => [...c.matchAll(/(?:^|, )([^\s,]+) [+~-]/g)].map((m) => m[1]!.toLowerCase()))));
  const tableChunks = [...parts.tables]
    .sort((x, y) => Number(changed.has(tableId(y.table).toLowerCase())) - Number(changed.has(tableId(x.table).toLowerCase())))
    .map((s) => ({ name: tableId(s.table), text: s.lines.join("\n") }));

  const testLines = parts.tests.map((f) => `- ${f.file}: ${f.titles.map((x) => x.replace(/\s+/g, " ")).join(" / ")}`);

  const assemble = (pages: typeof pageChunks, actions: typeof actionChunks, tables: typeof tableChunks, tests: string[], code: string | undefined, leftNote: string) => {
    const out = [head];
    if (pages.length) out.push("", t.pages, "", t.pagesIntro(!parts.pageText), "", pages.map((c) => c.text).join("\n\n"));
    out.push("", t.actions, "");
    if (parts.recordings === 0) out.push(t.noActions);
    else {
      out.push(t.actionsIntro(parts.recordings));
      if (parts.ignoredColumns?.length) out.push("", t.ignored(parts.ignoredColumns.join(", ")));
      if (actions.length) out.push("", actions.map((c) => c.text).join("\n\n"));
      if (notRecorded.length) out.push("", t.notRecorded(notRecorded.join(", ")));
    }
    if (tables.length) out.push("", t.tables, "", tables.map((c) => c.text).join("\n\n"));
    if (tests.length) out.push("", t.tests, "", tests.join("\n"));
    if (code !== undefined && parts.code) out.push("", t.code(parts.code.name), "", code);
    if (leftNote) out.push("", leftNote);
    return `${out.join("\n")}\n`;
  };
  const leftNote = () => {
    const lines: string[] = [];
    if (left.pages.length) lines.push(`- ${t.leftPages(left.pages.join(", "))}`);
    if (left.actions.length) lines.push(`- ${t.leftActions(left.actions.join(", "))}`);
    if (left.tables.length) lines.push(`- ${t.leftTables(left.tables.length, shortList(left.tables))}`);
    if (left.tests) lines.push(`- ${t.leftTests(left.tests)}`);
    if (left.code) lines.push(`- ${t.leftCode(left.code)}`);
    return lines.length ? [t.left, "", ...lines].join("\n") : "";
  };

  const pages = [...pageChunks];
  const actions = [...actionChunks];
  const tables = [...tableChunks];
  const tests = [...testLines];
  let code = parts.code ? codeFence(parts.code.text, "") : undefined;
  const size = () => assemble(pages, actions, tables, tests, code, leftNote()).length;
  // room for the note of what was left out, which grows as things are
  const fits = () => size() <= max;

  if (!fits() && code !== undefined) {
    const over = size() - max;
    const keep = parts.code!.text.length - over - 200;
    if (keep > 2000) {
      code = codeFence(`${parts.code!.text.slice(0, keep)}\n${t.codeCut(parts.code!.text.length - keep)}`, "");
      left.code = parts.lang === "ja" ? "一部" : "in part";
    } else {
      code = undefined;
      left.code = parts.lang === "ja" ? "すべて" : "all of it";
    }
  }
  while (!fits() && tests.length) {
    tests.pop();
    left.tests++;
  }
  while (!fits() && tables.length) left.tables.unshift(tables.pop()!.name);
  while (!fits() && actions.length) left.actions.unshift(actions.pop()!.name);
  while (!fits() && pages.length > 1) left.pages.unshift(pages.pop()!.name);
  return { markdown: assemble(pages, actions, tables, tests, code, leftNote()), left };
}

export interface PackInput {
  lang: Lang;
  /** The app's URL: its pages are read in the browser `browser` opens. */
  app?: string;
  browser?: () => Promise<{ page: Page; close(): Promise<void> }>;
  pages?: string[];
  maxPages?: number;
  pageText?: boolean;
  /** The database whose tables are described. */
  db?: DbAdapter;
  tables?: string[];
  sessions: Session[];
  tests: ExistingTests[];
  code?: { name: string; text: string };
  maxChars?: number;
  /** false: a table whose definition can't be read doesn't say why (the MCP tool without --share-values). */
  dbErrors?: boolean;
  log?: (message: string) => void;
}

export interface PackResult {
  pack: Pack;
  pages: PageShot[];
  actions: PageAction[];
  tables: SchemaSection[];
  /** Tables whose definitions couldn't be read. */
  unreadable: string[];
}

/** Reads the pages, the tables and the recordings, and puts them together (`ashiato pack`, and the MCP tool `pack`). */
export async function makePack(input: PackInput): Promise<PackResult> {
  let pages: PageShot[] = [];
  if (input.app) {
    if (!input.browser) throw new Error("No browser to read the pages in");
    const driven = await input.browser();
    try {
      input.log?.(`Reading the pages of ${input.app}${input.pages?.length ? "" : " (following its links)"}:`);
      pages = await crawlPages(driven.page, { app: input.app, pages: input.pages, maxPages: input.maxPages, pageText: input.pageText, log: input.log });
    } finally {
      await driven.close().catch(() => undefined);
    }
  }
  let tables: SchemaSection[] = [];
  let unreadable: string[] = [];
  if (input.db) ({ sections: tables, unreadable } = await schemaSections(input.db, { tables: input.tables, views: false, lang: input.lang, errors: input.dbErrors }));
  const actions = pageActions(input.sessions, input.lang);
  const pack = packMarkdown({
    lang: input.lang,
    app: input.app,
    dialect: input.db?.dialect ?? input.sessions[0]?.dialect,
    pages,
    pageText: input.pageText,
    actions,
    recordings: input.sessions.length,
    ignoredColumns: ignoredColumns(input.sessions),
    tables,
    tests: input.tests,
    code: input.code,
    maxChars: input.maxChars,
  });
  return { pack, pages, actions, tables, unreadable };
}

/** The columns the recordings ignored (`--ignore-columns`), as first written. */
export function ignoredColumns(sessions: Session[]): string[] {
  const seen = new Map<string, string>();
  for (const s of sessions) for (const c of s.options?.ignoreColumns ?? []) if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
  return [...seen.values()];
}

/** What `left` says, in a line: `2 page(s), recorded actions`. Empty when nothing was left out. */
export function leftOut(left: Pack["left"]): string {
  return [left.pages.length && `${left.pages.length} page(s)`, left.actions.length && "recorded actions", left.tables.length && `${left.tables.length} table(s)`, left.tests && "tests", left.code && "code"]
    .filter(Boolean)
    .join(", ");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const shortList = (names: string[]) => (names.length > 30 ? `${names.slice(0, 30).join(", ")}, …` : names.join(", "));

/** What the chat is asked to write, and how. */
export function instructions(lang: Lang): string {
  return lang === "ja" ? INSTRUCTIONS_JA : INSTRUCTIONS_EN;
}

const EXAMPLE_JA = `# 受注登録

受注を 1 件登録して、取り消します。

## 1. 受注を登録する

新規受注の画面で得意先・数量を入れて登録する。

操作:
- 開く: /orders/new
- 選ぶ: 得意先 = 鈴木商事
- 入力: 数量 = 3
- 押す: 登録
- 確認: 「登録しました」が表示される

期待する DB の変化:
- ORDERS: 追加 1 行 (CUSTOMER_CODE=C001, QTY=3, STATUS=10)
- STOCK: 更新 1 行 (ITEM_CODE=A001) → (QTY-=3, UPD_DATE=*)
- ほかの表: 変化なし

## 2. 受注を取り消す

一覧で、登録した受注を取り消す。

操作:
- 開く: /orders
- 押す: 取消 (最後の行)
- 確認: 「取り消しました」が表示される

期待する DB の変化:
- ORDERS: 更新 1 行 (CUSTOMER_CODE=C001, STATUS=10) → (STATUS=90, ...)
- STOCK: 更新 1 行 (ITEM_CODE=A001) → (QTY+=3, ...)`;

const INSTRUCTIONS_JA = `## お願いしたいこと

この資料から、アプリの目的と主な使い方を読み取ってください。そのうえで、主なユースケースごとに、動作を確かめる手順を下の形式で書いてください。手順は \`ashiato verify --auto\` が Playwright で画面を操作して実行し、その間に DB がどう変わったかを「期待する DB の変化」と照合します。

- 1 つのユースケースを 1 ファイルにします。ファイルごとに、ファイル名(\`checks/受注登録.verify.md\` など)を 1 行書き、その下に中身をコードブロック(\`\`\`markdown)で出してください。
- プログラム(Playwright のテストコードなど)は書かないでください。手順だけを書きます。
- 手順に使う値(得意先コード、品目、既存の受注番号など)が要るときは、まずそれを探す SELECT 文を、冒頭に書いた DB の書き方で書いてください。人が \`ashiato query\` で実行して、結果を貼ります。
- 分からないことは推測で書かず、ファイルの外に「確認したいこと」として箇条書きにしてください。

## 手順ファイルの形式

\`\`\`markdown
${EXAMPLE_JA}
\`\`\`

- 手順は \`## 番号. すること\` の見出しで始めます。すること(人が読む説明)を 1〜2 行、\`操作:\` の下に操作を、\`期待する DB の変化:\` の下に DB の変化を、この順で書きます。
- 手順は上から順に、同じブラウザで続けて実行されます。最初の手順は \`開く:\` から始めてください。
- 画面以外(デスクトップアプリ、バッチなど)で人が行う手順は、\`操作:\` を書かずに、することだけを書きます。人が操作します。

### 操作(1 行に 1 つ、「- 」で始める)

| 書き方 | すること |
| --- | --- |
| \`開く: /orders/new\` | 画面を開く(下の「画面」の見出しのパス。\`:id\` は実在する値に置き換える) |
| \`入力: 数量 = 3\` | 入力欄に入れる(\`欄の名前 = 値\`) |
| \`選ぶ: 得意先 = 鈴木商事\` | リストボックスで選ぶ(選択肢の表示名か値) |
| \`チェック: 在庫不足のみ\` / \`チェックを外す: 在庫不足のみ\` | チェックボックス・ラジオボタン |
| \`押す: 登録\` | ボタン・リンク・タブ・メニューを押す |
| \`押す: 取消 (「1042」の行)\` | 表の、その文字が出ている行の中のボタンを押す(\`(最後の行)\` \`(最初の行)\` も可。見出し行は数えず、画面にあるすべての表の行で数える) |
| \`入力: spinbutton = 2 (「P001」の行)\` | 名前のない欄は、木にある役割名(\`textbox\` \`spinbutton\` \`combobox\` \`checkbox\` など)を名前の代わりに書く。その範囲(画面全体か、その行)にその種類の欄が 1 つだけのときに使える |
| \`キー: Enter\` | キーを押す(いま入力している欄で) |
| \`待つ: 「処理が終わりました」が表示される\` | 表示されるまで待つ(30 秒まで) |
| \`確認: 「登録しました」が表示される\` | 画面に出ていることを確かめる(\`が表示されない\` も可) |
| \`確認: 数量 = 3\` | 入力欄の値を確かめる |
| \`ダイアログ: キャンセル\` | 次に出るダイアログに答える。書かなければ OK で答えます。prompt には入れる文字を書きます |

- 名前は、下の「画面」のアクセシビリティ木にある名前を、一字一句そのまま使ってください(完全一致で探すので、「顧客名」と書いても「顧客名で検索」には当たりません)。ボタンやリンクは \`button "登録"\` の \`登録\`、入力欄は \`textbox "数量"\` や \`combobox "得意先"\` の名前(画面のラベル)です。CSS セレクターや XPath は書きません。
- 木にない名前は使えません。名前のない欄は役割名で書きます(上の表)。同じ種類の欄が画面に複数あれば、行で絞ります。それでも決まらなければ「確認したいこと」に書いてください。
- 「…」は、DB の値が出ている可能性があるため隠したところです。その値は使えません。
- \`確認:\` の文言は、木にあるものか、画面の動きから確かなものだけにしてください。

### 期待する DB の変化(1 行に 1 つ、「- 」で始める)

- \`表名: 追加 1 行 (列=値, ...)\`、\`表名: 更新 1 行 (どの行かが分かる列=値) → (変わる列=値, ...)\`、\`表名: 削除 1 行 (列=値)\`、\`表名: 変化なし\`
- 更新の → の後には、変わる列をすべて書きます。\`列+=3\` / \`列-=3\` は増減、\`列=*\` は値を問わない、最後の \`...\` はほかの列も変わってよい、の意味です。
- 書いていない表は変わってはいけません(\`ほかの表: 変化なし\`)。ログの表など、変わってもよいときは \`ほかの表: 問わない\`。DB を変えない手順(検索・表示)は \`- 変化なし\` だけを書きます。
- 表名・列名は「テーブル定義」のとおりに書きます。自動で決まる値(連番の ID、登録日時)は書かないか、\`=*\` にします。
- どの操作でどの表が変わるかは「画面の操作と DB の変化」が記録からの実績です。記録のない操作は、テーブル定義と画面から考え、自信がなければ「確認したいこと」に書いてください。

## 結果を貼られたら

\`ashiato verify --auto\` の結果(手順ごとの OK / NG、見つからなかった要素と画面にある似た名前、画面の木、DB の変化の違い)が貼られたら、NG の手順を直して、そのファイルの全体をもう一度出してください。`;

const EXAMPLE_EN = `# Order entry

Enter an order, then cancel it.

## 1. Enter an order

On the new order page, enter the customer and quantity and save.

Actions:
- open: /orders/new
- select: Customer = Suzuki Trading
- fill: Quantity = 3
- click: Save
- expect: "Saved" is shown

Expected changes:
- ORDERS: inserted 1 row (CUSTOMER_CODE=C001, QTY=3, STATUS=10)
- STOCK: updated 1 row (ITEM_CODE=A001) → (QTY-=3, UPD_DATE=*)
- other tables: no changes

## 2. Cancel it

In the list, cancel the order just entered.

Actions:
- open: /orders
- click: Cancel (last row)
- expect: "Cancelled" is shown

Expected changes:
- ORDERS: updated 1 row (CUSTOMER_CODE=C001, STATUS=10) → (STATUS=90, ...)
- STOCK: updated 1 row (ITEM_CODE=A001) → (QTY+=3, ...)`;

const INSTRUCTIONS_EN = `## What to write

From this material, work out what the app is for and how it is used. Then, for each main use case, write the steps that verify it, in the format below. \`ashiato verify --auto\` carries out the steps' actions in a browser with Playwright and compares what changed in the database with the expected changes.

- One use case per file. For each file, write its name on a line (\`checks/order-entry.verify.md\`), then its content in a code block (\`\`\`markdown).
- Don't write code (Playwright tests or anything else): only the steps.
- When the steps need values (customer codes, items, existing order numbers), first write SELECT statements that find them, for the database named at the top. The person runs them with \`ashiato query\` and pastes the results.
- Don't guess: list what you are unsure of under "Questions", outside the files.

## The format

\`\`\`markdown
${EXAMPLE_EN}
\`\`\`

- Each step starts with a heading \`## number. what to do\`, then a line or two for a person, the actions under \`Actions:\`, and the expected changes under \`Expected changes:\`, in that order.
- The steps run one after another in the same browser. Start the first one with \`open:\`.
- A step a person does outside the browser (a desktop app, a batch job) has no \`Actions:\`: only what to do.

### Actions (one per line, starting with \`- \`)

| Write | It does |
| --- | --- |
| \`open: /orders/new\` | Opens a page (a path from the headings under "Pages"; replace \`:id\` with a real value) |
| \`fill: Quantity = 3\` | Types in a field (\`field name = value\`) |
| \`select: Customer = Suzuki Trading\` | Picks in a list box (the option's text or value) |
| \`check: In stock only\` / \`uncheck: In stock only\` | Check boxes and radio buttons |
| \`click: Save\` | Clicks a button, link, tab or menu item |
| \`click: Cancel (row "1042")\` | Clicks the button in the table row showing that text (\`(last row)\`, \`(first row)\` too: header rows don't count, and the rows of every table on the page do) |
| \`fill: spinbutton = 2 (row "P001")\` | A field without a name: write its role in the tree (\`textbox\`, \`spinbutton\`, \`combobox\`, \`checkbox\`...) in place of the name. Only when the scope (the page, or the row) has one field of that kind |
| \`press: Enter\` | Presses a key (in the field being typed in) |
| \`wait: "Done" is shown\` | Waits until it is shown (up to 30 seconds) |
| \`expect: "Saved" is shown\` | Checks it is on the page (\`is not shown\` too) |
| \`expect: Quantity = 3\` | Checks a field's value |
| \`dialog: Cancel\` | Answers the next dialog. Without it, dialogs are answered with OK; for a prompt, write the text to type |

- Write names exactly as the accessibility trees under "Pages" have them (they are matched whole: \`Customer\` doesn't find \`Customer search\`): a button or link by the name in \`button "Save"\`, a field by the name in \`textbox "Quantity"\` or \`combobox "Customer"\` (its label). No CSS selectors or XPath.
- Names not in the tree can't be used. A field without a name is written by its role (above); when the page has several of that kind, pick one by its row. If that doesn't tell it either, ask under "Questions".
- \`…\` is text hidden because it may show the database's values: it can't be used.
- Only expect texts that are in the tree, or that the page's behaviour makes certain.

### Expected changes (one per line, starting with \`- \`)

- \`TABLE: inserted 1 row (COLUMN=value, ...)\`, \`TABLE: updated 1 row (COLUMN=value that picks the row) → (COLUMN=value, ...)\`, \`TABLE: deleted 1 row (COLUMN=value)\`, \`TABLE: no changes\`
- After an update's →, list every column it changes. \`COLUMN+=3\` / \`COLUMN-=3\`: changed by that much; \`COLUMN=*\`: any value; \`...\` at the end: other columns may change too.
- Tables not listed must not change (\`other tables: no changes\`). When some may (a log table): \`other tables: any\`. A step that changes nothing (a search, a page): just \`- no changes\`.
- Write table and column names as the table definitions have them. Leave out values the database makes up (new ids, timestamps), or write \`=*\`.
- "What actions changed in the database" is what recorded actions actually changed. For actions not recorded, work it out from the tables and the pages, and ask under "Questions" when unsure.

## When results are pasted

When the results of \`ashiato verify --auto\` are pasted (OK / NG per step, elements not found with similar names on the page, the page's tree, how the changes differ), correct the steps that are NG and write the whole file again.`;
