/**
 * Runs the same scenario against real database servers. Each dialect runs only when its URL is set:
 *   ASHIATO_TEST_POSTGRES_URL, ASHIATO_TEST_MYSQL_URL, ASHIATO_TEST_MSSQL_URL, ASHIATO_TEST_ORACLE_URL
 * CI starts these servers as service containers.
 *
 * The URL's user creates the tables. ashiato itself connects as a separate user that was only
 * granted SELECT, exactly like in real use. Oracle needs ASHIATO_TEST_ORACLE_ADMIN_URL (a user
 * that can create users) for that; without it the test connects as the table owner.
 */
import { describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import { loadDriver } from "../src/adapters/load.js";
import { Recorder } from "../src/core/recorder.js";
import type { Row } from "../src/core/types.js";

interface Writer {
  run: (sql: string) => Promise<void>;
  close: () => Promise<void>;
  /** Creates a user that may only SELECT from these tables and returns a URL that connects as it. */
  readOnlyUrl: (tables: string[]) => Promise<string>;
}

interface Dialect {
  /** Column types for: a 64-bit integer, a timestamp with sub-millisecond precision, a JSON document. */
  types: { big: string; ts: string; doc: string };
  /** Literal for 2026-10-11 10:00:00.000100. */
  ts: string;
  /** Adds one microsecond to the ts column, or undefined when the adapter keeps only milliseconds. */
  addMicrosecond?: string;
  writer: (url: string) => Promise<Writer>;
}

const RO = "ashiato_ro";

const withUser = (url: string, user: string, password: string, params: Record<string, string> = {}) => {
  const u = new URL(url);
  u.username = user;
  u.password = encodeURIComponent(password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

const dialects: Record<string, Dialect> = {
  postgres: {
    types: { big: "BIGINT", ts: "TIMESTAMP(6)", doc: "JSONB" },
    ts: "'2026-10-11 10:00:00.0001'",
    addMicrosecond: "ts + interval '1 microsecond'",
    async writer(url) {
      const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      const run = async (sql: string) => void (await c.query(sql));
      return {
        run,
        close: () => c.end(),
        async readOnlyUrl(tables) {
          await run(`DO $$ BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${RO}') THEN EXECUTE 'DROP OWNED BY ${RO}'; EXECUTE 'DROP ROLE ${RO}'; END IF;
          END $$`);
          await run(`CREATE ROLE ${RO} LOGIN PASSWORD '${RO}'`);
          await run(`GRANT USAGE ON SCHEMA public TO ${RO}`);
          await run(`GRANT SELECT ON ${tables.join(", ")} TO ${RO}`);
          return withUser(url, RO, RO);
        },
      };
    },
  },
  mysql: {
    types: { big: "BIGINT", ts: "DATETIME(6)", doc: "JSON" },
    ts: "'2026-10-11 10:00:00.000100'",
    addMicrosecond: "ts + INTERVAL 1 MICROSECOND",
    async writer(url) {
      const mysql = await loadDriver<typeof import("mysql2/promise")>("mysql2/promise", "MySQL");
      const c = await mysql.createConnection({ uri: url });
      const run = async (sql: string) => void (await c.query(sql));
      const db = new URL(url).pathname.slice(1);
      return {
        run,
        close: () => c.end(),
        async readOnlyUrl(tables) {
          await run(`DROP USER IF EXISTS '${RO}'@'%'`);
          await run(`CREATE USER '${RO}'@'%' IDENTIFIED BY '${RO}'`);
          for (const t of tables) await run(`GRANT SELECT ON \`${db}\`.\`${t}\` TO '${RO}'@'%'`);
          return withUser(url, RO, RO);
        },
      };
    },
  },
  mssql: {
    types: { big: "BIGINT", ts: "DATETIME2(7)", doc: "NVARCHAR(200)" },
    ts: "'2026-10-11 10:00:00.0001000'",
    addMicrosecond: "DATEADD(microsecond, 1, ts)",
    async writer(url) {
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
      const run = async (sql: string) => void (await pool.request().batch(sql));
      const password = "Ashiato#ro2026";
      return {
        run,
        close: () => pool.close(),
        async readOnlyUrl(tables) {
          await run(`IF USER_ID('${RO}') IS NOT NULL DROP USER ${RO}`);
          await run(`IF SUSER_ID('${RO}') IS NOT NULL DROP LOGIN ${RO}`);
          await run(`CREATE LOGIN ${RO} WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
          await run(`CREATE USER ${RO} FOR LOGIN ${RO}`);
          for (const t of tables) await run(`GRANT SELECT ON ${t} TO ${RO}`);
          return withUser(url, RO, password);
        },
      };
    },
  },
  oracle: {
    types: { big: "NUMBER(19)", ts: "TIMESTAMP(6)", doc: "VARCHAR2(200)" },
    ts: "TIMESTAMP '2026-10-11 10:00:00.000100'",
    // DATE / TIMESTAMP are read through the driver's Date: milliseconds only
    addMicrosecond: undefined,
    async writer(url) {
      const oracledb = await loadDriver<typeof import("oracledb")>("oracledb", "Oracle");
      const open = async (connUrl: string) => {
        const u = new URL(connUrl);
        return oracledb.getConnection({
          user: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
          connectString: `${u.hostname}:${u.port || 1521}${u.pathname}`,
        });
      };
      const c = await open(url);
      const run = async (sql: string) => void (await c.execute(sql, [], { autoCommit: true }));
      const owner = decodeURIComponent(new URL(url).username).toUpperCase();
      return {
        run,
        close: () => c.close(),
        async readOnlyUrl(tables) {
          const adminUrl = process.env.ASHIATO_TEST_ORACLE_ADMIN_URL;
          if (!adminUrl) return url;
          const admin = await open(adminUrl);
          try {
            await admin.execute(`BEGIN EXECUTE IMMEDIATE 'DROP USER ${RO} CASCADE'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
            await admin.execute(`CREATE USER ${RO} IDENTIFIED BY ${RO}`);
            await admin.execute(`GRANT CREATE SESSION TO ${RO}`);
          } finally {
            await admin.close();
          }
          for (const t of tables) await run(`GRANT SELECT ON ${t} TO ${RO}`);
          return withUser(url, RO, RO, { schema: owner });
        },
      };
    },
  },
};

const lower = (r: Row | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

for (const [dialect, d] of Object.entries(dialects)) {
  const url = process.env[`ASHIATO_TEST_${dialect.toUpperCase()}_URL`];
  describe.skipIf(!url)(`${dialect} adapter`, () => {
    it("records inserts, updates and deletes as a SELECT-only user", async () => {
      const w = await d.writer(url!);
      const tables = ["ashiato_orders", "ashiato_stock"];
      for (const t of tables) await w.run(`DROP TABLE ${t}`).catch(() => undefined);
      await w.run("CREATE TABLE ashiato_orders (id INT PRIMARY KEY, qty INT, note VARCHAR(20))");
      await w.run(`CREATE TABLE ashiato_stock (item_id INT PRIMARY KEY, qty INT, big ${d.types.big}, ts ${d.types.ts}, doc ${d.types.doc})`);
      await w.run(`INSERT INTO ashiato_stock (item_id, qty, big, ts, doc) VALUES (3, 50, 9007199254740993, ${d.ts}, '[{"qty":1},{"qty":2}]')`);

      const db = await connect(await w.readOnlyUrl(tables));
      try {
        const recorder = new Recorder(db, { tables });
        await recorder.start();
        // primary keys must be visible to a user that can only SELECT
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
        expect(lower(stock?.updated[0]?.after)).toMatchObject({ qty: 40, big: "9007199254740993" });

        // values a float or a millisecond Date would lose
        await w.run(`UPDATE ashiato_stock SET big = 9007199254740995, doc = '[{"qty":1},{"qty":3}]'`);
        if (d.addMicrosecond) await w.run(`UPDATE ashiato_stock SET ts = ${d.addMicrosecond}`);
        const exact = await recorder.checkpoint("exact");
        const changed = exact.diff.tables[0]?.updated[0]?.changed.map((c) => c.toLowerCase()).sort();
        expect(changed).toEqual(d.addMicrosecond ? ["big", "doc", "ts"] : ["big", "doc"]);
        expect(lower(exact.diff.tables[0]?.updated[0]?.after).big).toBe("9007199254740995");

        // nothing changed: nothing reported
        expect((await recorder.checkpoint("idle")).diff.tables).toEqual([]);

        await w.run("DELETE FROM ashiato_orders WHERE id = 1042");
        const del = await recorder.checkpoint("delete");
        expect(del.diff.tables).toHaveLength(1);
        expect(del.diff.tables[0]?.deleted).toHaveLength(1);
        expect(recorder.session.steps.every((s) => !s.skipped)).toBe(true);
      } finally {
        await db.close();
        for (const t of tables) await w.run(`DROP TABLE ${t}`).catch(() => undefined);
        await w.close();
      }
    }, 60_000);

    it.runIf(dialect === "postgres")("reads a partitioned table once, and dates as written", async () => {
      const w = await d.writer(url!);
      await w.run("DROP TABLE IF EXISTS ashiato_parted");
      await w.run("CREATE TABLE ashiato_parted (id INT, region TEXT, day DATE, PRIMARY KEY (id, region)) PARTITION BY LIST (region)");
      await w.run("CREATE TABLE ashiato_parted_jp PARTITION OF ashiato_parted FOR VALUES IN ('jp')");
      await w.run("INSERT INTO ashiato_parted VALUES (1, 'jp', '2026-10-11')");
      const db = await connect(await w.readOnlyUrl(["ashiato_parted"]));
      try {
        const recorder = new Recorder(db);
        const session = await recorder.start();
        expect(session.tables.map((t) => t.name)).toEqual(["ashiato_parted"]);
        await w.run("UPDATE ashiato_parted SET day = '2026-10-12'");
        const step = await recorder.checkpoint("move");
        expect(step.diff.tables).toHaveLength(1);
        expect(step.diff.tables[0]?.updated[0]).toMatchObject({ before: { day: "2026-10-11" }, after: { day: "2026-10-12" } });
      } finally {
        await db.close();
        await w.run("DROP TABLE ashiato_parted").catch(() => undefined);
        await w.close();
      }
    });
  });
}
