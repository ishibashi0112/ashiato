import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/adapters/index.js";
import { columnKind, firstRows, formatsOf, isHidden, parseDataRules, shapeOf, standIn } from "../src/chat/profile.js";
import { schemaMarkdown } from "../src/chat/schema.js";
import { main } from "../src/cli/main.js";

describe("data profile helpers", () => {
  it("knows each database's types", () => {
    expect(["int", "decimal(10,2)", "bit", "datetime2(3)", "nvarchar(20)", "nvarchar(max)", "uniqueidentifier", "timestamp", "ntext"].map((t) => columnKind("mssql", t))).toEqual([
      "number",
      "number",
      "flag",
      "date",
      "string",
      "text",
      "other",
      "opaque",
      "opaque",
    ]);
    expect(["NUMBER(10,2)", "DATE", "TIMESTAMP(6) WITH TIME ZONE", "VARCHAR2(20 BYTE)", "CHAR(1 CHAR)", "CLOB", "LONG", "BLOB"].map((t) => columnKind("oracle", t))).toEqual([
      "number",
      "date",
      "date",
      "string",
      "string",
      "text",
      "skip",
      "opaque",
    ]);
    expect(["integer", "numeric(38,18)", "boolean", "timestamp(6) without time zone", "character varying(20)", "text", "uuid", "jsonb"].map((t) => columnKind("postgres", t))).toEqual([
      "number",
      "number",
      "flag",
      "date",
      "string",
      "string",
      "other",
      "opaque",
    ]);
    expect(["int unsigned", "decimal(38,18)", "bit(1)", "datetime(6)", "varchar(20)", "enum('a','b')", "longtext", "json"].map((t) => columnKind("mysql", t))).toEqual([
      "number",
      "number",
      "flag",
      "date",
      "string",
      "string",
      "text",
      "opaque",
    ]);
    expect(["INTEGER", "NUMERIC(10,2)", "TEXT", "VARCHAR(20)", "DATE", "BOOLEAN", "BLOB", ""].map((t) => columnKind("sqlite", t))).toEqual([
      "number",
      "number",
      "string",
      "string",
      "date",
      "flag",
      "opaque",
      "other",
    ]);
  });

  it("writes the first rows in each database's words", () => {
    expect(firstRows("mssql", "*", "[dbo].[T]", 5)).toBe("SELECT TOP (5) * FROM [dbo].[T]");
    expect(firstRows("oracle", "*", '"O"."T"', 5)).toBe('SELECT * FROM "O"."T" WHERE ROWNUM <= 5');
    expect(firstRows("oracle", "a", '"O"."T"', 5, '"ID" DESC')).toBe('SELECT * FROM (SELECT a FROM "O"."T" ORDER BY "ID" DESC) WHERE ROWNUM <= 5');
    expect(firstRows("postgres", "*", 'ONLY "public"."t"', 5, '"id" DESC')).toBe('SELECT * FROM ONLY "public"."t" ORDER BY "id" DESC LIMIT 5');
  });

  it("turns values into shapes, keeping letters that never change", () => {
    expect(shapeOf("C001")).toBe("A999");
    expect(shapeOf("2026-11-03")).toBe("9999-99-99");
    expect(shapeOf("ﾃｽﾄ　テスト　てすと　試験　ＡＢ１")).toBe("ｱｱｱ　アアア　あああ　漢漢　ＡＡ９");
    expect(formatsOf(["C001", "C002", "C017"])).toEqual(["C999"]);
    expect(formatsOf(["C001", "D002", "AB-1", "AB-2", "AB-3"])).toEqual(["AB-9", "A999"]);
    // char(n) padding is no part of the shape
    expect(formatsOf(["X1  ", "X2  "])).toEqual(["X9"]);
    expect(formatsOf(["a1", "b22", "c333", "d4444"])).toBeUndefined();
    expect(formatsOf(["x".repeat(31)])).toBeUndefined();
  });

  it("hides columns by their names, comments and the rules", () => {
    const t = { schema: "dbo", name: "M_CUSTOMER" };
    const hidden = (name: string, comment?: string, rules = {}) => isHidden(t, { name, type: "varchar(20)", nullable: true, comment }, rules);
    expect(["CUSTOMER_NAME", "TEL_NO", "E_MAIL", "ADDR1", "BIRTH_DATE", "PASSWORD", "NOTE", "SHIMEI", "JUSHO"].every((n) => hidden(n))).toBe(true);
    expect(hidden("COL01", "得意先名")).toBe(true);
    expect(hidden("COL02", "電話番号")).toBe(true);
    expect(["CUSTOMER_CODE", "STATUS", "QTY", "ORDER_DATE", "MEISAI_NO"].some((n) => hidden(n))).toBe(false);
    expect(hidden("CUSTOMER_NAME", undefined, { show: ["M_CUSTOMER.CUSTOMER_NAME"] })).toBe(false);
    expect(hidden("CUSTOMER_NAME", undefined, { show: ["dbo.m_customer.*"] })).toBe(false);
    expect(hidden("STATUS", undefined, { hide: ["*.STATUS"] })).toBe(true);
    expect(hidden("STATUS", undefined, { hide: ["STATUS"] })).toBe(true);
    expect(hidden("STATUS", undefined, { hide: ["T_ORDER.STATUS"] })).toBe(false);
    // hide wins over show
    expect(hidden("TEL", undefined, { hide: ["TEL"], show: ["TEL"] })).toBe(true);
  });

  it("reads the rules file strictly", () => {
    expect(parseDataRules('{"hide": ["*.SALARY"], "show": []}', "r.json")).toEqual({ hide: ["*.SALARY"], show: [] });
    expect(() => parseDataRules("{", "r.json")).toThrow("r.json: not JSON");
    expect(() => parseDataRules('{"hidden": []}', "r.json")).toThrow('unknown key "hidden"');
    expect(() => parseDataRules('{"hide": "x"}', "r.json")).toThrow('"hide" must be a list');
  });

  it("stands in values of the same shape, the same for the same value", () => {
    const key = Buffer.alloc(32, 1);
    const tel = standIn("090-1234-5678", key);
    expect(shapeOf(tel)).toBe("999-9999-9999");
    expect(tel).not.toBe("090-1234-5678");
    expect(standIn("090-1234-5678", key)).toBe(tel);
    expect(standIn("090-1234-5678", Buffer.alloc(32, 2))).not.toBe(tel);
    expect(standIn("山田 太郎", key)).toBe("〇〇 〇〇");
    expect(shapeOf(standIn("taro.yamada@example.co.jp", key))).toBe("aaaa.aaaaaa@aaaaaaa.aa.aa");
  });
});

describe("ashiato schema --data on SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "ashiato-profile-"));
  const file = join(dir, "app.db");
  const app = new DatabaseSync(file);
  const names = ["山田 太郎", "佐藤 花子", "鈴木 一郎", "高橋 次郎", "田中 三郎", "伊藤 四郎", "渡辺 五郎", "中村 六郎"];
  const tels = names.map((_, i) => `090-1234-56${String(10 + i)}`);
  app.exec(`
    CREATE TABLE M_CUSTOMER (CUSTOMER_CODE TEXT PRIMARY KEY, CUSTOMER_NAME TEXT NOT NULL, TEL TEXT, KIND TEXT);
    CREATE TABLE M_ITEM (ITEM_CODE TEXT PRIMARY KEY, ITEM_NAME TEXT, PRICE INTEGER);
    CREATE TABLE T_ORDER (
      ORDER_NO INTEGER PRIMARY KEY, CUSTOMER_CODE TEXT NOT NULL REFERENCES M_CUSTOMER, ITEM_CODE TEXT,
      STATUS TEXT NOT NULL, QTY INTEGER, ORDER_DATE DATE, CANCEL_DATE DATE, NOTE TEXT);
    CREATE TABLE T_LINE (ORDER_NO INTEGER, LINE_NO INTEGER, PRIMARY KEY (ORDER_NO, LINE_NO));
    CREATE TABLE T_SHIP (ORDER_NO INTEGER, LINE_NO INTEGER, SHIP_NO INTEGER, PRIMARY KEY (ORDER_NO, LINE_NO, SHIP_NO));
    CREATE TABLE T_LOG (ID INTEGER PRIMARY KEY, MSG TEXT);
    CREATE TABLE T_AUDIT (ID INTEGER PRIMARY KEY, AT DATE);
  `);
  const insert = (sql: string, rows: unknown[][]) => {
    const stmt = app.prepare(sql);
    for (const r of rows) stmt.run(...(r as (string | number | null)[]));
  };
  insert(
    "INSERT INTO M_CUSTOMER VALUES (?, ?, ?, ?)",
    names.map((n, i) => [`C00${i + 1}`, n, tels[i], i % 2 ? "B" : "A"]),
  );
  insert("INSERT INTO M_ITEM VALUES (?, ?, ?)", [
    ["A001", "ボルト", 120],
    ["A002", "ナット", 80],
    ["B010", "ワッシャー", 15],
  ]);
  const orders: unknown[][] = [];
  for (let i = 1; i <= 60; i++) {
    const status = i <= 50 ? "10" : i <= 57 ? "20" : "90";
    const day = `2026-${String(1 + (i % 10)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
    orders.push([i, `C00${1 + (i % 8)}`, ["A001", "A002", "B010"][i % 3], status, i % 5 === 0 ? null : 1 + (i % 9), day, status === "90" ? day : null, i % 20 === 0 ? `至急 ${tels[i / 20]} に連絡` : null]);
  }
  insert("INSERT INTO T_ORDER VALUES (?, ?, ?, ?, ?, ?, ?, ?)", orders);
  insert(
    "INSERT INTO T_LINE VALUES (?, ?)",
    Array.from({ length: 20 }, (_, i) => [1 + (i % 10), 1 + Math.floor(i / 10)]),
  );
  insert(
    "INSERT INTO T_SHIP VALUES (?, ?, ?)",
    Array.from({ length: 6 }, (_, i) => [1 + (i % 3), 1 + (i % 2), 1]),
  );
  insert(
    "INSERT INTO T_LOG VALUES (?, ?)",
    Array.from({ length: 10 }, (_, i) => [i + 1, `log ${i}`]),
  );
  insert(
    "INSERT INTO T_AUDIT VALUES (?, ?)",
    Array.from({ length: 10 }, (_, i) => [i + 1, "2026-11-01"]),
  );
  const url = `sqlite:${file}`;
  const section = (md: string, table: string) => md.slice(md.indexOf(`### ${table}\n`)).split(/\n(?=### )/)[0]!;

  it("describes the rows: counts, references, NULLs, codes, ranges and formats", async () => {
    const db = await connect(url);
    try {
      const { markdown, problems, hidden } = await schemaMarkdown(db, { lang: "ja", data: { date: "2026-11-03" } });
      expect(problems).toEqual([]);
      expect(markdown).toContain("`--data` で 2026-11-03 時点のデータの姿も書き足しています。");
      const order = section(markdown, "T_ORDER");
      expect(order).toContain("主キー:ORDER_NO\n\n件数:60 行\n参照:CUSTOMER_CODE → M_CUSTOMER.CUSTOMER_CODE(外部キー)、ITEM_CODE → M_ITEM.ITEM_CODE(推定:値がすべて見つかる)\n\n| 列 | 型 | Null | データ |\n| --- | --- | --- | --- |");
      expect(order).toContain("| ORDER_NO | INTEGER | NOT NULL | 重複なし · 1〜60 |");
      expect(order).toContain("| STATUS | TEXT | NOT NULL | 10 (50), 20 (7), 90 (3) |");
      // few values used many times read as a code, numbers too
      expect(order).toContain("| QTY | INTEGER | NULL | NULL 20% · 3 (6), 4 (6), 5 (6), 1 (5), 2 (5), 6 (5), 7 (5), 8 (5), 9 (5) |");
      expect(order).toContain("| CUSTOMER_CODE | TEXT | NOT NULL | C002 (8), C003 (8), C004 (8), C005 (8), C001 (7), C006 (7), C007 (7), C008 (7) |");
      expect(order).toContain("| CANCEL_DATE | DATE | NULL | NULL 95% · 重複なし · 2026-01-05〜2026-10-04 |");
      expect(order).toContain("| NOTE | TEXT | NULL | 隠した列 · NULL 95% · 重複なし · 20 文字 |");
      expect(section(markdown, "M_CUSTOMER")).toContain("| CUSTOMER_CODE | TEXT | NOT NULL | 重複なし · 書式 C999 |");
      expect(section(markdown, "M_CUSTOMER")).toContain("| CUSTOMER_NAME | TEXT | NOT NULL | 隠した列 · 重複なし · 5 文字 |");
      // 8 values in 8 rows: no code, so not listed
      expect(section(markdown, "M_CUSTOMER")).toContain("| KIND | TEXT | NULL | 2 種 · 1 文字 |");
      // composite primary keys: every column of the other table's key, by name
      expect(section(markdown, "T_SHIP")).toContain("参照:(ORDER_NO, LINE_NO) → T_LINE (ORDER_NO, LINE_NO)(推定:値がすべて見つかる)、ORDER_NO → T_ORDER.ORDER_NO(推定:値がすべて見つかる)");
      expect(section(markdown, "T_LINE")).toContain("参照:ORDER_NO → T_ORDER.ORDER_NO(推定:値がすべて見つかる)\n");
      // keyed by the same ID: no relation is inferred between them
      expect(section(markdown, "T_LOG")).not.toContain("参照");
      expect(section(markdown, "T_AUDIT")).not.toContain("参照");
      expect(hidden).toBe(4);
      for (const v of [...names, ...tels, "至急"]) expect(markdown).not.toContain(v);
    } finally {
      await db.close();
    }
  });

  it("shows sample rows with hidden columns replaced, the same value by the same stand-in", async () => {
    const db = await connect(url);
    try {
      const { markdown } = await schemaMarkdown(db, { lang: "en", tables: ["M_CUSTOMER", "T_ORDER"], data: { samples: 3, date: "2026-11-03" } });
      const customers = section(markdown, "M_CUSTOMER");
      expect(customers).toContain("Sample rows (the 3 with the highest primary key; hidden columns replaced):\n\n| CUSTOMER_CODE | CUSTOMER_NAME | TEL | KIND |\n| --- | --- | --- | --- |");
      expect(customers).toMatch(/\| C008 \| 〇〇 〇〇 \| \d{3}-\d{4}-\d{4} \| B \|/);
      const orders = section(markdown, "T_ORDER");
      expect(orders).toContain("| 60 | C005 | A001 | 90 | NULL | 2026-01-05 | 2026-01-05 | (20 characters) |");
      for (const v of [...names, ...tels]) expect(markdown).not.toContain(v);
    } finally {
      await db.close();
    }
  });

  it("describes a large table from its first rows, and follows the rules", async () => {
    const db = await connect(url);
    try {
      const { markdown } = await schemaMarkdown(db, {
        lang: "ja",
        tables: ["T_ORDER", "M_ITEM"],
        data: { largeTable: 50, sampleRows: 20, rules: { hide: ["*.PRICE"], show: ["M_ITEM.ITEM_NAME"] } },
      });
      expect(section(markdown, "T_ORDER")).toContain("件数:60 行(各列のデータは先頭 20 行から)");
      expect(section(markdown, "T_ORDER")).toContain("| STATUS | TEXT | NOT NULL | 10 (20) |");
      const item = section(markdown, "M_ITEM");
      expect(item).toContain("| ITEM_NAME | TEXT | NULL | 重複なし · 3〜5 文字 |");
      expect(item).toContain("| PRICE | INTEGER | NULL | 隠した列 · 重複なし |");
      expect(item).not.toContain("120");
    } finally {
      await db.close();
    }
  });

  it("starts the --data description line the way tazuna looks for it (its dbChecks.ts), in both languages", async () => {
    // tazuna adds its procedure's data line only when schema.md has a line starting like this
    const TAZUNA_DATA_INTRO = /^(?:`--data` で |With `--data`, )/m;
    const db = await connect(url);
    try {
      for (const lang of ["ja", "en"] as const) {
        const tables = ["T_LOG"];
        expect((await schemaMarkdown(db, { lang, tables, data: {} })).markdown).toMatch(TAZUNA_DATA_INTRO);
        expect((await schemaMarkdown(db, { lang, tables })).markdown).not.toMatch(TAZUNA_DATA_INTRO);
      }
    } finally {
      await db.close();
    }
  });

  it("writes nothing new without --data", async () => {
    const db = await connect(url);
    try {
      const { markdown } = await schemaMarkdown(db, { lang: "ja", tables: ["T_LOG"] });
      expect(markdown).toBe(
        "# DB のテーブル定義\n\nSQLite のカタログから `ashiato schema` が書き出しました(参照のみ)。列・型・主キー・コメントです。テーブルが変わったら、もう一度実行してください。\n\n## テーブル\n\n### T_LOG\n\n主キー:ID\n\n| 列 | 型 | Null |\n| --- | --- | --- |\n| ID | INTEGER | NOT NULL |\n| MSG | TEXT | NULL |\n",
      );
    } finally {
      await db.close();
    }
  });

  describe("CLI", () => {
    const logs: string[] = [];
    afterEach(() => {
      vi.restoreAllMocks();
      logs.length = 0;
    });
    const capture = () => {
      vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(m));
      vi.spyOn(console, "error").mockImplementation((m: string) => void logs.push(m));
    };

    it("ashiato schema --data reads data-rules.json next to the output", async () => {
      capture();
      const out = join(dir, "docs", "db", "schema.md");
      mkdirSync(join(dir, "docs", "db"), { recursive: true });
      writeFileSync(join(dir, "docs", "db", "data-rules.json"), JSON.stringify({ hide: ["*.KIND"] }));
      await main(["schema", "--db", url, "--lang", "en", "--data", "--samples", "2", "--out", out]);
      const md = readFileSync(out, "utf8");
      expect(md).toContain("| KIND | TEXT | NULL | hidden · 2 distinct · 1 characters |");
      expect(md).toContain("Sample rows (the 2 with the highest primary key; hidden columns replaced):");
      expect(logs.join("\n")).toMatch(/5 column\(s\) hidden \(rules: .*data-rules\.json\)/);
    });

    it("checks the options that go with --data", async () => {
      await expect(main(["schema", "--db", url, "--samples", "2"])).rejects.toThrow("--samples and --rules go with --data");
      await expect(main(["schema", "--db", url, "--data", "--samples", "50", "--out", "-"])).rejects.toThrow("--samples 50: a number from 1 to 20");
      await expect(main(["schema", "--db", url, "--data", "--rules", join(dir, "nope.json"), "--out", "-"])).rejects.toThrow("no such file");
    });
  });
});
