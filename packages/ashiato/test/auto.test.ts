import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseActions } from "../src/chat/actions.js";
import { formatAria, isIdSegment, parseAria, shapeAria, toRecord, urlShape } from "../src/chat/aria.js";
import { actionCode, likeness } from "../src/chat/auto.js";
import { EXPORTED_HEADER, exportTest } from "../src/chat/exportTests.js";
import { parseExpectedLines, parseVerifyFile } from "../src/chat/verifyFile.js";
import { main } from "../src/cli/main.js";
import { expectationOf } from "../src/testing/watch.js";

const actions = (lines: string[], lang: "ja" | "en" = "ja") => parseActions(["操作:", ...lines], 10, lang);

describe("parseActions", () => {
  it("reads each kind of action, in Japanese and English", () => {
    const { actions: list, problems } = actions([
      "- 開く: /orders/new",
      "- 選ぶ: 得意先 = 鈴木商事",
      "- 入力: 「備考 (社内)」 = 「a = b」",
      "- チェック: 在庫不足のみ",
      "- チェックを外す: 在庫不足のみ",
      "- 押す: 登録",
      "- 押す: 取消 (「1042」の行)",
      "- 押す: 文字「次へ」",
      "- 押す: (最後の行)",
      "- キー: ctrl + a",
      "- 待つ: 2 秒",
      "- 待つ: 「読み込み中」が表示されない",
      "- 確認: 「登録しました」が表示される",
      "- 確認: 数量 = 3",
      "- ダイアログ: キャンセル",
      "- ダイアログ: 理由です",
      "",
      "期待する DB の変化:",
      "- 押す: これは操作ではない",
    ]);
    expect(problems).toEqual([]);
    expect(list!.map(({ line, written, ...a }) => a)).toEqual([
      { verb: "open", target: "/orders/new" },
      { verb: "select", target: "得意先", value: "鈴木商事" },
      { verb: "fill", target: "備考 (社内)", value: "a = b" },
      { verb: "check", target: "在庫不足のみ" },
      { verb: "uncheck", target: "在庫不足のみ" },
      { verb: "click", target: "登録" },
      { verb: "click", target: "取消", row: { text: "1042" } },
      { verb: "click", target: "次へ", byText: true },
      { verb: "click", row: { at: "last" } },
      { verb: "press", target: "Control+a" },
      { verb: "wait", ms: 2000 },
      { verb: "wait", shown: "読み込み中", hidden: true },
      { verb: "expect", shown: "登録しました" },
      { verb: "expect", target: "数量", value: "3" },
      { verb: "dialog", accept: false },
      { verb: "dialog", accept: true, value: "理由です" },
    ]);
    const unnamed = actions(["- 入力: spinbutton = 2 (「P001」の行)", "- 選ぶ: combobox = 山田商事", "- チェック: チェックボックス (最初の行)", "- 入力: 入力欄 = x"]);
    expect(unnamed.problems).toEqual([]);
    expect(unnamed.actions!.map(({ line, written, ...a }) => a)).toEqual([
      { verb: "fill", target: "spinbutton", value: "2", roles: ["spinbutton"], row: { text: "P001" } },
      { verb: "select", target: "combobox", value: "山田商事", roles: ["combobox"] },
      { verb: "check", target: "チェックボックス", roles: ["checkbox"], row: { at: "first" } },
      { verb: "fill", target: "入力欄", value: "x", roles: ["textbox", "searchbox", "spinbutton"] },
    ]);
    expect(list![0]).toMatchObject({ line: 11, written: "開く: /orders/new" });

    const en = actions(['- open: /orders', '- click: Cancel (row "1042")', '- expect: "Saved" is shown', "- press: Enter", "- wait: 500ms", "- dialog: OK"], "en");
    expect(en.problems).toEqual([]);
    expect(en.actions!.map(({ line, written, ...a }) => a)).toEqual([
      { verb: "open", target: "/orders" },
      { verb: "click", target: "Cancel", row: { text: "1042" } },
      { verb: "expect", shown: "Saved" },
      { verb: "press", target: "Enter" },
      { verb: "wait", ms: 500 },
      { verb: "dialog", accept: true },
    ]);
  });

  it("says what is wrong with each line", () => {
    const { problems } = actions(["- 開く:", "- 入力: 数量", "- 削除する: 受注", "- 待つ: 2 分", "- 確認: 登録できること", "- キー: 長いキーの名前", "- 入力: checkbox = 3"]);
    expect(problems.map((p) => p.line)).toEqual([11, 12, 13, 14, 15, 16, 17]);
    expect(problems[6]!.message).toBe("「入力」は checkbox には使えません。textbox / searchbox / spinbutton / combobox を書いてください。");
    expect(problems[1]!.message).toBe("「入力: 欄の名前 = 値」の形で書いてください(欄の名前は画面のラベルのとおり)。");
    expect(problems[2]!.message).toMatch(/^「削除する」は操作の種類ではありません。/);
    expect(parseActions(["操作:", "画面を開いて登録する"], 1, "en").problems).toEqual([{ line: 2, message: "Write each action on a line of its own starting with `- `." }]);
    expect(parseActions(["Actions:"], 5, "en").problems).toEqual([{ line: 5, message: "Write the actions under `Actions:`, one per line starting with `- `." }]);
    // a step without the marker has no actions: a person does it
    expect(parseActions(["- 押す: 登録"], 1, "ja")).toEqual({ problems: [] });
  });

  it("are a step's actions in a verification, their problems kept apart", () => {
    const file = parseVerifyFile(
      "# t\n\n## 1. 登録\n\n操作:\n- 開く: /orders/new\n- 押す: 登録\n\n期待する DB の変化:\n- orders: 追加 1 行\n\n## 2. 人が行う\n\nバッチを流す\n\n## 3. 誤り\n\n操作:\n- 消す: 受注\n",
      "ja",
    );
    expect(file.problems).toEqual([]);
    expect(file.actionProblems).toEqual([{ line: 19, message: expect.stringMatching(/^「消す」は操作の種類ではありません。/) }]);
    expect(file.steps.map((s) => s.actions?.length)).toEqual([2, undefined, undefined]);
    // the actions aren't taken for expected changes
    expect(file.steps[0]!.expect!.lines).toEqual(["orders: 追加 1 行"]);
  });
});

describe("accessibility trees", () => {
  const YAML = `- navigation:
  - link "受注一覧":
    - /url: /orders?page=2
- heading "受注一覧" [level=1]
- paragraph: ようこそ 鈴木さん
- textbox "数量": "3"
- textbox:
  - /placeholder: 備考
- table:
  - rowgroup:
    - row "番号 得意先":
      - columnheader "番号"
      - columnheader "得意先"
  - rowgroup:
    - row "1 鈴木商事":
      - cell "1"
      - cell "鈴木商事"
      - cell:
        - button "取消"
    - row "2 田中物産":
      - cell "2"
      - cell "田中物産"
    - row "3 佐藤":
      - cell "3"
    - row "4 伊藤":
      - cell "4"
    - row "5 加藤":
      - cell "5"
    - row "6 遠藤":
      - cell "6"
    - row "7 後藤":
      - cell "7"`;

  it("reads and writes Playwright's YAML", () => {
    // a value is quoted only when it has to be
    expect(formatAria(parseAria(YAML))).toBe(YAML.replace('"数量": "3"', '"数量": 3'));
    const quoted = "- 'button \"a: b\"'\n- text: \"x: 'y'\"";
    expect(parseAria(quoted)[0]).toMatchObject({ role: "button", name: "a: b" });
    expect(parseAria(quoted)[1]).toMatchObject({ role: "text", value: "x: 'y'" });
  });

  it("hides what may show the database's values, keeps the app's wording and folds long lists", () => {
    const shaped = formatAria(shapeAria(parseAria(YAML)));
    expect(shaped).toContain('- link "受注一覧":\n    - /url: /orders\n');
    expect(shaped).toContain('- heading "受注一覧" [level=1]');
    expect(shaped).toContain("- paragraph: …");
    expect(shaped).toContain('- textbox "数量": …');
    expect(shaped).toContain("- /placeholder: 備考");
    expect(shaped).toContain('- columnheader "得意先"');
    expect(shaped).toContain('- cell "…"');
    expect(shaped).toContain('- button "取消"');
    // the first rows and the last two (what was just added)
    expect(shaped).toContain('- text: (+2 rows)\n    - row:\n      - cell "…"\n    - row:\n      - cell "…"');
    expect(shaped).not.toMatch(/鈴木|田中|佐藤|後藤|page=2/);
    // the text kept when asked
    expect(formatAria(shapeAria(parseAria(YAML), { text: true }))).toContain('- cell "鈴木商事"');
  });

  it("hides links to one record, and the headings of a record's page", () => {
    const yaml = `- heading "受注 1042 鈴木商事" [level=1]
- list:
  - listitem:
    - link "鈴木商事":
      - /url: /customers/12
  - listitem:
    - link "田中物産":
      - /url: /customers?customer_id=13
  - listitem:
    - link "受注一覧":
      - /url: /orders
  - listitem:
    - link "明細":
      - /url: "#/orders/1042/lines"`;
    const shaped = formatAria(shapeAria(parseAria(yaml), { record: true }));
    expect(shaped).toBe(`- heading "…" [level=1]
- list:
  - listitem:
    - link "…":
      - /url: /customers/:id
  - listitem:
    - link "…":
      - /url: /customers
  - listitem:
    - link "受注一覧":
      - /url: /orders
  - listitem:
    - link "…":
      - /url: "#/orders/:id/lines"`);
    expect(formatAria(shapeAria(parseAria(yaml)))).toContain('- heading "受注 1042 鈴木商事" [level=1]');
  });

  it("knows codes and query ids for records, but not hosts", () => {
    expect(["C001", "ORD-2026-001", "2026-10-15", "1042"].filter(isIdSegment)).toEqual(["C001", "ORD-2026-001", "2026-10-15", "1042"]);
    expect(["v2", "step3", "new", "edit", "oauth2"].some(isIdSegment)).toBe(false);
    expect(toRecord("http://192.168.1.10/orders")).toBe(false);
    expect(toRecord("http://app01.example.com:8080/orders?page=12")).toBe(false);
    expect(toRecord("http://app01/orders/detail?id=1042")).toBe(true);
    expect(toRecord("http://app01/customers/C001")).toBe(true);
    expect(urlShape("http://192.168.1.10/customers/C001?tab=2")).toBe("http://192.168.1.10/customers/:id");
  });

  it("hides cards, description lists, addresses and links named by their query", () => {
    const yaml = `- article:
  - heading "山田 花子" [level=3]
  - button "編集"
- term: メール
- definition:
  - link "tanaka@example.com":
    - /url: mailto:tanaka@example.com
- link "03-1234-5678":
  - /url: tel:0312345678
- link "鈴木商事の受注":
  - /url: /orders?customer=鈴木商事の受注
- link "詳細":
  - /url: javascript:void(0)
- img "山田 花子"`;
    const shaped = formatAria(shapeAria(parseAria(yaml)));
    expect(shaped).toContain('- article:\n  - heading "…" [level=3]\n  - button "編集"');
    expect(shaped).toContain('- definition:\n  - link "…"\n');
    expect(shaped).toContain('- link "…"\n- link "…":\n  - /url: /orders\n');
    expect(shaped).toContain('- link "詳細":\n  - /url: javascript:void(0)');
    expect(shaped).not.toMatch(/tanaka|0312|鈴木/);
    expect(shaped).toContain('- img "山田 花子"');
    // a record's page: its images may show it too
    expect(formatAria(shapeAria(parseAria(yaml), { record: true }))).toContain('- img "…"');
  });

  it("measures how alike names are", () => {
    expect(likeness("登録", "登録")).toBe(1);
    expect(likeness("ＯＫ", "ok")).toBe(1);
    expect(likeness("保存", "保存する")).toBe(0.8);
    expect(likeness("受注登録", "受注の登録")).toBeGreaterThan(0.5);
    expect(likeness("保存", "登録")).toBe(0);
  });
});

describe("expected changes as lines", () => {
  it("reads verification lines for expectDbChanges", () => {
    const { expect: e, problems } = parseExpectedLines(["- orders: 追加 1 行 (customer_id=7)", "ほかの表: 問わない"]);
    expect(problems).toEqual([]);
    expect(Object.keys(e.expected)).toEqual(["orders"]);
    expect(e.unlisted).toBe("any");
    expect(expectationOf("orders: inserted 1 row").unlisted).toBe("unchanged");
    expect(() => expectationOf(["orders: added a row"])).toThrow("expected changes can't be read:\n  line 1: ");
  });
});

describe("generated test code", () => {
  const code = (line: string) => actionCode(actions([`- ${line}`]).actions![0]!);

  it("finds elements as verify --auto does", () => {
    expect(code("開く: /orders")).toEqual(['await page.goto("/orders");']);
    expect(code("押す: 登録")).toEqual(['await clickable(page, "登録").click();']);
    expect(code("押す: 取消 (「1042」の行)")).toEqual(['await clickable(page.getByRole("row").filter({ hasText: "1042" }), "取消").click();']);
    // header rows (no data cell) don't count
    expect(code("押す: (最初の行)")).toEqual(['await page.getByRole("row").filter({ has: page.locator("td, [role=cell], [role=gridcell]") }).first().click();']);
    // fields without a name, by their role
    expect(code("入力: spinbutton = 2 (「P001」の行)")).toEqual(['await page.getByRole("row").filter({ hasText: "P001" }).getByRole("spinbutton").fill("2");']);
    expect(code("選ぶ: リストボックス = 山田商事")).toEqual(['await ofRoles(page, ["combobox", "listbox"]).selectOption("山田商事");']);
    expect(code("確認: textbox = 至急 (最後の行)")).toEqual(['await expect(page.getByRole("row").filter({ has: page.locator("td, [role=cell], [role=gridcell]") }).last().getByRole("textbox")).toHaveValue("至急");']);
    expect(code("押す: 文字「次へ」")).toEqual(['await page.getByText("次へ", { exact: true }).click();']);
    expect(code("入力: 数量 = 3")).toEqual(['await field(page, "数量").fill("3");']);
    expect(code("選ぶ: 得意先 = 鈴木商事")).toEqual(['await field(page, "得意先").selectOption("鈴木商事");']);
    expect(code("チェック: 在庫不足のみ")).toEqual(['await checkable(page, "在庫不足のみ").check();']);
    expect(code("キー: Enter")).toEqual(['await page.keyboard.press("Enter");']);
    expect(code("待つ: 1 秒")).toEqual(["await page.waitForTimeout(1000);"]);
    expect(code("待つ: 「完了」が表示される")).toEqual(['await expect(page.getByText("完了").locator("visible=true").first()).toBeVisible({ timeout: 30000 });']);
    expect(code("確認: 「エラー」が表示されない")).toEqual(['await expect(page.getByText("エラー").locator("visible=true")).toHaveCount(0);']);
    expect(code("確認: 数量 = 3")).toEqual(['await expect(field(page, "数量")).toHaveValue("3");']);
    expect(code("ダイアログ: キャンセル")).toEqual(["dialogs.push(false); // ダイアログ: キャンセル"]);
  });

  const FILE = `# 受注の登録

## 1. 受注を登録する

操作:
- 開く: /orders/new
- 選ぶ: 得意先 = 鈴木商事
- 押す: 登録
- 確認: 「登録しました」が表示される

期待する DB の変化:
- orders: 追加 1 行 (customer_id=7)
- ほかの表: 問わない

## 2. 夜間バッチを流す

管理者がバッチを実行する。

期待する DB の変化:
- stock: 更新 1 行 (item_id=3) → (qty=0)

## 3. 一覧を見る

操作:
- 開く: /orders
`;

  it("makes a Playwright test of a verification", () => {
    const test = exportTest(parseVerifyFile(FILE, "ja"), { fileName: "checks/受注.verify.md", app: "http://localhost:5173", ignoreColumns: ["updated_at"], storageState: ".ashiato/login.json" });
    expect(test.automated).toBe(2);
    expect(test.manual).toEqual(["2. 夜間バッチを流す"]);
    expect(test.code.startsWith(`${EXPORTED_HEADER} from checks/受注.verify.md:`)).toBe(true);
    expect(test.code).toContain('import { test, expect } from "ashiato/playwright";\nimport type { Locator, Page } from "@playwright/test";');
    expect(test.code).toContain('test.use({\n  baseURL: "http://localhost:5173",\n  storageState: ".ashiato/login.json", // the login saved by `ashiato verify --auto --login`\n  ashiato: { ignoreColumns: ["updated_at"] },\n});');
    expect(test.code).toContain("const clickable = ");
    expect(test.code).toContain("const field = ");
    expect(test.code).not.toContain("const checkable = ");
    expect(test.code).toContain(`test("受注の登録", async ({ page, expectDbChanges }) => {`);
    expect(test.code).toContain(
      [
        '  await test.step("1. 受注を登録する", async () => {',
        "    await expectDbChanges(async () => {",
        '      await page.goto("/orders/new");',
        '      await field(page, "得意先").selectOption("鈴木商事");',
        '      await clickable(page, "登録").click();',
        '      await expect(page.getByText("登録しました").locator("visible=true").first()).toBeVisible();',
        "    }, [",
        '      "orders: 追加 1 行 (customer_id=7)",',
        '      "ほかの表: 問わない",',
        "    ]);",
        "  });",
        "",
        "  // 2. 夜間バッチを流す: a person does this step (it has no actions), so the test leaves it out. TODO:",
        "  //   管理者がバッチを実行する。",
        "  //   expected: stock: 更新 1 行 (item_id=3) → (qty=0)",
        "",
        '  await test.step("3. 一覧を見る", async () => {',
        "    // no expected changes written: what changes isn't checked",
        '    await page.goto("/orders");',
        "  });",
        "});",
      ].join("\n"),
    );
  });

  it("doesn't carry dialog answers to the next step, and keeps comments on one line", () => {
    const file = parseVerifyFile(
      "# t\n\n## 1. a\n\n操作:\n- ダイアログ: キャンセル\n- 押す: 削除\n\n## 2. b\n\n操作:\n- 押す: 保存\n\n## 3. 人が行う\n\n夜間バッチ\u2028を流す\n",
      "ja",
    );
    const { code } = exportTest(file, { fileName: "t.verify.md" });
    expect(code).toContain('  await test.step("1. a", async () => {\n    // no expected');
    expect(code).toContain('  await test.step("2. b", async () => {\n    dialogs.length = 0;\n');
    expect(code).toContain("  //   夜間バッチ を流す\n");
    expect(code).not.toMatch(/[\u2028\u2029]/);
  });

  describe("ashiato export-tests", () => {
    const logs: string[] = [];
    afterEach(() => {
      vi.restoreAllMocks();
      logs.length = 0;
      process.exitCode = undefined;
    });
    const capture = () => {
      vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
      vi.spyOn(console, "error").mockImplementation((m: string) => void logs.push(m));
    };

    it("writes a test for each verification, and none for a file with problems", async () => {
      capture();
      const dir = mkdtempSync(join(tmpdir(), "ashiato-export-"));
      const checks = join(dir, "checks");
      mkdirSync(checks);
      writeFileSync(join(checks, "受注.verify.md"), FILE);
      writeFileSync(join(checks, "誤り.verify.md"), "# x\n\n## 1. a\n\n操作:\n- 消す: 受注\n");
      writeFileSync(join(checks, "人だけ.verify.md"), "# x\n\n## 1. a\n\nバッチを流す\n");
      const out = join(dir, "tests", "e2e");
      await main(["export-tests", checks, "--out", out, "--lang", "ja"]);
      expect(readFileSync(join(out, "受注.spec.ts"), "utf8")).toContain('await test.step("1. 受注を登録する"');
      const said = logs.join("\n");
      expect(said).toMatch(/Wrote .*受注\.spec\.ts \(2 step\(s\); 1 step\(s\) a person does left out as TODO: 2\. 夜間バッチを流す\)/);
      expect(said).toMatch(/誤り\.verify\.md:6: 「消す」は操作の種類ではありません。/);
      expect(said).toMatch(/人だけ\.verify\.md: not exported: no step has actions/);
      expect(process.exitCode).toBe(1);

      // a test changed by hand isn't overwritten
      writeFileSync(join(out, "受注.spec.ts"), "// mine\n");
      await main(["export-tests", join(checks, "受注.verify.md"), "--out", out]);
      expect(readFileSync(join(out, "受注.spec.ts"), "utf8")).toBe("// mine\n");
      expect(logs.join("\n")).toContain("kept: it isn't a file export-tests wrote");
      await main(["export-tests", join(checks, "受注.verify.md"), "--out", join(out, "受注.spec.ts"), "--force"]);
      expect(readFileSync(join(out, "受注.spec.ts"), "utf8")).toContain(EXPORTED_HEADER);
    });

    it("checks its options", async () => {
      await expect(main(["export-tests"])).rejects.toThrow("Usage: ashiato export-tests");
      await expect(main(["export-tests", "x", "--app", "localhost"])).rejects.toThrow("--app takes the app's URL");
    });
  });
});
