import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packMarkdown, pageActions, pagePath, testTitles, type PackParts } from "../src/chat/pack.js";
import { main } from "../src/cli/main.js";
import { schemaSections } from "../src/chat/schema.js";
import type { DbAdapter } from "../src/adapters/types.js";
import type { Session } from "../src/core/types.js";
import { createAppDb } from "./helpers.js";
import { sampleSession } from "./fixtures/session.js";

describe("pagePath", () => {
  it("makes pages that differ by an id one page, and leaves queries out", () => {
    expect(pagePath("http://x/orders/1042?tab=2")).toBe("/orders/:id");
    expect(pagePath("/orders/1042/lines/3", "http://x")).toBe("/orders/:id/lines/:id");
    expect(pagePath("http://x/items/0b6f6c2e-2a1b-4c3d-9e8f-0123456789ab/edit")).toBe("/items/:id/edit");
    expect(pagePath("http://x/app/#/orders/7?x=1")).toBe("/app/#/orders/:id");
    // a plain anchor isn't a route
    expect(pagePath("http://x/help#top")).toBe("/help");
    expect(pagePath("/orders/new")).toBe("/orders/new");
  });
});

describe("pageActions", () => {
  it("collects what each page's actions changed, without values", () => {
    const session = sampleSession();
    // the browser marks a button's caption as the app's wording
    session.steps[0]!.action!.caption = true;
    const again = structuredClone(session);
    again.id = "s2";
    // the same action changing a different number of rows
    again.steps[0]!.diff.tables[0]!.inserted.push({ id: 1043, customer: "x", qty: 1 });
    again.steps[0]!.action!.page = "/orders/new?copy=1042";
    const link: Session = {
      ...structuredClone(session),
      id: "s3",
      steps: [
        {
          id: 1,
          label: 'click link "山田 太郎"',
          at: session.startedAt,
          action: { type: "click", target: 'link "山田 太郎"', page: "/customers", tab: "t", startedAt: session.startedAt, requests: [{ kind: "http", method: "GET", url: "/api/customers/12?name=%E5%B1%B1%E7%94%B0" }] },
          diff: { from: session.startedAt, to: session.startedAt, tables: [] },
          durationMs: 1,
        },
      ],
    };
    const actions = pageActions([session, again, link], "ja");
    expect(actions).toEqual([
      { page: "/customers", action: "click link", requests: ["GET /api/customers/:id"], changes: ["変化なし"], times: 1 },
      { page: "/orders/:id", action: "click button", requests: ["WebView2 orders.delete"], changes: ["dbo.orders -1"], times: 2 },
      {
        page: "/orders/new",
        action: 'click button "保存"',
        requests: ["POST /api/orders", "GET /api/orders"],
        changes: ["dbo.orders +1, dbo.stock ~1 (qty↓)", "dbo.orders +2, dbo.stock ~1 (qty↓)"],
        times: 2,
      },
    ]);
    expect(JSON.stringify(actions)).not.toMatch(/山田|1042|太郎/);
  });
});

describe("testTitles", () => {
  it("reads the titles of a test file's tests and groups", () => {
    const code = [
      'test.describe("受注", () => {',
      "  test('登録する', async ({ page }) => {",
      '    await test.step("開く", async () => {});',
      "  });",
      '  test.skip(`取り消す "1 件"`, async () => {});',
      '  test.fixme("it\\"s", async () => {});',
      "});",
      'latest("not a test");',
    ].join("\n");
    expect(testTitles(code)).toEqual(["受注", "登録する", "開く", '取り消す "1 件"', 'it\\"s']);
  });
});

describe("packMarkdown", () => {
  const tableLines = (name: string, n: number) => [`### ${name}`, "", "| Column | Type | Null |", "| --- | --- | --- |", ...Array.from({ length: n }, (_, i) => `| c${i} | INTEGER | NULL |`)];
  const parts = (over: Partial<PackParts> = {}): PackParts => ({
    lang: "en",
    app: "http://localhost:5173",
    dialect: "mssql",
    pages: [
      { path: "/", title: "Home", tree: '- heading "Home" [level=1]' },
      { path: "/orders", title: "Orders", tree: '- table:\n  - row:\n    - columnheader "No."\n' + "  - row:\n    - cell \"…\"\n".repeat(200) },
      { path: "/admin", redirected: "/login" },
      { path: "/broken", error: "net::ERR_CONNECTION_REFUSED" },
    ],
    actions: pageActions([sampleSession()], "en"),
    recordings: 1,
    tables: [
      { table: { schema: "dbo", name: "audit_log" }, isTable: true, lines: tableLines("dbo.audit_log", 5) },
      { table: { schema: "dbo", name: "orders" }, isTable: true, lines: tableLines("dbo.orders", 5) },
    ],
    tests: [{ file: "tests/orders.spec.ts", titles: ["orders", "enters\nan order"] }],
    code: { name: "repomix-output.xml", text: "x".repeat(20_000) },
    at: new Date("2026-10-15T01:00:00Z"),
    ...over,
  });

  it("puts the instructions, pages, recorded actions, tables, tests and code in that order", () => {
    const { markdown, left } = packMarkdown(parts());
    expect(left).toEqual({ pages: [], actions: [], tables: [], tests: 0 });
    const order = ["## What to write", "## Pages", "## What actions changed in the database (recorded)", "## Table definitions", "## Tests there are already", "## Code (repomix-output.xml)"];
    const at = order.map((h) => markdown.indexOf(h));
    expect(at.every((x) => x > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(markdown).toContain("database: SQL Server");
    expect(markdown).toContain("### /admin (went to /login)");
    expect(markdown).toContain("### /broken\n\nCould not be opened: net::ERR_CONNECTION_REFUSED");
    expect(markdown).toContain("| click button | POST /api/orders, GET /api/orders | dbo.orders +1, dbo.stock ~1 (qty↓) | 1 |");
    expect(markdown).toContain("Pages with nothing recorded: /, /orders.");
    // the tables the recordings changed come first
    expect(markdown.indexOf("### dbo.orders")).toBeLessThan(markdown.indexOf("### dbo.audit_log"));
    expect(markdown).toContain("- tests/orders.spec.ts: orders / enters an order");
    expect(markdown).not.toContain("山田");
  });

  it("leaves out the code, then tests, tables, recorded actions and the last pages to fit", () => {
    const whole = packMarkdown(parts()).markdown.length;
    const cut = packMarkdown(parts({ maxChars: whole - 5000 }));
    expect(cut.markdown.length).toBeLessThanOrEqual(whole - 5000);
    expect(cut.left.code).toBe("in part");
    expect(cut.markdown).toMatch(/\(cut: [\d,]+ more characters\)/);
    expect(cut.markdown).toContain("## Left out (did not fit)\n\n- The code, in part.");

    const small = packMarkdown(parts({ maxChars: 10_600 }));
    expect(small.markdown.length).toBeLessThanOrEqual(12_000);
    expect(small.left).toMatchObject({ code: "all of it", tests: 1, tables: ["dbo.orders", "dbo.audit_log"] });
    expect(small.markdown).not.toContain("## Code");
    expect(small.markdown).toContain("## What to write");

    // one page is always kept: the person makes another pack of the rest
    const tiny = packMarkdown(parts({ maxChars: 5000 }));
    expect(tiny.left.pages).toEqual(["/orders", "/admin", "/broken"]);
    expect(tiny.markdown).toContain("### / — Home");
    expect(tiny.markdown).toContain("- Pages: /orders, /admin, /broken. Make another pack of them with --pages.");
  });

  it("says when there are no recordings, in Japanese too", () => {
    const { markdown } = packMarkdown(parts({ lang: "ja", actions: [], recordings: 0, pageText: true }));
    expect(markdown).toContain("# このアプリの検証手順を書くための資料");
    expect(markdown).toContain("記録がまだありません。");
    expect(markdown).toContain("## お願いしたいこと");
    // with the pages' text kept, nothing says it was hidden
    expect(markdown).not.toContain("「…」に置き換えています");
  });
});

describe("table definitions in a pack", () => {
  it("doesn't say why a table can't be read when told not to (the MCP tool without --share-values)", async () => {
    const db = {
      dialect: "sqlite",
      listTables: async () => [{ name: "orders" }],
      describeTable: async () => {
        throw new Error("value 'Tanaka Taro' is not valid");
      },
      primaryKey: async () => [],
    } as unknown as DbAdapter;
    const hidden = await schemaSections(db, { lang: "en", views: false, errors: false });
    expect(hidden.unreadable).toEqual(["orders"]);
    expect(hidden.sections[0]!.lines.join("\n")).toBe("### orders\n\nCould not be read: (the database's message is not shown)");
    const shown = await schemaSections(db, { lang: "en", views: false });
    expect(shown.sections[0]!.lines.join("\n")).toContain("Tanaka Taro");
  });
});

describe("ashiato pack CLI", () => {
  const logs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });
  const capture = () => {
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
    vi.spyOn(console, "error").mockImplementation((m: string) => void logs.push(m));
  };

  it("packs the tables, the recordings and the tests there are", async () => {
    capture();
    const app = createAppDb();
    const dir = mkdtempSync(join(tmpdir(), "ashiato-pack-"));
    const sessions = join(dir, "sessions");
    mkdirSync(sessions);
    const session = sampleSession();
    session.dialect = "sqlite";
    session.tables = [{ name: "orders" }, { name: "stock" }];
    session.options = { ...session.options, ignoreColumns: ["updated_at"] };
    for (const s of session.steps) for (const t of s.diff.tables) delete (t.table as { schema?: string }).schema;
    writeFileSync(join(sessions, "2026-10-11T04-00-00-000Z.json"), JSON.stringify(session));
    writeFileSync(join(sessions, "notes.json"), "{}");
    const tests = join(dir, "tests");
    mkdirSync(join(tests, "e2e"), { recursive: true });
    writeFileSync(join(tests, "e2e", "orders.spec.ts"), 'test("enters an order", async () => {});');
    writeFileSync(join(tests, "受注.verify.md"), "# 受注の登録\n\n## 1. 登録する\n\n期待する DB の変化:\n- orders: 追加 1 行\n");
    const out = join(dir, "pack.md");
    await main(["pack", "--db", `sqlite:${app.file}`, "--sessions", sessions, "--tests", tests, "--lang", "ja", "--no-clip", "--out", out]);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("### /orders/new\n\n| 操作 | 通信 | DB の変化 | 回数 |");
    expect(md).toContain("| click button | POST /api/orders, GET /api/orders | orders +1, stock ~1 (qty↓) | 1 |");
    expect(md).toContain("## テーブル定義\n\n### orders");
    expect(md).toMatch(/- .*orders\.spec\.ts: enters an order/);
    expect(md).toMatch(/- .*受注\.verify\.md: 受注の登録 \/ 1\. 登録する/);
    expect(md).not.toContain("## 画面\n");
    // the chat is told which columns the recordings didn't count, and the person to verify the same way
    expect(md).toContain("記録では updated_at の変化を数えていません");
    expect(logs.join("\n")).toContain("run ashiato verify with --ignore-columns updated_at too.");
    expect(logs.join("\n")).toMatch(/Wrote .*pack\.md: 0 page\(s\), 2 recorded action\(s\) from 1 recording\(s\), 3 table\(s\);/);
  });

  it("checks its options", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ashiato-pack-"));
    await expect(main(["pack", "--sessions", empty])).rejects.toThrow("Nothing to pack");
    await expect(main(["pack", "--db", "sqlite:x.db", "--pages", "/a"])).rejects.toThrow("--pages needs --app <url>");
    await expect(main(["pack", "--db", "sqlite:x.db", "--page-text"])).rejects.toThrow("--page-text needs --app <url>");
    await expect(main(["pack", "--db", "sqlite:x.db", "--max-chars", "100"])).rejects.toThrow("--max-chars takes a number");
    await expect(main(["pack", "--db", "http://x"])).rejects.toThrow("Unsupported database URL: http:");
    await expect(main(["pack", "x.md"])).rejects.toThrow("ashiato pack takes no files");
  });
});
