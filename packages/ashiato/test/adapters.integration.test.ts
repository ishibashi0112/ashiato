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
  /** Lets that user SELECT from a table created later (as SELECT on the whole schema would). */
  grant: (table: string) => Promise<void>;
}

interface Dialect {
  /** Column types for: a 64-bit integer, a timestamp with sub-millisecond precision, a JSON document. */
  types: { big: string; ts: string; doc: string };
  /** A decimal with more digits than a float holds. */
  dec: string;
  /** Literal for 2026-10-11 10:00:00.000100. */
  ts: string;
  /** Literal for the DATE 2026-10-11. */
  date: string;
  /** Adds one microsecond to the ts column, or undefined when the adapter keeps only milliseconds. */
  addMicrosecond?: string;
  /** Inserts rows 1..n into a table with columns (id, qty, note): qty = id % 10, note = NOTE. */
  fill: (table: string, n: number) => string;
  /** An extra column for the large table, to cover the adapter's other signature (SQL Server rowversion). */
  extraColumn?: string;
  writer: (url: string) => Promise<Writer>;
}

const NOTE = "x".repeat(100);

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
    dec: "NUMERIC(38, 18)",
    ts: "'2026-10-11 10:00:00.0001'",
    date: "'2026-10-11'",
    addMicrosecond: "ts + interval '1 microsecond'",
    fill: (t, n) => `INSERT INTO ${t} (id, qty, note) SELECT g, g % 10, '${NOTE}' FROM generate_series(1, ${n}) g`,
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
        grant: (t) => run(`GRANT SELECT ON ${t} TO ${RO}`),
      };
    },
  },
  mysql: {
    types: { big: "BIGINT", ts: "DATETIME(6)", doc: "JSON" },
    dec: "DECIMAL(38, 18)",
    ts: "'2026-10-11 10:00:00.000100'",
    date: "'2026-10-11'",
    addMicrosecond: "ts + INTERVAL 1 MICROSECOND",
    // a recursive CTE stops at 1000 rows by default (cte_max_recursion_depth): cross join digits instead
    fill: (t, n) => {
      const digit = "(SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
      const nums = `SELECT a.i + 10 * b.i + 100 * c.i + 1000 * d.i + 1 AS i FROM ${digit} a, ${digit} b, ${digit} c, ${digit} d`;
      return `INSERT INTO ${t} (id, qty, note) SELECT i, i % 10, '${NOTE}' FROM (${nums}) s WHERE i <= ${n}`;
    },
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
        grant: (t) => run(`GRANT SELECT ON \`${db}\`.\`${t}\` TO '${RO}'@'%'`),
      };
    },
  },
  mssql: {
    types: { big: "BIGINT", ts: "DATETIME2(7)", doc: "NVARCHAR(200)" },
    dec: "DECIMAL(38, 18)",
    ts: "'2026-10-11 10:00:00.0001000'",
    date: "'2026-10-11'",
    addMicrosecond: "DATEADD(microsecond, 1, ts)",
    fill: (t, n) =>
      `INSERT INTO ${t} (id, qty, note) SELECT i, i % 10, '${NOTE}' FROM (SELECT TOP (${n}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b) s`,
    extraColumn: "rv ROWVERSION",
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
        grant: (t) => run(`GRANT SELECT ON ${t} TO ${RO}`),
      };
    },
  },
  oracle: {
    types: { big: "NUMBER(19)", ts: "TIMESTAMP(6)", doc: "VARCHAR2(200)" },
    dec: "NUMBER(38, 18)",
    ts: "TIMESTAMP '2026-10-11 10:00:00.000100'",
    date: "DATE '2026-10-11'",
    addMicrosecond: "ts + NUMTODSINTERVAL(0.000001, 'SECOND')",
    fill: (t, n) => `INSERT INTO ${t} (id, qty, note) SELECT LEVEL, MOD(LEVEL, 10), '${NOTE}' FROM dual CONNECT BY LEVEL <= ${n}`,
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
      let separateUser = false;
      return {
        run,
        close: () => c.close(),
        async readOnlyUrl(tables) {
          const adminUrl = process.env.ASHIATO_TEST_ORACLE_ADMIN_URL;
          if (!adminUrl) return url;
          separateUser = true;
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
        grant: async (t) => {
          if (separateUser) await run(`GRANT SELECT ON ${t} TO ${RO}`);
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
      await w.run(
        `CREATE TABLE ashiato_stock (item_id INT PRIMARY KEY, qty INT, big ${d.types.big}, ts ${d.types.ts}, doc ${d.types.doc}, amount ${d.dec})`,
      );
      await w.run(
        `INSERT INTO ashiato_stock (item_id, qty, big, ts, doc, amount) VALUES (3, 50, 9007199254740993, ${d.ts}, '[{"qty":1},{"qty":2}]', 1.000000000000000001)`,
      );

      const db = await connect(await w.readOnlyUrl(tables));
      try {
        const recorder = new Recorder(db, { tables });
        await recorder.start();
        // every column type here can be read incrementally
        expect(recorder.fullReadTables()).toEqual([]);
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
        await w.run(`UPDATE ashiato_stock SET big = 9007199254740995, doc = '[{"qty":1},{"qty":3}]', amount = 1.000000000000000002`);
        if (d.addMicrosecond) await w.run(`UPDATE ashiato_stock SET ts = ${d.addMicrosecond}`);
        const exact = await recorder.checkpoint("exact");
        const changed = exact.diff.tables[0]?.updated[0]?.changed.map((c) => c.toLowerCase()).sort();
        expect(changed).toEqual(d.addMicrosecond ? ["amount", "big", "doc", "ts"] : ["amount", "big", "doc"]);
        expect(lower(exact.diff.tables[0]?.updated[0]?.after)).toMatchObject({ big: "9007199254740995", amount: "1.000000000000000002" });

        // integers and decimals that a number holds exactly read the same on every database
        await w.run("UPDATE ashiato_stock SET big = 42, amount = 493.80");
        const plain = await recorder.checkpoint("plain numbers");
        expect(lower(plain.diff.tables[0]?.updated[0]?.after)).toMatchObject({ big: 42, amount: 493.8 });

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

    it("re-reads only the part of a large table that changed", async () => {
      const w = await d.writer(url!);
      const t = "ashiato_big";
      const log = "ashiato_log"; // no primary key, empty at first: one bucket, no GROUP BY
      for (const x of [t, log]) await w.run(`DROP TABLE ${x}`).catch(() => undefined);
      await w.run(`CREATE TABLE ${t} (id INT PRIMARY KEY, qty INT, note VARCHAR(100)${d.extraColumn ? `, ${d.extraColumn}` : ""})`);
      await w.run(`CREATE TABLE ${log} (msg VARCHAR(20))`);
      await w.run(d.fill(t, 2000));
      const db = await connect(await w.readOnlyUrl([t, log]));
      // Oracle and MySQL keep the time of the last DDL in whole seconds, so a table is read in full at
      // each checkpoint until that second is surely over
      if (dialect === "oracle" || dialect === "mysql") await new Promise((r) => setTimeout(r, 2000));
      const read = db.readBuckets!.bind(db);
      const reads: { which?: number[]; rows: number }[] = [];
      db.readBuckets = async (table, key, n, which) => {
        const rows = await read(table, key, n, which);
        reads.push({ which, rows: rows.length });
        return rows;
      };
      const plain = (r: Row | undefined) => {
        const { id, qty, note } = lower(r);
        return { id: Number(id), qty: Number(qty), note };
      };
      try {
        const recorder = new Recorder(db, { tables: [t, log], rowsPerBucket: 20 });
        await recorder.start();
        expect(recorder.fullReadTables()).toEqual([]);
        expect(reads).toEqual([
          { which: undefined, rows: 2000 },
          { which: undefined, rows: 0 },
        ]);

        // the database's sums match the ones computed from the rows read: nothing is read again
        reads.length = 0;
        expect((await recorder.checkpoint("idle")).diff.tables).toEqual([]);
        expect(reads).toEqual([]);

        await w.run(`INSERT INTO ${log} (msg) VALUES ('saved')`);
        const logged = await recorder.checkpoint("log");
        expect(logged.diff.tables.map((x) => x.inserted.map(lower))).toEqual([[{ msg: "saved" }]]);

        reads.length = 0;
        await w.run(`UPDATE ${t} SET qty = 99 WHERE id = 1234`);
        const upd = await recorder.checkpoint("update");
        expect(upd.diff.tables).toHaveLength(1);
        expect(upd.diff.tables[0]!.updated.map((u) => [plain(u.before), plain(u.after)])).toEqual([
          [{ id: 1234, qty: 4, note: NOTE }, { id: 1234, qty: 99, note: NOTE }],
        ]);
        expect(reads).toHaveLength(1);
        expect(reads[0]!.rows).toBeLessThan(1000);

        reads.length = 0;
        await w.run(`INSERT INTO ${t} (id, qty, note) VALUES (5000, 1, 'new')`);
        await w.run(`DELETE FROM ${t} WHERE id = 10`);
        await w.run(`UPDATE ${t} SET id = 6000 WHERE id = 20`);
        const mixed = (await recorder.checkpoint("mixed")).diff.tables[0]!;
        expect(mixed.inserted.map(plain).map((r) => r.id).sort()).toEqual([5000, 6000]);
        expect(mixed.deleted.map(plain).map((r) => r.id).sort()).toEqual([10, 20]);
        expect(reads[0]!.rows).toBeLessThan(2000);

        reads.length = 0;
        expect((await recorder.checkpoint("idle again")).diff.tables).toEqual([]);
        expect(reads).toEqual([]);
      } finally {
        await db.close();
        for (const x of [t, log]) await w.run(`DROP TABLE ${x}`).catch(() => undefined);
        await w.close();
      }
    }, 60_000);

    it("watches tables created, altered or created again while recording", async () => {
      const w = await d.writer(url!);
      const [a, t] = ["ashiato_a", "ashiato_new"];
      for (const x of [a, t]) await w.run(`DROP TABLE ${x}`).catch(() => undefined);
      await w.run(`CREATE TABLE ${a} (id INT PRIMARY KEY)`);
      const db = await connect(await w.readOnlyUrl([a]));
      // (SQL Server's master database lets everyone read a few spt_ tables)
      const named = (x: { name: string }[] | undefined) => x?.map((r) => r.name.toLowerCase()).filter((n) => n.startsWith("ashiato_"));
      const plain = (r: Row | undefined) => {
        const { id, qty, note } = lower(r);
        return { id: Number(id), qty: Number(qty), note };
      };
      const byId = <T>(rows: T[], row: (x: T) => Row) => [...rows].sort((x, y) => plain(row(x)).id - plain(row(y)).id);
      try {
        // all the tables the user can read, so tables created later are watched too
        const recorder = new Recorder(db);
        const session = await recorder.start();
        expect(named(session.tables)).toEqual([a]);

        // a date and a long decimal: SQL Server and Oracle then read the table with a column list
        await w.run(`CREATE TABLE ${t} (id INT PRIMARY KEY, qty INT, day DATE, amount ${d.dec})`);
        await w.run(`INSERT INTO ${t} (id, qty, day, amount) VALUES (1, 1, ${d.date}, 1.5)`);
        await w.run(`INSERT INTO ${t} (id, qty, day, amount) VALUES (2, 2, ${d.date}, 2.5)`);
        await w.grant(t);
        const created = await recorder.checkpoint("create");
        expect(named(created.addedTables)).toEqual([t]);
        expect(created.diff.tables.map((x) => byId(x.inserted, (r) => r).map(plain))).toEqual([
          [
            { id: 1, qty: 1, note: undefined },
            { id: 2, qty: 2, note: undefined },
          ],
        ]);
        expect(named(recorder.session.tables)).toEqual([a, t]);

        // the new column is in the reads, and rows where it is NULL didn't change
        await w.run(`ALTER TABLE ${t} ADD note VARCHAR(20)`);
        await w.run(`UPDATE ${t} SET note = 'rush' WHERE id = 2`);
        const altered = await recorder.checkpoint("alter");
        expect(altered.diff.tables).toHaveLength(1);
        expect(altered.diff.tables[0]!.updated.map((u) => [plain(u.after), u.changed.map((c) => c.toLowerCase())])).toEqual([
          [{ id: 2, qty: 2, note: "rush" }, ["note"]],
        ]);
        // and in the row hash (MySQL): a change to it alone is seen
        await w.run(`UPDATE ${t} SET note = 'later' WHERE id = 1`);
        const later = await recorder.checkpoint("later");
        expect(later.diff.tables.map((x) => x.updated.map((u) => [plain(u.after), u.changed.map((c) => c.toLowerCase())]))).toEqual([
          [[{ id: 1, qty: 1, note: "later" }, ["note"]]],
        ]);

        // created again with other columns: nothing read with the old column list
        await w.run(`DROP TABLE ${t}`);
        await w.run(`CREATE TABLE ${t} (id INT PRIMARY KEY, qty INT, note VARCHAR(20))`);
        await w.run(`INSERT INTO ${t} (id, qty, note) VALUES (1, 1, 'later')`);
        await w.run(`INSERT INTO ${t} (id, qty, note) VALUES (2, 20, 'rush')`);
        await w.grant(t);
        const recreated = await recorder.checkpoint("create again");
        expect(recreated.skipped).toBeUndefined();
        expect(recreated.addedTables).toBeUndefined();
        const changed = byId(recreated.diff.tables[0]!.updated, (u) => u.after).map((u) => [
          plain(u.after),
          u.changed.map((c) => c.toLowerCase()).sort(),
        ]);
        expect(changed).toEqual([
          [{ id: 1, qty: 1, note: "later" }, ["amount", "day"]],
          [{ id: 2, qty: 20, note: "rush" }, ["amount", "day", "qty"]],
        ]);
        expect((await recorder.checkpoint("idle")).diff.tables).toEqual([]);

        await w.run(`DROP TABLE ${t}`);
        const dropped = await recorder.checkpoint("drop");
        expect(named(dropped.removedTables)).toEqual([t]);
        expect(dropped.diff.tables).toEqual([]);
        expect(dropped.skipped).toBeUndefined();
        expect(named(recorder.session.tables)).toEqual([a]);
      } finally {
        await db.close();
        for (const x of [a, t]) await w.run(`DROP TABLE ${x}`).catch(() => undefined);
        await w.close();
      }
    }, 60_000);

    it("changes a table's version when it is altered or created again, and only then", async () => {
      const w = await d.writer(url!);
      const t = "ashiato_ver";
      await w.run(`DROP TABLE ${t}`).catch(() => undefined);
      await w.run(`CREATE TABLE ${t} (id INT PRIMARY KEY, qty INT)`);
      const db = await connect(await w.readOnlyUrl([t]));
      // Oracle and MySQL keep the time of the last DDL in whole seconds: their versions settle once that second is over
      const settle = () => new Promise((r) => setTimeout(r, dialect === "oracle" || dialect === "mysql" ? 2100 : 0));
      const version = async () => (await db.listTables()).find((x) => x.name.toLowerCase() === t)?.version;
      try {
        await settle();
        const created = await version();
        expect(created).toBeTruthy();
        await w.run(`INSERT INTO ${t} (id, qty) VALUES (1, 1)`);
        await w.run(`UPDATE ${t} SET qty = 2`);
        expect(await version()).toBe(created);

        await w.run(`ALTER TABLE ${t} ADD note VARCHAR(20)`);
        await settle();
        const altered = await version();
        expect(altered).not.toBe(created);
        expect(await version()).toBe(altered);

        await w.run(`DROP TABLE ${t}`);
        await w.run(`CREATE TABLE ${t} (id INT PRIMARY KEY, qty INT, note VARCHAR(20))`);
        await w.grant(t);
        await settle();
        expect(await version()).not.toBe(altered);
      } finally {
        await db.close();
        await w.run(`DROP TABLE ${t}`).catch(() => undefined);
        await w.close();
      }
    }, 60_000);

    it.runIf(dialect === "oracle")("reads TIMESTAMP WITH LOCAL TIME ZONE the same whatever this machine's time zone", async () => {
      const w = await d.writer(url!);
      await w.run("DROP TABLE ashiato_local").catch(() => undefined);
      await w.run("CREATE TABLE ashiato_local (id INT PRIMARY KEY, at TIMESTAMP(6) WITH LOCAL TIME ZONE, at0 TIMESTAMP(0) WITH LOCAL TIME ZONE)");
      await w.run("INSERT INTO ashiato_local VALUES (1, TIMESTAMP '2026-10-11 00:00:00.000100 +00:00', TIMESTAMP '2026-10-11 09:00:00 +09:00')");
      const readOnly = await w.readOnlyUrl(["ashiato_local"]);
      const saved = process.env.ORA_SDTZ;
      try {
        // the driver sets the session's time zone from this machine's, or from ORA_SDTZ
        for (const zone of ["+09:00", "-05:00"]) {
          process.env.ORA_SDTZ = zone;
          const db = await connect(readOnly);
          try {
            const [t] = (await db.listTables()).filter((x) => /ashiato_local/i.test(x.name));
            expect(lower((await db.readRows(t!))[0])).toEqual({ id: 1, at: "2026-10-11 00:00:00.000100 +00:00", at0: "2026-10-11 00:00:00 +00:00" });
          } finally {
            await db.close();
          }
        }
      } finally {
        if (saved === undefined) delete process.env.ORA_SDTZ;
        else process.env.ORA_SDTZ = saved;
        await w.run("DROP TABLE ashiato_local").catch(() => undefined);
        await w.close();
      }
    });

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
