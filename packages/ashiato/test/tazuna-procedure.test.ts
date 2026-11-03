import { describe, expect, it } from "vitest";
import { planQueries } from "../src/chat/query.js";
import { parseVerifyFile } from "../src/chat/verifyFile.js";
import type { Diff, TableDiff } from "../src/core/types.js";
import { matchChanges, type WatchedTable } from "../src/testing/match.js";

/**
 * tazuna (https://github.com/ishibashi0112/tazuna) tells the chat how to write the files `ashiato query`
 * and `ashiato verify` read: the sections "DB の確認" and "動作検証" of its procedure
 * (src/pack/assets/procedure.ts, DB_SECTIONS, procedure v8 and v9 onwards), added to the pack when the
 * project has docs/db/schema.md. The chat can't run anything, so a form that text teaches and ashiato
 * doesn't read costs a round trip. The files below use every form it teaches, in its words, with the
 * placeholders filled in. If this test has to change, change tazuna's procedure too, and the other way round.
 */

/** "動作検証": the step heading, a step without expected changes and each form of the expected lines. */
const VERIFY = `# 受注登録の動作検証

## 1. 受注画面を開く
受注画面を開き、得意先の一覧が出ることを確かめる

## 2. 受注を登録する
受注画面で得意先 C001・品目 A001・数量 3 を入れて「登録」を押す

期待する DB の変化:
- T_ORDER: 追加 1 行 (CUSTOMER_CODE=C001, QTY=3)
- T_ORDER_LINE: 追加 (ORDER_NO=*, NOTE='箱(大), 2 個')
- M_STOCK: 更新 1 行 (ITEM_CODE=A001) → (QTY-=3, UPD_DATE=*)
- T_LOG: 変化なし

## 3. 受注を取り消す
受注一覧で受注を選んで「取消」を押す

期待する DB の変化:
- T_ORDER: 更新 1 行 (CUSTOMER_CODE=C001) → (STATUS=90, CANCEL_DATE=2026-11-03, ...)
- M_STOCK: 更新 1 行 (ITEM_CODE=A001) → (QTY+=3, ...)
- T_ORDER_LINE: 削除 1 行 (NOTE=NULL)
- ほかのテーブル: 問わない
`;

/** "DB の確認": SELECT / WITH only, a `--` comment with the purpose before each statement, `;` between them. */
const CHECKS = `-- 合計が明細の合計と一致しない受注(0 行なら OK)
SELECT o.ORDER_NO, o.TOTAL, SUM(l.QTY * l.PRICE) AS LINES_TOTAL
FROM T_ORDER o JOIN T_ORDER_LINE l ON l.ORDER_NO = o.ORDER_NO
GROUP BY o.ORDER_NO, o.TOTAL
HAVING o.TOTAL <> SUM(l.QTY * l.PRICE);

-- 在庫がマイナスの品目の件数(0 なら OK)
WITH minus AS (SELECT ITEM_CODE FROM M_STOCK WHERE QTY < 0)
SELECT COUNT(*) AS N FROM minus;
`;

const table = (name: string, t: Partial<TableDiff> = {}): TableDiff => ({ table: { name }, key: [], inserted: [], updated: [], deleted: [], ...t });
const diff = (...tables: TableDiff[]): Diff => ({ from: "", to: "", tables });
const watched: WatchedTable[] = ["T_ORDER", "T_ORDER_LINE", "M_STOCK", "T_LOG", "T_AUDIT"].map((name) => ({ table: { name } }));

describe("the forms tazuna's procedure teaches", () => {
  const file = parseVerifyFile(VERIFY, "ja");
  const [open, register, cancel] = file.steps;
  const check = (step: typeof register, d: Diff) => {
    const r = matchChanges(d, step!.expect!.expected, watched, { unlisted: step!.expect!.unlisted });
    return r.ok ? [] : r.problems;
  };

  it("reads a verify.md written as the procedure says", () => {
    expect(file.problems).toEqual([]);
    expect(file.steps.map((s) => s.title)).toEqual(["1. 受注画面を開く", "2. 受注を登録する", "3. 受注を取り消す"]);
    // a step without 「期待する DB の変化:」 is shown and recorded, not checked
    expect(open!.expect).toBeUndefined();
    expect(register!.expect!.unlisted).toBe("unchanged");
    expect(cancel!.expect!.unlisted).toBe("any");
  });

  it("checks them as the procedure explains", () => {
    const registered = diff(
      table("T_ORDER", { inserted: [{ ORDER_NO: 1042, CUSTOMER_CODE: "C001", QTY: 3, STATUS: 10 }] }),
      table("T_ORDER_LINE", { inserted: [{ ORDER_NO: 1042, NOTE: "箱(大), 2 個" }] }),
      table("M_STOCK", {
        key: ["ITEM_CODE"],
        updated: [{ key: { ITEM_CODE: "A001" }, before: { ITEM_CODE: "A001", QTY: 50, UPD_DATE: "2026-11-01 10:00:00" }, after: { ITEM_CODE: "A001", QTY: 47, UPD_DATE: "2026-11-03 09:00:00" }, changed: ["QTY", "UPD_DATE"] }],
      }),
    );
    expect(check(register, registered)).toEqual([]);
    // 列-=数 is the amount, and tables not listed must not change
    const wrongAmount = diff(...registered.tables.map((t) => (t.table.name === "M_STOCK" ? { ...t, updated: [{ ...t.updated[0]!, after: { ...t.updated[0]!.after, QTY: 48 } }] } : t)));
    expect(check(register, wrongAmount)).toEqual([expect.stringContaining("QTY")]);
    expect(check(register, diff(...registered.tables, table("T_AUDIT", { inserted: [{ ID: 1 }] })))).toEqual([expect.stringContaining("T_AUDIT")]);
    expect(check(register, diff(...registered.tables, table("T_LOG", { inserted: [{ ID: 1 }] })))).toEqual([expect.stringContaining("T_LOG")]);

    const cancelled = diff(
      table("T_ORDER", {
        key: ["ORDER_NO"],
        updated: [
          {
            key: { ORDER_NO: 1042 },
            before: { ORDER_NO: 1042, CUSTOMER_CODE: "C001", STATUS: 10, CANCEL_DATE: null, UPD_USER: "a" },
            after: { ORDER_NO: 1042, CUSTOMER_CODE: "C001", STATUS: 90, CANCEL_DATE: "2026-11-03T05:12:00.000Z", UPD_USER: "b" },
            changed: ["STATUS", "CANCEL_DATE", "UPD_USER"],
          },
        ],
      }),
      table("M_STOCK", {
        key: ["ITEM_CODE"],
        updated: [{ key: { ITEM_CODE: "A001" }, before: { ITEM_CODE: "A001", QTY: 47, UPD_DATE: "x" }, after: { ITEM_CODE: "A001", QTY: 50, UPD_DATE: "y" }, changed: ["QTY", "UPD_DATE"] }],
      }),
      table("T_ORDER_LINE", { deleted: [{ ORDER_NO: 1042, NOTE: null }] }),
      // 「ほかのテーブル: 問わない」
      table("T_AUDIT", { inserted: [{ ID: 2 }] }),
    );
    // a date alone matches any time that day, ... lets other columns change, NULL is NULL
    expect(check(cancel, cancelled)).toEqual([]);
  });

  it("runs a .sql file written as the procedure says, with its comments as the headings", () => {
    for (const dialect of ["mssql", "oracle", "postgres", "mysql", "sqlite"]) {
      const planned = planQueries([{ name: "checks/受注合計.sql", text: CHECKS }], dialect);
      expect(planned.map((p) => [p.statement.title, p.problem])).toEqual([
        ["合計が明細の合計と一致しない受注(0 行なら OK)", undefined],
        ["在庫がマイナスの品目の件数(0 なら OK)", undefined],
      ]);
    }
  });

  it("refuses every kind of statement the procedure forbids", () => {
    // INSERT / UPDATE / DELETE / DDL / EXEC / SELECT ... INTO / FOR UPDATE: one is enough for nothing to run
    for (const sql of [
      "INSERT INTO T_LOG (ID) VALUES (1)",
      "UPDATE M_STOCK SET QTY = 0",
      "DELETE FROM T_LOG",
      "CREATE TABLE T_X (ID INT)",
      "DROP TABLE T_LOG",
      "EXEC sp_who",
      "SELECT * INTO T_COPY FROM T_ORDER",
      "SELECT * FROM M_STOCK FOR UPDATE",
    ]) {
      const planned = planQueries([{ name: "checks/x.sql", text: `${CHECKS}\n-- だめな文\n${sql};\n` }], "mssql");
      expect(planned.filter((p) => p.problem).map((p) => p.statement.sql), sql).toEqual([sql]);
    }
  });
});
