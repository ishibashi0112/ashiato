import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/adapters/index.js";
import type { DbAdapter } from "../src/adapters/types.js";
import { fileProblemsReport, runVerify, verifyReport, type VerifyOptions } from "../src/chat/verify.js";
import { expectedValue, parseVerifyFile } from "../src/chat/verifyFile.js";
import { main } from "../src/cli/main.js";
import type { Diff, TableDiff } from "../src/core/types.js";
import { ChangeBy, matchChanges, OTHER_COLUMNS, type ExpectedChanges, type WatchedTable } from "../src/testing/match.js";
import { createAppDb } from "./helpers.js";

const ORDER = `# 受注登録の動作検証

受注を 1 件登録して、取り消します。

## 1. 受注を登録する

1. 受注画面で得意先 7、数量 10 を入れる
2. 「登録」を押す

期待する DB の変化:
- orders: 追加 1 行 (customer_id=7, qty=10)
- stock: 更新 1 行 (item_id=3) → (qty-=10)
- ほかの表: 変化なし

## 2. 一覧を開く

## 3. 受注を取り消す

**期待する DB の変化:**
- orders: 削除 1 行 (customer_id=7)
- stock: 更新 (item_id=3) → (qty+=10, ...)
`;

describe("parseVerifyFile", () => {
  it("reads the steps, what to do and the expected changes", () => {
    const file = parseVerifyFile(ORDER, "ja");
    expect(file.problems).toEqual([]);
    expect(file.title).toBe("受注登録の動作検証");
    expect(file.intro).toBe("受注を 1 件登録して、取り消します。");
    expect(file.steps.map((s) => [s.title, s.line])).toEqual([
      ["1. 受注を登録する", 5],
      ["2. 一覧を開く", 15],
      ["3. 受注を取り消す", 17],
    ]);
    const [register, list, cancel] = file.steps;
    expect(register!.body).toBe("1. 受注画面で得意先 7、数量 10 を入れる\n2. 「登録」を押す");
    expect(register!.expect!.lines).toEqual(["orders: 追加 1 行 (customer_id=7, qty=10)", "stock: 更新 1 行 (item_id=3) → (qty-=10)", "ほかの表: 変化なし"]);
    expect(register!.expect!.unlisted).toBe("unchanged");
    const { orders, stock } = register!.expect!.expected;
    expect(Object.keys(orders!)).toEqual(["inserted"]);
    const inserted = orders!.inserted as Record<string, { toAsymmetricMatcher(): string }>[];
    expect(inserted.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.toAsymmetricMatcher()])))).toEqual([{ customer_id: "7", qty: "10" }]);
    const update = (stock!.updated as { where: object; set: Record<string | symbol, unknown> }[])[0]!;
    expect(update.set.qty).toEqual(new ChangeBy("-10"));
    expect(OTHER_COLUMNS in update.set).toBe(false);
    // a step without expected changes is shown, not checked
    expect(list!.expect).toBeUndefined();
    // the line above the changes may be in bold; ... lets other columns change
    expect(OTHER_COLUMNS in (cancel!.expect!.expected.stock!.updated as readonly { set: object }[])[0]!.set).toBe(true);
  });

  it("reads counts, unchanged tables, other tables and English", () => {
    const file = parseVerifyFile(
      [
        "## Save",
        "Expected changes:",
        "* dbo.orders: inserted 2 rows",
        "- [dbo].[lines]: inserted 3 rows (order_id=*)",
        "- dbo.lines: inserted (order_id=*, note='a, b')",
        "- stock: no changes",
        "- audit: updated 2 rows",
        "- other tables: any",
        "## Nothing happens",
        "### Expected changes",
        "- no changes",
      ].join("\n"),
      "en",
    );
    expect(file.problems).toEqual([]);
    const [save, nothing] = file.steps;
    const e = save!.expect!.expected;
    expect(e["dbo.orders"]).toEqual({ inserted: 2 });
    expect((e["dbo.lines"]!.inserted as object[]).length).toBe(4);
    expect(e.stock).toEqual({});
    expect(e.audit).toEqual({ updated: 2 });
    expect(save!.expect!.unlisted).toBe("any");
    expect(nothing!.expect).toEqual({ lines: ["no changes"], expected: {}, unlisted: "unchanged" });
    expect(parseVerifyFile("## 1\n期待:\n- orders: 削除 ２ 行\n", "ja").steps[0]!.expect!.expected).toEqual({ orders: { deleted: 2 } });
  });

  it("doesn't take headings in a code block as steps", () => {
    const file = parseVerifyFile("## 1. 入力する\n```\n## not a step\n```\n期待:\n- 変化なし\n", "ja");
    expect(file.problems).toEqual([]);
    expect(file.steps).toHaveLength(1);
    expect(file.steps[0]!.body).toBe("```\n## not a step\n```");
  });

  it("lists what is wrong, by line", () => {
    const problems = (text: string) => parseVerifyFile(text, "ja").problems.map((p) => `${p.line}: ${p.message}`);
    expect(problems("手順の説明だけ")).toEqual(["1: 手順がありません。手順ごとに「## 1. すること」の見出しを付けてください。"]);
    expect(
      problems(
        [
          "## 1. 登録",
          "期待する DB の変化:",
          "- orders: 登録 1 行",
          "- orders: 追加 1 行 (customer_id=7",
          "- orders: 追加 (qty+=1)",
          "- orders: 削除 1 行 → (qty=1)",
          "- orders: 追加 1 行 (qty=1, ...)",
          "- orders: 追加",
          "- orders 追加 1 行",
          "- ほかの表: そのまま",
          "メモ: 画面も見る",
          "- stock: 更新 1 行 (item_id=3) → (qty+=x)",
          "- stock: 更新 1 行 (item_id=3) qty=1",
        ].join("\n"),
      ),
    ).toEqual([
      "3: 「登録」は変化の種類ではありません。追加・更新・削除か、「変化なし」と書いてください。",
      "4: 括弧か引用符が閉じていません。",
      "5: 「列+=数」「列-=数」(増減)を書けるのは、更新の → の後の列だけです。",
      "6: 「→ (更新後の列)」を書けるのは更新だけです。",
      "7: 「...」(ほかの列も変わってよい)を書けるのは、更新の → の後の列だけです。",
      "8: 行数は「1 行」のように書いてください(列の値を書くときは 1 行以上)。",
      expect.stringMatching(/^9: 「表名: 追加 1 行 \(列=値, \.\.\.\)」/),
      "10: 書いていない表については「ほかの表: 変化なし」か「ほかの表: 問わない」と書いてください。",
      "11: 期待する変化は 1 行に 1 つ、「- 」で始めて書いてください。",
      "12: 「qty+=x」: += か -= の後には数を書いてください。",
      "13: 列の値は「(列=値, 列=値)」のように括弧で囲んで書いてください。",
    ]);
    expect(problems("## 1\n- 変化なし\n- orders: 追加 1 行")).toEqual([expect.stringMatching(/^3: 期待する変化の行の前に「期待する DB の変化:」の 1 行を書いてください/)]);
    expect(problems("## 1\n期待:\n- 変化なし\n- orders: 追加 1 行")).toEqual(["3: 手順全体の「変化なし」は、ほかの行と一緒に書けません。"]);
    expect(problems("## 1\n期待:\n- orders: 変化なし\n- ORDERS: 削除 1 行")).toEqual(["3: orders を「変化なし」と、変化する表の両方に書いています。"]);
  });

  it("says when expected changes have no line above them (they would not be checked)", () => {
    const file = parseVerifyFile("## 1. 登録\n「登録」を押す\n\n- orders: 追加 1 行 (customer_id=7)\n", "en");
    expect(file.problems).toEqual([{ line: 4, message: expect.stringContaining("Write `Expected changes:` on the line before") }]);
  });
});

describe("expectedValue", () => {
  const fits = (written: string, actual: string | number | boolean | null) => expectedValue(written).asymmetricMatch(actual);

  it("compares values as a person reads them", () => {
    expect(fits("C001", "C001")).toBe(true);
    expect(fits("C001", "C001      ")).toBe(true); // CHAR(10)
    expect(fits("C001", "C002")).toBe(false);
    expect(fits("10", 10)).toBe(true);
    expect(fits("10", "10.00")).toBe(true); // a decimal read as text
    expect(fits("1.5", 1.5)).toBe(true);
    expect(fits("0001", "0001")).toBe(true);
    expect(fits("1", "0001")).toBe(false); // a code is not a number
    expect(fits("1", true)).toBe(true); // a bit column
    expect(fits("0", false)).toBe(true);
    expect(fits("1", false)).toBe(false);
    expect(fits("NULL", null)).toBe(true);
    expect(fits("NULL", "NULL")).toBe(false);
    expect(fits("'NULL'", "NULL")).toBe(true);
    expect(fits("C001", null)).toBe(false);
    expect(fits("*", null)).toBe(true);
    expect(fits("*", "x")).toBe(true);
    expect(fits("'a, b'", "a, b")).toBe(true);
    expect(fits("'it''s'", "it's")).toBe(true);
  });

  it("compares dates by day, and times as the database gives them", () => {
    expect(fits("2026-10-13", "2026-10-13T09:30:00.000Z")).toBe(true);
    expect(fits("2026/10/13", "2026-10-13 09:30:00")).toBe(true);
    expect(fits("2026-10-13", "2026-10-14T00:00:00.000Z")).toBe(false);
    expect(fits("2026-10-13 9:30", "2026-10-13T09:30:00.000Z")).toBe(true);
    expect(fits("2026-10-13 09:30:00", "2026-10-13 09:30:00")).toBe(true);
    expect(fits("2026-10-13 09:31", "2026-10-13T09:30:00.000Z")).toBe(false);
  });
});

describe("matchChanges for verify", () => {
  const stock: TableDiff = {
    table: { name: "stock" },
    key: ["item_id"],
    inserted: [],
    updated: [{ key: { item_id: 3 }, before: { item_id: 3, qty: "50.5", at: "a" }, after: { item_id: 3, qty: 40, at: "b" }, changed: ["qty", "at"] }],
    deleted: [],
  };
  const log: TableDiff = { table: { name: "audit_log" }, key: [], inserted: [{ message: "x" }], updated: [], deleted: [] };
  const diff = (...tables: TableDiff[]): Diff => ({ from: "", to: "", tables });
  const watched: WatchedTable[] = [{ table: stock.table }, { table: log.table }];
  const problems = (e: ExpectedChanges, unlisted?: "any") => {
    const r = matchChanges(diff(stock, log), e, watched, unlisted ? { unlisted } : {});
    return r.ok ? [] : r.problems;
  };
  const update = (set: object) => ({ stock: { updated: [{ where: { item_id: 3 }, set }] } });

  it("checks a change by an amount exactly, and lets other columns change when asked", () => {
    expect(problems(update({ qty: new ChangeBy("-10.5"), [OTHER_COLUMNS]: true }), "any")).toEqual([]);
    expect(problems(update({ qty: new ChangeBy("-10"), [OTHER_COLUMNS]: true }), "any")).toEqual([
      expect.stringContaining('set qty: expected a change by -10, got "50.5" → 40'),
    ]);
    expect(problems(update({ qty: new ChangeBy("-10.5") }), "any")).toEqual([expect.stringContaining('at also changed: "a" → "b"')]);
    expect(problems(update({ qty: new ChangeBy("-10.5"), at: "b" }), "any")).toEqual([]);
  });

  it("lets tables not listed change when asked", () => {
    const e = update({ qty: 40, [OTHER_COLUMNS]: true });
    expect(problems(e, "any")).toEqual([]);
    expect(problems(e)).toEqual([expect.stringContaining("audit_log changed (1 inserted), but the expectation doesn't list it")]);
  });

  it("shows `…` for an update that lets other columns change", () => {
    const r = matchChanges(diff(stock), { stock: { updated: [{ where: { item_id: 4 }, set: { [OTHER_COLUMNS]: true } }] } }, watched);
    expect(r.ok ? "" : r.problems[0]).toContain("expected { where: { item_id: 4 }, set: { … } }");
  });
});

describe("runVerify", () => {
  let db: DbAdapter | undefined;
  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  /** Answers the prompts in turn; an answer may first change the database, as the person's app would. */
  const script = (answers: (string | (() => string))[]): Pick<VerifyOptions, "ask" | "log"> & { logs: string[]; prompts: string[] } => {
    const logs: string[] = [];
    const prompts: string[] = [];
    return {
      logs,
      prompts,
      ask: async (prompt) => {
        prompts.push(prompt);
        const a = answers.shift();
        return a === undefined ? null : typeof a === "function" ? a() : a;
      },
      log: (m) => void logs.push(m),
    };
  };

  it("takes the person through the steps and checks each one", async () => {
    const app = createAppDb();
    db = await connect(`sqlite:${app.file}`);
    const file = parseVerifyFile(ORDER, "ja");
    const io = script([
      () => {
        app.db.exec("INSERT INTO orders VALUES (1, 7, 10, '2026-10-13'); UPDATE stock SET qty = 40 WHERE item_id = 3");
        return "";
      },
      () => {
        app.db.exec("INSERT INTO audit_log VALUES ('opened')");
        return "一覧に 1 件出た";
      },
      // the app deletes the order but forgets the stock; the person checks again once it's fixed
      () => {
        app.db.exec("DELETE FROM orders WHERE id = 1");
        return "";
      },
      () => {
        app.db.exec("UPDATE stock SET qty = 50 WHERE item_id = 3");
        return "r";
      },
    ]);
    const run = await runVerify(db, file, { lang: "ja", timeout: 300, settleMs: 50, pollMs: 20, ...io });
    expect(run.problems).toBeUndefined();
    expect(run.tables.map((t) => t.name).sort()).toEqual(["audit_log", "orders", "stock"]);
    expect(run.outcomes.map((o) => [o.verdict, o.memo, o.checks])).toEqual([
      ["ok", undefined, 1],
      ["unchecked", "一覧に 1 件出た", 1],
      ["ok", undefined, 2],
    ]);
    expect(io.logs.join("\n")).toContain("── 手順 1/3: 1. 受注を登録する");
    expect(io.logs.join("\n")).toContain("✗ NG: 期待と違います");

    const md = verifyReport(file, run, { fileName: "checks/受注登録.verify.md", dialect: "sqlite", lang: "ja" });
    expect(md).toContain("# 動作検証の結果: 受注登録の動作検証");
    expect(md).toContain("`checks/受注登録.verify.md` の手順を人が操作し、SQLite の変化を `ashiato verify` が期待と照合した結果です(");
    expect(md).toContain("結果: OK 2 / 照合なし 1");
    expect(md).toContain("| 2. 一覧を開く | 照合なし | 一覧に 1 件出た |");
    expect(md).toContain("**orders** 追加 1 行\n\n| id | customer_id | qty | updated_at |\n| --- | --- | --- | --- |\n| 1 | 7 | 10 | 2026-10-13 |");
    expect(md).toContain("**stock** 更新 1 行\n\n| item_id | 変わった列 |\n| --- | --- |\n| 3 | qty: 50 → 40 |");
    expect(md).toContain("## 3. 受注を取り消す — OK");
    // the last check is the one reported: the changes found, not the differences of the first check
    expect(md).not.toContain("期待との違い");
  });

  it("reports NG with the differences, and the steps skipped or not done", async () => {
    const app = createAppDb();
    db = await connect(`sqlite:${app.file}`);
    const file = parseVerifyFile(ORDER, "en");
    const io = script([
      () => {
        app.db.exec("INSERT INTO orders VALUES (1, 8, 10, '2026-10-13'); UPDATE stock SET qty = 41 WHERE item_id = 3");
        return "saved twice?";
      },
      "",
      "s",
      // input ends: the rest is not done
    ]);
    const run = await runVerify(db, file, { lang: "en", timeout: 200, settleMs: 50, pollMs: 20, ...io });
    expect(run.outcomes.map((o) => [o.verdict, o.memo])).toEqual([
      ["ng", "saved twice?"],
      ["skipped", undefined],
      ["not-run", undefined],
    ]);
    const md = verifyReport(file, run, { fileName: "order.verify.md", dialect: "sqlite", lang: "en" });
    expect(md).toContain("Result: NG 1 / skipped 1 / not done 1");
    expect(md).toMatch(/## 1\. 受注を登録する — NG\n\nNote from the person: saved twice\?\n\nExpected changes:\n- orders: 追加 1 行/);
    expect(md).toMatch(/How the changes differ:\n\n```text\norders: 1 inserted row found, but not the expected ones[\s\S]*customer_id: expected 7, got 8[\s\S]*set qty: expected a change by -10, got 50 → 41/);
    expect(md).not.toMatch(/\n\n\n/);
    expect(md).toContain("## 3. 受注を取り消す — not done");
  });

  it("starts nothing when the file names a table the database doesn't have", async () => {
    const app = createAppDb();
    db = await connect(`sqlite:${app.file}`);
    const file = parseVerifyFile("## 1\n期待:\n- order: 追加 1 行\n", "ja");
    const io = script([]);
    const run = await runVerify(db, file, { lang: "ja", ...io });
    expect(run.problems).toEqual([expect.stringContaining('"order" is not a watched table (watched: audit_log, orders, stock)')]);
    expect(run.outcomes).toEqual([]);
    expect(io.prompts).toEqual([]);
    expect(fileProblemsReport(file, run.problems!, { fileName: "a.verify.md", lang: "ja" })).toContain("`a.verify.md` の内容に次の問題があるため、`ashiato verify` は始めていません。");
  });
});

describe("ashiato verify", () => {
  const logs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
    process.exitCode = undefined;
  });
  const capture = () => {
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    vi.spyOn(console, "error").mockImplementation((m: string) => void logs.push(m));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  };

  it("checks the steps with what is typed, and writes the results", async () => {
    capture();
    const app = createAppDb();
    const dir = mkdtempSync(join(tmpdir(), "ashiato-verify-"));
    const path = join(dir, "open.verify.md");
    writeFileSync(path, "# 開く\n\n## 1. 一覧を開く\n\n期待する DB の変化:\n- 変化なし\n");
    vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["見た\n"]) as unknown as typeof process.stdin);
    const out = join(dir, "result.md");
    await main(["verify", path, "--db", `sqlite:${app.file}`, "--lang", "ja", "--no-clip", "--out", out]);
    expect(readFileSync(out, "utf8")).toContain("| 1. 一覧を開く | OK | 見た |");
    expect(logs.join("\n")).toContain("OK 1");
    expect(process.exitCode).toBeUndefined();
  });

  it("sends back what to correct, and checks nothing, when the file has problems", async () => {
    capture();
    const app = createAppDb();
    const dir = mkdtempSync(join(tmpdir(), "ashiato-verify-"));
    const path = join(dir, "bad.verify.md");
    writeFileSync(path, "## 1. 登録\n期待:\n- orders: 登録 1 行\n");
    const out = join(dir, "result.md");
    await main(["verify", path, "--db", `sqlite:${app.file}`, "--lang", "ja", "--no-clip", "--out", out]);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(out, "utf8")).toContain("- 3 行目: 「登録」は変化の種類ではありません。");
    expect(logs.join("\n")).toContain("Nothing was checked: the file needs correcting.");
  });

  it("checks its options", async () => {
    await expect(main(["verify", "--db", "sqlite::memory:"])).rejects.toThrow("Usage: ashiato verify");
    await expect(main(["verify", "a.verify.md"])).rejects.toThrow("--db <url>");
  });
});
