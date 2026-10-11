/**
 * Runs the same scenario against real database servers. Each dialect runs only when its URL is set:
 *   ASHIATO_TEST_POSTGRES_URL, ASHIATO_TEST_MYSQL_URL, ASHIATO_TEST_MSSQL_URL, ASHIATO_TEST_ORACLE_URL
 * CI starts these servers as service containers.
 */
import { describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import { loadDriver } from "../src/adapters/load.js";
import { Recorder } from "../src/core/recorder.js";
import type { Row } from "../src/core/types.js";

type Exec = { run: (sql: string) => Promise<void>; close: () => Promise<void> };

const writers: Record<string, (url: string) => Promise<Exec>> = {
  async postgres(url) {
    const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return { run: async (sql) => void (await c.query(sql)), close: () => c.end() };
  },
  async mysql(url) {
    const mysql = await loadDriver<typeof import("mysql2/promise")>("mysql2/promise", "MySQL");
    const c = await mysql.createConnection({ uri: url });
    return { run: async (sql) => void (await c.query(sql)), close: () => c.end() };
  },
  async mssql(url) {
    const mssql = await loadDriver<typeof import("mssql")>("mssql", "SQL Server");
    const u = new URL(url);
    const pool = await new mssql.ConnectionPool({
      server: u.hostname,
      port: Number(u.port || 1433),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1) || undefined,
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    return { run: async (sql) => void (await pool.request().batch(sql)), close: () => pool.close() };
  },
  async oracle(url) {
    const oracledb = await loadDriver<typeof import("oracledb")>("oracledb", "Oracle");
    const u = new URL(url);
    const c = await oracledb.getConnection({
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      connectString: `${u.hostname}:${u.port || 1521}${u.pathname}`,
    });
    return { run: async (sql) => void (await c.execute(sql, [], { autoCommit: true })), close: () => c.close() };
  },
};

const lower = (r: Row | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

for (const dialect of Object.keys(writers)) {
  const url = process.env[`ASHIATO_TEST_${dialect.toUpperCase()}_URL`];
  describe.skipIf(!url)(`${dialect} adapter`, () => {
    it("records inserts, updates and deletes with read-only queries", async () => {
      const w = await writers[dialect]!(url!);
      for (const t of ["ashiato_orders", "ashiato_stock"]) await w.run(`DROP TABLE ${t}`).catch(() => undefined);
      await w.run("CREATE TABLE ashiato_orders (id INT PRIMARY KEY, qty INT, note VARCHAR(20))");
      await w.run("CREATE TABLE ashiato_stock (item_id INT PRIMARY KEY, qty INT)");
      await w.run("INSERT INTO ashiato_stock (item_id, qty) VALUES (3, 50)");

      const db = await connect(url!);
      try {
        const recorder = new Recorder(db, { tables: ["ashiato_orders", "ashiato_stock"] });
        await recorder.start();
        expect(await db.primaryKey(recorder.session.tables.find((t) => /orders/i.test(t.name))!)).toEqual([
          expect.stringMatching(/^id$/i),
        ]);

        await w.run("INSERT INTO ashiato_orders (id, qty, note) VALUES (1042, 10, 'new')");
        await w.run("UPDATE ashiato_stock SET qty = 40 WHERE item_id = 3");
        const save = await recorder.checkpoint("save");
        const orders = save.diff.tables.find((t) => /orders/i.test(t.table.name));
        const stock = save.diff.tables.find((t) => /stock/i.test(t.table.name));
        expect(lower(orders?.inserted[0])).toMatchObject({ note: "new" });
        expect(Number(lower(orders?.inserted[0]).id)).toBe(1042);
        expect(stock?.updated).toHaveLength(1);
        expect(Number(lower(stock?.updated[0]?.after).qty)).toBe(40);

        await w.run("DELETE FROM ashiato_orders WHERE id = 1042");
        const del = await recorder.checkpoint("delete");
        expect(del.diff.tables).toHaveLength(1);
        expect(del.diff.tables[0]?.deleted).toHaveLength(1);
      } finally {
        await db.close();
        await w.run("DROP TABLE ashiato_orders").catch(() => undefined);
        await w.run("DROP TABLE ashiato_stock").catch(() => undefined);
        await w.close();
      }
    }, 60_000);
  });
}
