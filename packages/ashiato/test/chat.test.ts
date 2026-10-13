import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/adapters/index.js";
import { decodeText } from "../src/chat/decode.js";
import { codeFence, markdownCell } from "../src/chat/markdown.js";
import { planQueries, queryReport, refusedReport, runPlanned, type Outcome } from "../src/chat/query.js";
import { pickTables, schemaMarkdown } from "../src/chat/schema.js";
import { readOnlyProblem, splitStatements } from "../src/chat/sql.js";
import { main } from "../src/cli/main.js";

describe("splitStatements", () => {
  it("splits at ; outside quotes and comments, and takes the comment above as the title", () => {
    const sql = [
      "-- file header",
      "",
      "-- 受注の合計",
      "-- 明細と一致するか",
      "SELECT 'a;b' AS x, \"c;d\" FROM t -- inline ; comment",
      "  WHERE y = 'it''s';",
      "/* second */ SELECT 2;",
      "SELECT 3",
    ].join("\r\n");
    expect(splitStatements(sql)).toEqual([
      { sql: "SELECT 'a;b' AS x, \"c;d\" FROM t -- inline ; comment\n  WHERE y = 'it''s'", title: "受注の合計\n明細と一致するか", line: 5 },
      { sql: "SELECT 2", title: "second", line: 7 },
      { sql: "SELECT 3", title: "", line: 8 },
    ]);
  });

  it("splits at GO and / lines (SQL Server and SQL*Plus scripts)", () => {
    expect(splitStatements("SELECT 1\nGO\nSELECT 2\n  go 2 \nSELECT 3\n/\n").map((s) => s.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    // not a separator inside a statement's line or a string
    expect(splitStatements("SELECT 1 AS go, 'x\nGO\ny' AS s;").map((s) => s.sql)).toEqual(["SELECT 1 AS go, 'x\nGO\ny' AS s"]);
  });

  it("reads each database's quotes", () => {
    expect(splitStatements("SELECT [a;b] FROM t; SELECT 2", "mssql").map((s) => s.sql)).toEqual(["SELECT [a;b] FROM t", "SELECT 2"]);
    expect(splitStatements("SELECT $q$a;b$q$, $$c;d$$; SELECT 2", "postgres").map((s) => s.sql)).toEqual(["SELECT $q$a;b$q$, $$c;d$$", "SELECT 2"]);
    expect(splitStatements("SELECT q'[it's;]' FROM dual; SELECT 2 FROM dual", "oracle").map((s) => s.sql)).toEqual(["SELECT q'[it's;]' FROM dual", "SELECT 2 FROM dual"]);
    expect(splitStatements("SELECT 'a\\';b'; SELECT 2", "mysql").map((s) => s.sql)).toEqual(["SELECT 'a\\';b'", "SELECT 2"]);
    expect(splitStatements("# total\nSELECT 1--1;SELECT 2", "mysql")).toEqual([
      { sql: "SELECT 1--1", title: "total", line: 2 },
      { sql: "SELECT 2", title: "", line: 2 },
    ]);
    // Oracle's V$ views are names, not PostgreSQL's dollar quotes
    expect(splitStatements("SELECT * FROM V$SESSION; SELECT 2", "oracle")).toHaveLength(2);
  });
});

describe("readOnlyProblem", () => {
  const ok = (sql: string, dialect?: string) => expect(readOnlyProblem(sql, dialect)).toBeUndefined();
  const refused = (sql: string, dialect?: string) => expect(readOnlyProblem(sql, dialect)).toBeDefined();

  it("lets SELECT and WITH through, whatever the strings, comments and column names say", () => {
    ok("select o.update_date, 'DELETE FROM t' AS s FROM orders o -- UPDATE later");
    ok("WITH x AS (SELECT 1 AS n) SELECT n FROM x /* INSERT */");
    ok("SELECT 受注番号, 数量 FROM 受注 WHERE 備考 LIKE '%INSERT%'");
    ok("SELECT * FROM t WITH (NOLOCK)", "mssql");
    ok("SELECT [update] FROM t", "mssql");
    ok("SELECT * FROM V$SESSION", "oracle");
  });

  it("refuses statements that write, lock, or reach outside the database", () => {
    for (const sql of [
      "UPDATE t SET a = 1",
      "INSERT INTO t VALUES (1)",
      "EXEC sp_who",
      "SELECT * INTO t2 FROM t",
      "SELECT * FROM t FOR UPDATE",
      "SELECT * FROM t FOR SHARE",
      "SELECT * FROM t LOCK IN SHARE MODE",
      "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
      "WITH FUNCTION f RETURN NUMBER IS BEGIN DELETE FROM t; RETURN 1; END; SELECT f FROM dual",
      "SELECT NEXT VALUE FOR s",
      "SELECT s.NEXTVAL FROM dual",
      "SELECT nextval('s')",
      "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')",
      "",
    ]) {
      refused(sql);
    }
    // SQL Server runs a batch without semicolons: a second statement may follow the SELECT
    refused("SELECT 1 DELETE FROM t", "mssql");
    refused("SELECT 1\u3000DELETE FROM t", "mssql");
  });

  it("refuses what one reading of the quotes would hide", () => {
    // MySQL reads \' as a quote inside the string; without backslash escapes the string ends there
    refused("SELECT 'a\\' , 1 INTO OUTFILE '/tmp/x' -- '", "mysql");
    // PostgreSQL's E'' strings read backslashes: the COMMIT is outside the string there
    refused("SELECT E'\\'' ; COMMIT; DELETE FROM t; SELECT ' x'", "postgres");
    refused("SELECT E'\\'' ; END; SELECT pg_terminate_backend(1); SELECT ' x'", "postgres");
    // MySQL: # starts a comment, -- needs a space after it, and /*! ... */ is run
    refused("SELECT 1 # it's\nINTO OUTFILE '/tmp/x' -- '", "mysql");
    refused("SELECT 1 --1 INTO OUTFILE '/tmp/x'", "mysql");
    refused("SELECT 1 /*! INTO OUTFILE '/tmp/x' */", "mysql");
    ok("SELECT 1 -- INSERT later\n# DELETE too\nFROM dual", "mysql");
    // Oracle's q'[...]' may hold a quote
    refused("SELECT q'[ ' ]' , x FROM t WHERE 1 = 1 UNION SELECT y FROM u FOR UPDATE --'", "oracle");
    expect(readOnlyProblem("SELECT 1; SELECT 2")).toMatchObject({ code: "several" });
    expect(readOnlyProblem("DELETE FROM t")).toMatchObject({ code: "not-select", word: "DELETE" });
    expect(readOnlyProblem("SELECT * INTO t2 FROM t")).toMatchObject({ code: "writes", word: "INTO" });
  });
});

describe("decodeText", () => {
  it("reads UTF-8 (with or without a BOM) and Shift_JIS", () => {
    expect(decodeText(Buffer.from("\uFEFFSELECT '受注'", "utf8"))).toBe("SELECT '受注'");
    expect(decodeText(Buffer.from("SELECT '受注'", "utf8"))).toBe("SELECT '受注'");
    expect(decodeText(Buffer.from("2d2d208ef3928d82cc8a6d94460a53454c45435420313b", "hex"))).toBe("-- 受注の確認\nSELECT 1;");
    expect(decodeText(Buffer.from("\uFEFFSELECT 1", "utf16le").subarray(0))).toBe("SELECT 1");
  });
});

describe("Markdown", () => {
  it("writes values into table cells", () => {
    expect([null, "", "a|b", "line1\r\nline2", 1.5, true].map((v) => markdownCell(v))).toEqual(["NULL", "''", "a\\|b", "line1<br>line2", "1.5", "true"]);
    expect(markdownCell("x".repeat(400))).toBe(`${"x".repeat(300)}…(400)`);
  });

  it("fences code that holds a fence", () => {
    expect(codeFence("SELECT '```'", "sql")).toBe("````sql\nSELECT '```'\n````");
  });
});

describe("query report", () => {
  const outcomes: Outcome[] = [
    {
      file: "checks/orders.sql",
      statement: { sql: "SELECT id, note FROM orders", title: "受注の確認\n2 件のはず", line: 2 },
      result: { columns: ["id", "note"], rows: [[1, "a|b"], [2, null]], more: true },
      ms: 12,
    },
    { file: "checks/orders.sql", statement: { sql: "SELECT * FROM nope", title: "", line: 5 }, error: "no such table: nope", ms: 1 },
    { file: "checks/orders.sql", statement: { sql: "SELECT COUNT(*) FROM orders WHERE 1 = 0", title: "空", line: 7 }, result: { columns: [""], rows: [], more: false }, ms: 3 },
  ];
  const at = new Date(2026, 9, 13, 10, 0, 0);

  it("shows each statement with its comment, SQL and rows (Japanese)", () => {
    const md = queryReport(outcomes, { dialect: "mssql", lang: "ja", maxRows: 2, at });
    expect(md).toContain("SQL Server で `ashiato query` が参照専用で実行した結果です(2026-10-13 10:00:00 UTC");
    expect(md).toContain("## 1. 受注の確認\n\n2 件のはず\n\nchecks/orders.sql の 2 行目\n\n```sql\nSELECT id, note FROM orders\n```");
    expect(md).toContain("| id | note |\n| --- | --- |\n| 1 | a\\|b |\n| 2 | NULL |\n\n先頭 2 行(続きがあります。12 ms)");
    expect(md).toContain("## 2. checks/orders.sql の 5 行目の文");
    expect(md).toContain("**エラー**(1 ms):no such table: nope");
    expect(md).toContain("| (名前なし) |\n| --- |\n\n0 行(該当なし。3 ms)");
  });

  it("says it in English too", () => {
    const md = queryReport(outcomes, { dialect: "postgres", lang: "en", maxRows: 2, at });
    expect(md).toContain("Run read-only by `ashiato query` on PostgreSQL");
    expect(md).toContain("The first 2 rows (there are more; 12 ms).");
    expect(md).toContain("No rows (3 ms).");
  });

  it("explains why nothing was run", () => {
    const planned = planQueries([{ name: "checks/x.sql", text: "SELECT 1;\n-- 直す\nUPDATE t SET a = 1;" }], "mssql");
    expect(planned.map((p) => p.problem?.code)).toEqual([undefined, "not-select"]);
    const md = refusedReport(planned, "ja");
    expect(md).toContain("1 文も実行していません");
    expect(md).toContain("## checks/x.sql の 3 行目\n\nSELECT か WITH で始まる文だけを実行します(この文は UPDATE で始まっています)\n\n```sql\nUPDATE t SET a = 1\n```");
    expect(md).not.toContain("SELECT 1\n");
  });
});

describe("schema and query on SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "ashiato-chat-"));
  const file = join(dir, "app.db");
  const app = new DatabaseSync(file);
  app.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, qty INTEGER, amount NUMERIC(10,2));
    CREATE TABLE lines (order_id INTEGER, line_no INTEGER, item TEXT, PRIMARY KEY (order_id, line_no));
    CREATE VIEW order_qty AS SELECT id, qty FROM orders;
    INSERT INTO orders VALUES (1, 'A', 3, 10.5), (2, 'B', 1, NULL), (3, 'C', 7, 99);
  `);
  const url = `sqlite:${file}`;

  it("writes the tables and views as Markdown", async () => {
    const db = await connect(url);
    try {
      const { markdown, tables, views } = await schemaMarkdown(db, { lang: "en" });
      expect([tables, views]).toEqual([2, 1]);
      expect(markdown).toContain("## Tables\n\n### lines\n\nPrimary key: order_id, line_no\n\n| Column | Type | Null |\n| --- | --- | --- |\n| order_id | INTEGER | NOT NULL |");
      expect(markdown).toContain("### orders\n\nPrimary key: id\n\n| Column | Type | Null |\n| --- | --- | --- |\n| id | INTEGER | NOT NULL |\n| customer | TEXT | NOT NULL |\n| qty | INTEGER | NULL |\n| amount | NUMERIC(10,2) | NULL |");
      expect(markdown).toContain("## Views\n\n### order_qty\n\n| Column | Type | Null |");
      expect(markdown).not.toContain("Primary key: (none)\n\n| Column | Type | Null |\n| --- | --- | --- |\n| id | INTEGER | NULL |\n| qty");
      const only = await schemaMarkdown(db, { lang: "ja", tables: ["ORD*"] });
      expect([only.tables, only.views]).toEqual([1, 1]);
      expect(only.markdown).toContain("# DB のテーブル定義");
      await expect(schemaMarkdown(db, { lang: "en", tables: ["nope"] })).rejects.toThrow("Tables not found: nope");
    } finally {
      await db.close();
    }
  });

  it("picks tables by name or pattern", () => {
    const all = [{ schema: "dbo", name: "M_ITEM" }, { schema: "dbo", name: "T_ORDER" }, { schema: "x", name: "M_ITEM" }];
    expect(pickTables(all, ["m_*"])).toEqual([all[0], all[2]]);
    expect(pickTables(all, ["dbo.m_item"])).toEqual([all[0]]);
    expect(pickTables(all, undefined)).toEqual(all);
    expect(() => pickTables(all, ["T_ORDERS"])).toThrow("Tables not found: T_ORDERS");
  });

  it("runs statements read-only and keeps going after one fails", async () => {
    const db = await connect(url);
    try {
      const planned = planQueries([{ name: "c.sql", text: "-- big ones\nSELECT id, qty FROM orders WHERE qty > 2 ORDER BY id;\nSELECT * FROM nope;\nSELECT id, id FROM orders ORDER BY id" }], db.dialect);
      const outcomes = await runPlanned(db, planned, 1);
      expect(outcomes[0]).toMatchObject({ result: { columns: ["id", "qty"], rows: [[1, 3]], more: true } });
      expect(outcomes[1]!.error).toMatch(/no such table: nope/);
      expect(outcomes[2]).toMatchObject({ result: { columns: ["id", "id"], rows: [[1, 1]], more: true } });
      // opened read-only: even a statement that got past the check could not write
      await expect(db.runQuery!("DELETE FROM orders", 10)).rejects.toThrow(/readonly/i);
    } finally {
      await db.close();
    }
  });

  describe("CLI", () => {
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

    it("ashiato schema writes docs/db/schema.md", async () => {
      capture();
      const out = join(dir, "docs", "db", "schema.md");
      await main(["schema", "--db", url, "--lang", "en", "--out", out]);
      expect(readFileSync(out, "utf8")).toContain("### orders");
      expect(logs.join("\n")).toMatch(/Wrote .*schema\.md \(2 table\(s\), 1 view\(s\);/);
    });

    it("ashiato query runs a folder's .sql files and writes the results", async () => {
      capture();
      const checks = join(dir, "checks");
      mkdirSync(checks, { recursive: true });
      writeFileSync(join(checks, "b.sql"), "-- 2 番目\nSELECT COUNT(*) AS n FROM orders;\n");
      writeFileSync(join(checks, "a.sql"), Buffer.from("2d2d208ef3928d82cc8a6d94460a53454c45435420313b", "hex"));
      writeFileSync(join(checks, "notes.txt"), "not SQL");
      const out = join(dir, "result.md");
      await main(["query", checks, "--db", url, "--lang", "ja", "--no-clip", "--out", out]);
      const md = readFileSync(out, "utf8");
      expect(md).toMatch(/## 1\. 受注の確認[\s\S]*## 2\. 2 番目[\s\S]*\| n \|\n\| --- \|\n\| 3 \|/);
      expect(logs.join("\n")).toMatch(/1\. 受注の確認 +1 row\(s\)/);
      expect(process.exitCode).toBeUndefined();
    });

    it("ashiato query runs nothing when a statement could write", async () => {
      capture();
      const sql = join(dir, "bad.sql");
      writeFileSync(sql, "SELECT 1;\nDELETE FROM orders;\n");
      const out = join(dir, "refused.md");
      await main(["query", sql, "--db", url, "--lang", "en", "--no-clip", "--out", out]);
      expect(process.exitCode).toBe(1);
      expect(readFileSync(out, "utf8")).toContain("ashiato query ran none of them");
      expect(logs.join("\n")).toContain("Nothing was run: 1 statement(s) don't only read.");
      expect(new DatabaseSync(file, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 3 });
    });

    it("ashiato query checks its options", async () => {
      await expect(main(["query", "--db", url])).rejects.toThrow("Usage: ashiato query");
      await expect(main(["query", join(dir, "checks"), "--db", url, "--max-rows", "0"])).rejects.toThrow("--max-rows takes a number");
      await expect(main(["query", join(dir, "checks"), "--db", "http://x"])).rejects.toThrow("Unsupported database URL: http:");
    });
  });
});
