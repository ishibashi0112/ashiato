import { normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, groupBy, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const name = (t: TableRef) => `${q(t.schema ?? "public")}.${q(t.name)}`;

/**
 * Types read as the server's text instead of being parsed: dates and times (pg's Date drops
 * microseconds and shifts DATE / TIMESTAMP by the local time zone), intervals, and JSON.
 * date, time, timestamp, timestamptz, timetz, interval, json, jsonb, and their arrays; numeric[]
 * (pg parses it as floats, while plain numeric already stays text).
 */
const RAW_TYPES = new Set([1082, 1083, 1114, 1184, 1266, 1186, 114, 3802, 1182, 1183, 1115, 1185, 1270, 1187, 199, 3807, 1231]);

export async function connectPostgres(url: URL): Promise<DbAdapter> {
  const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
  // A pool of one reconnects by itself when the server drops the connection (restart, idle timeout).
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 1,
    idleTimeoutMillis: 0,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        RAW_TYPES.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  // Without a listener, an idle connection being closed by the server would crash the process.
  pool.on("error", () => undefined);
  const query = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Record<string, unknown>[];
  await query("SELECT 1");

  // Partitioned parents already return their partitions' rows; plain tables are read with ONLY so
  // rows of inheriting child tables aren't counted twice. Filled by listTables (the recorder calls it at each checkpoint).
  const partitioned = new Set<string>();
  const from = (t: TableRef) => (partitioned.has(name(t)) ? name(t) : `ONLY ${name(t)}`);

  // Buckets: a hash of the key. Signature: xmin, the id of the transaction that wrote the row
  // version. Every insert and update writes a new row version with a newer id.
  const bucketOf = (key: string[], n: number) => {
    if (key.length === 0 || n <= 1) return "0";
    const k = key.length === 1 ? `${ALIAS}.${q(key[0]!)}::text` : `row(${key.map((c) => `${ALIAS}.${q(c)}`).join(", ")})::text`;
    return `((hashtext(${k}) % ${n}) + ${n}) % ${n}`;
  };

  return {
    dialect: "postgres",
    async listTables() {
      // pg_catalog rather than information_schema, which hides constraints from SELECT-only users.
      // Version: the table's oid (a new one when created again), its primary key constraint, and its columns.
      const rows = await query(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
                concat_ws(':', c.oid,
                  (SELECT k.oid FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p'),
                  (SELECT hashtext(string_agg(a.attname || ' ' || a.atttypid, ',' ORDER BY a.attnum)) FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)) AS version
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relpersistence <> 't'
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
            AND has_table_privilege(c.oid, 'SELECT')
          ORDER BY 1, 2`,
      );
      partitioned.clear();
      return rows.map((r) => {
        const t = { schema: String(r.schema), name: String(r.name) };
        if (r.kind === "p") partitioned.add(name(t));
        return { ...t, version: String(r.version) };
      });
    },
    async primaryKey(t) {
      const rows = await query(
        `SELECT a.attname AS column_name
           FROM pg_constraint c
           CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.contype = 'p' AND c.conrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
          ORDER BY k.ord`,
        [t.schema ?? "public", t.name],
      );
      return rows.map((r) => String(r.column_name));
    },
    async countRows(t) {
      return Number((await query(`SELECT COUNT(*) AS n FROM ${from(t)}`))[0]?.n ?? 0);
    },
    async readRows(t): Promise<Row[]> {
      return (await query(`SELECT * FROM ${from(t)}`)).map(normalizeRow);
    },
    async bucketSums(t, key, n) {
      const b = bucketOf(key, n);
      return toSums(
        await query(`SELECT ${b} AS b, count(*) AS n, sum(${ALIAS}.xmin::text::bigint)::text AS s FROM ${from(t)} AS ${ALIAS}${groupBy(b)}`),
      );
    },
    async readBuckets(t, key, n, which) {
      const b = bucketOf(key, n);
      const where = which ? ` WHERE ${b} IN (${bucketList(which)})` : "";
      return (
        await query(`SELECT ${b} AS "${BUCKET}", ${ALIAS}.xmin::text AS "${SIG}", ${ALIAS}.* FROM ${from(t)} AS ${ALIAS}${where}`)
      ).map(toBucketedRow);
    },
    async close() {
      await pool.end();
    },
  };
}
