/**
 * `verify --auto` and `pack` in a real browser, against a small order app writing to SQLite.
 * Needs a Chromium for Playwright.
 */
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import type { DbAdapter } from "../src/adapters/types.js";
import { ActionRunner } from "../src/chat/auto.js";
import { openBrowser, type Driven } from "../src/chat/browser.js";
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
  let db: DbAdapter;
  let driven: Driven;

  beforeAll(async () => {
    ({ server, url } = await startOrdersApp(app.db));
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
      auto: { run: (a) => runner.run(a), screen: () => runner.screen() },
    });
    expect(run.outcomes.map((o) => o.verdict)).toEqual(["ok", "ok", "ng", "ng", "skipped"]);
    // only the step without actions asked the person
    expect(prompts).toHaveLength(1);
    const [, cancel, wrong, short] = run.outcomes;
    expect(cancel!.actions!.dialogs).toEqual(["confirm「取り消しますか？」: OK"]);
    expect(wrong!.actions!.done).toBe(2);
    expect(wrong!.actions!.failed!.message).toBe("ボタンかリンク「保存」が画面に見つかりません。");
    expect(wrong!.actions!.failed!.candidates).toContain('button "登録"');
    // the app said no: the text expected wasn't shown, and the page shows what it said instead
    expect(short!.actions!.failed!.message).toMatch(/^「登録しました」が表示されませんでした。/);
    expect(short!.actions!.screen).toContain('status: 在庫が足りません');

    const md = verifyReport(file, run, { fileName: "checks/受注.verify.md", dialect: "sqlite", lang: "ja" });
    expect(md).toContain("`checks/受注.verify.md` の手順の操作を `ashiato verify --auto` がブラウザで(Playwright で)実行し");
    expect(md).toContain("| 3. 名前を間違えた手順 | NG | 自動: ボタンかリンク「保存」が画面に見つかりません。 |");
    expect(md).toContain("操作:\n- ✓ 開く: /orders/new\n- ✓ 入力: 数量 = 1\n- ✗ 押す: 保存\n");
    // nothing is named like it: every button and link is listed (not the options of a list box)
    expect(md).toContain('画面にある似た名前:\n- link "ホーム"\n- link "受注一覧"\n- link "新規受注"\n- link "ログアウト"\n- button "登録"\n');
    expect(md).toContain("手順の終わりの画面(アクセシビリティ木):\n\n```yaml\n");
  }, 60_000);
});
