/**
 * `verify --auto` and `pack` in a real browser, against a small order app writing to SQLite.
 * Needs a Chromium for Playwright.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import type { DbAdapter } from "../src/adapters/types.js";
import { agentTools } from "../src/agent/tools.js";
import { ActionRunner } from "../src/chat/auto.js";
import { openBrowser, type Driven } from "../src/chat/browser.js";
import { crawlPages, packMarkdown } from "../src/chat/pack.js";
import { runVerify, verifyReport } from "../src/chat/verify.js";
import { parseVerifyFile } from "../src/chat/verifyFile.js";
import { createAppDb } from "./helpers.js";
import { startOrdersApp } from "./fixtures/ordersApp.js";

const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
const browserPath = chromium?.executablePath();
const canRun = browserPath && existsSync(browserPath);
if (process.env.ASHIATO_REQUIRE_E2E && !canRun) throw new Error(`Browser test cannot run: chromium=${browserPath ?? "missing"}`);

const ORDER = `# 受注の登録と取消

## 1. 受注を登録する

操作:
- 開く: /orders/new
- 選ぶ: 得意先 = 鈴木商事
- 入力: 数量 = 10
- 押す: 登録
- 確認: 「登録しました」が表示される

期待する DB の変化:
- orders: 追加 1 行 (customer_id=7, qty=10)
- stock: 更新 1 行 (item_id=3) → (qty-=10)

## 2. 取り消す

操作:
- 開く: /orders
- 押す: 取消 (「鈴木商事」の行)
- 確認: 「取り消しました」が表示される

期待する DB の変化:
- orders: 削除 1 行 (customer_id=7)
- stock: 更新 1 行 (item_id=3) → (qty+=10)

## 3. 名前を間違えた手順

操作:
- 開く: /orders/new
- 入力: 数量 = 1
- 押す: 保存

期待する DB の変化:
- orders: 追加 1 行

## 4. 在庫より多く注文する

操作:
- 選ぶ: 得意先 = 8
- 入力: 数量 = 999
- 押す: 登録
- 確認: 「登録しました」が表示される

期待する DB の変化:
- 変化なし

## 5. 人が行う手順

夜間バッチを流す
`;

describe.skipIf(!canRun)("verify --auto in a real browser", () => {
  const app = createAppDb();
  let server: Server;
  let url: string;
  let visits: string[];
  let db: DbAdapter;
  let driven: Driven;

  beforeAll(async () => {
    ({ server, url, visits } = await startOrdersApp(app.db));
    db = await connect(`sqlite:${app.file}`);
    driven = await openBrowser("verify --auto", { app: url });
  }, 60_000);
  afterAll(async () => {
    await driven?.close();
    await db?.close();
    await new Promise((r) => server?.close(r));
  });

  it("does the steps' actions and checks what each one changed", async () => {
    const file = parseVerifyFile(ORDER, "ja");
    expect(file.problems).toEqual([]);
    expect(file.actionProblems).toEqual([]);
    const runner = new ActionRunner(driven.page, { lang: "ja", app: url, actionTimeout: 1500 });
    const prompts: string[] = [];
    const run = await runVerify(db, file, {
      lang: "ja",
      settleMs: 100,
      ask: async (p) => (prompts.push(p), "s"),
      log: () => undefined,
      auto: runner,
    });
    expect(run.outcomes.map((o) => o.verdict)).toEqual(["ok", "ok", "ng", "ng", "skipped"]);
    // only the step without actions asked the person
    expect(prompts).toHaveLength(1);
    const [, cancel, wrong, short] = run.outcomes;
    expect(cancel!.actions!.dialogs).toEqual([{ type: "confirm", message: "取り消しますか？", accept: true }]);
    expect(wrong!.actions!.done).toBe(2);
    expect(wrong!.actions!.failed!.message).toBe("ボタンかリンク「保存」が画面に見つかりません。");
    expect(wrong!.actions!.failed!.candidates).toContain('button "登録"');
    // the app said no: the text expected wasn't shown, and the page shows what it said instead
    expect(short!.actions!.failed!.message).toMatch(/^「登録しました」が表示されませんでした。/);
    expect(short!.actions!.screen!.text).toContain("status: 在庫が足りません");
    // without the page's text, for an AI told no values
    expect(short!.actions!.screen!.valueFree).toContain("status: …");
    expect(wrong!.actions!.failed!.valueFree).toEqual({ message: "ボタンかリンク「保存」が画面に見つかりません。", candidates: wrong!.actions!.failed!.candidates });

    const md = verifyReport(file, run, { fileName: "checks/受注.verify.md", dialect: "sqlite", lang: "ja" });
    expect(md).toContain("`checks/受注.verify.md` の手順の操作を `ashiato verify --auto` がブラウザで(Playwright で)実行し");
    expect(md).toContain("| 3. 名前を間違えた手順 | NG | 自動: ボタンかリンク「保存」が画面に見つかりません。 |");
    expect(md).toContain("操作:\n- ✓ 開く: /orders/new\n- ✓ 入力: 数量 = 1\n- ✗ 押す: 保存\n");
    // nothing is named like it: every button and link is listed (not the options of a list box)
    expect(md).toContain('画面にある似た名前:\n- link "ホーム"\n- link "受注一覧"\n- link "新規受注"\n- link "ログアウト"\n- button "登録"\n');
    expect(md).toContain("手順の終わりの画面(アクセシビリティ木):\n\n```yaml\n");
  }, 60_000);

  it("packs each page's accessibility tree without what may show the database's values", async () => {
    app.db.exec("INSERT INTO orders (customer_id, qty, updated_at) VALUES (8, 2, 'x'), (7, 4, 'x'), (7, 5, 'x'), (8, 6, 'x'), (7, 7, 'x'), (8, 8, 'x')");
    visits.length = 0;
    const pages = await crawlPages(driven.page, { app: `${url}/` });
    expect(pages.map((p) => [p.path, p.title])).toEqual([
      ["/", "受注管理"],
      ["/orders", "受注一覧"],
      ["/orders/new", "新規受注"],
    ]);
    // links that may log out (or delete, download) are not followed
    expect(visits.filter((v) => v.startsWith("GET /logout"))).toEqual([]);
    const [home, orders, form] = pages.map((p) => p.tree!);
    expect(home).toContain('- heading "受注管理" [level=1]');
    expect(home).toContain("- paragraph: …");
    expect(home).not.toContain("鈴木");
    expect(form).toContain('- combobox "得意先":\n    - option "…"');
    expect(form).toContain('- spinbutton "数量"');
    // named by its placeholder
    expect(form).toContain('- textbox "備考"');
    expect(form).toContain('- button "登録"');
    // column headers are the app's wording; rows are data, and only their buttons keep their names
    expect(orders).toContain('- columnheader "番号"');
    expect(orders).toContain('- cell "…"');
    expect(orders).toContain('- button "取消"');
    expect(orders).toContain("- text: (+1 rows)");
    expect(orders).not.toMatch(/鈴木|田中/);

    const withText = await crawlPages(driven.page, { app: url, pages: ["/orders"], pageText: true });
    expect(withText.map((p) => p.path)).toEqual(["/orders"]);
    expect(withText[0]!.tree).toContain('- cell "田中物産"');

    const pack = packMarkdown({ lang: "ja", app: url, pages, actions: [], recordings: 0, tables: [], tests: [] });
    expect(pack.markdown).toContain("## 画面\n\n画面ごとのアクセシビリティ木");
    expect(pack.markdown).toContain("### /orders/new — 新規受注\n\n```yaml\n- navigation:");
    expect(pack.markdown).toContain("記録がまだありません。");
  }, 60_000);

  it("finds the first row of data past a header row, and doesn't carry dialog answers to the next step", async () => {
    const page = driven.page;
    await page.goto("about:blank");
    await page.setContent(`<table><thead><tr><th>品目</th><th></th></tr></thead><tbody>
<tr><td>A001</td><td><button onclick="out.textContent='先頭を押した'">編集</button></td></tr>
<tr><td>A002</td><td><button onclick="out.textContent='最後を押した'">編集</button></td></tr>
</tbody></table><p id="out"></p><button onclick="out.textContent = confirm('消しますか') ? '消した' : 'やめた'">消す</button>`);
    const file = parseVerifyFile(
      "# t\n\n## 1. 行\n\n操作:\n- 押す: 編集 (最初の行)\n- 確認: 「先頭を押した」が表示される\n- 押す: 編集 (最後の行)\n- 確認: 「最後を押した」が表示される\n- ダイアログ: キャンセル\n\n" +
        "## 2. 消す\n\n操作:\n- 押す: 消す\n- 確認: 「消した」が表示される\n\n## 3. 開く\n\n操作:\n- 開く: /orders\n",
      "ja",
    );
    expect(file.actionProblems).toEqual([]);
    const runner = new ActionRunner(page, { lang: "ja", actionTimeout: 1500 });
    const [rows, remove, open] = file.steps.map((s) => s.actions!);
    expect(await runner.run(rows!)).toEqual({ done: 5, dialogs: [] });
    // the Cancel the first step gave, no dialog took: the next step's dialog is answered OK
    const removed = await runner.run(remove!);
    expect(removed.failed).toBeUndefined();
    expect(removed.dialogs).toEqual([{ type: "confirm", message: "消しますか", accept: true }]);
    // a path without the app's URL: said in words of its own, also to an AI told no values
    const opened = await runner.run(open!);
    expect(opened.failed!.valueFree.message).toBe('"/orders" is not a URL: give the app\'s URL with --app to open paths of it');
  });
});

describe.skipIf(!canRun)("MCP tools pack and verify_auto", () => {
  const app = createAppDb();
  let server: Server;
  let url: string;
  const dir = mkdtempSync(join(tmpdir(), "ashiato-mcp-auto-"));
  const tools = (values = false) => {
    const agent = agentTools({ db: `sqlite:${app.file}`, shareValues: values, out: dir, port: false });
    const call = (name: string, args: Record<string, unknown>) => agent.tools.find((t) => t.name === name)!.run(args);
    return { agent, call };
  };
  beforeAll(async () => {
    ({ server, url } = await startOrdersApp(app.db));
    app.db.exec("INSERT INTO orders (customer_id, qty, updated_at) VALUES (8, 2, 'x')");
  });
  afterAll(() => new Promise((r) => server?.close(r)));

  it("gives an agent the material without the database's values", async () => {
    const { agent, call } = tools();
    try {
      const pack = await call("pack", { app: url, lang: "ja", tests: dir });
      expect(pack).toMatch(/^3 page\(s\), 0 recorded action\(s\) from \d+ recording\(s\), 3 table\(s\)\.\nYou are an agent: write each verification to checks\/<name>\.verify\.md yourself/);
      expect(pack).toContain("### /orders/new — 新規受注");
      expect(pack).toContain("## テーブル定義");
      // (the instructions' example has a customer of its own)
      expect(pack).not.toMatch(/田中|ようこそ/);
      await expect(call("pack", { app: url, page_text: true })).rejects.toThrow("page_text needs the server started with --share-values");
      expect(agent.tools.find((t) => t.name === "pack")!.inputSchema.properties).not.toHaveProperty("page_text");
    } finally {
      await agent.close();
    }
  }, 60_000);

  it("checks verifications and says what failed without the database's values", async () => {
    const file = join(dir, "受注.verify.md");
    writeFileSync(
      file,
      `# 受注

## 1. 登録する

操作:
- 開く: /orders/new
- 選ぶ: 得意先 = 田中物産
- 入力: 数量 = 3
- 押す: 登録

期待する DB の変化:
- orders: 追加 1 行 (customer_id=8, qty=4)
- stock: 更新 1 行 (item_id=3) → (qty-=3)

## 2. 選択肢を間違える

操作:
- 選ぶ: 得意先 = 佐藤工業

期待する DB の変化:
- 変化なし

## 3. 人が行う

バッチを流す
`,
    );
    const { agent, call } = tools();
    try {
      const out = join(dir, "report.md");
      const summary = await call("verify_auto", { files: [file], app: url, lang: "ja", out });
      expect(summary).toContain("受注.verify.md: NG 2, 飛ばした 1");
      expect(summary).toContain("1. 登録する: NG\n  actions: ✓ 開く: /orders/new | ✓ 選ぶ: 得意先 = 田中物産 | ✓ 入力: 数量 = 3 | ✓ 押す: 登録\n  changed: orders +1, stock ~1 (qty)");
      expect(summary).toContain("  differences:\n    orders: 1 inserted row found, but not the expected ones\n");
      expect(summary).toContain("qty: expected 4, got another value");
      expect(summary).toContain("2. 選択肢を間違える: NG\n  actions: ✗ 選ぶ: 得意先 = 佐藤工業\n  failed: 得意先 に選択肢「佐藤工業」がありません。");
      expect(summary).toContain("3. 人が行う: 飛ばした (no actions: a person does this step)");
      expect(summary).toContain(`Report (with the rows' values, for the person): ${out}`);
      // the options of the list box and the rows found are the database's values: not in the summary (the step's own words are)
      expect(summary.replace(/田中物産/g, "")).not.toMatch(/鈴木|田中/);
      expect(summary).not.toContain("updated_at");
      const report = readFileSync(out, "utf8");
      expect(report).toContain('選択肢: "鈴木商事 (7)", "田中物産 (8)"');
      expect(report).toContain("qty: expected 4, got 3");
    } finally {
      await agent.close();
    }
    const shared = tools(true);
    try {
      const report = await shared.call("verify_auto", { files: [file], app: url, lang: "ja", out: join(dir, "shared.md") });
      expect(report).toContain("# 動作検証の結果: 受注");
      expect(report).toContain('選択肢: "鈴木商事 (7)", "田中物産 (8)"');
    } finally {
      await shared.agent.close();
    }
  }, 90_000);
});
