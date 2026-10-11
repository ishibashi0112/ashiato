import { exactDecimal, normalizeRow } from "../core/normalize.js";
import type { Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, groupBy, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { DbAdapter } from "./types.js";

const q = (id: string) => `[${id.replace(/]/g, "]]")}]`;
const name = (t: TableRef) => (t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name));

export async function connectMssql(url: URL): Promise<DbAdapter> {
  const mssql = await loadDriver<typeof import("mssql")>("mssql", "SQL Server");
  const params = url.searchParams;
  const pool = await new mssql.ConnectionPool({
    server: url.hostname,
    port: url.port ? Number(url.port) : 1433,
    user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    // reading a large table can take longer than the 15s default
    requestTimeout: Number(params.get("requestTimeout") ?? 120_000),
    options: {
      encrypt: params.get("encrypt") === "true",
      trustServerCertificate: params.get("trustServerCertificate") !== "false",
      instanceName: params.get("instance") ?? undefined,
      // opt-in: routed to a readable secondary, snapshots could lag behind the app's writes
      readOnlyIntent: params.get("applicationIntent")?.toLowerCase() === "readonly",
    },
  }).connect();

  const query = async (sql: string, inputs: Record<string, string> = {}) => {
    const req = pool.request();
    for (const [k, v] of Object.entries(inputs)) req.input(k, mssql.NVarChar, v);
    return (await req.query(sql)).recordset as Record<string, unknown>[];
  };

  // tedious reads DECIMAL / NUMERIC and MONEY as floating point numbers, which rounds values with
  // more than 15 significant digits: such columns are read as text (money with all four decimals).
  // BIGINT comes as text. Both are then a number when exact, like the other databases' adapters.
  const columnLists = new Map<string, Promise<{ select: (alias?: string) => string; exact: string[] }>>();
  const columnsOf = (t: TableRef) => {
    let c = columnLists.get(name(t));
    if (!c) {
      c = query(
        `SELECT name, TYPE_NAME(system_type_id) AS type, precision FROM sys.columns
          WHERE object_id = OBJECT_ID(@t) AND ISNULL(COLUMNPROPERTY(object_id, name, 'IsHidden'), 0) = 0
          ORDER BY column_id`,
        { t: name(t) },
      ).then((cols) => {
        const wide = (c: Record<string, unknown>) => c.type === "money" || (/^(decimal|numeric)$/.test(String(c.type)) && Number(c.precision) > 15);
        const exact = cols.filter((c) => wide(c) || c.type === "bigint").map((c) => String(c.name));
        if (!cols.some(wide)) return { select: (alias?: string) => (alias ? `${alias}.*` : "*"), exact };
        const select = (alias?: string) =>
          cols
            .map((c) => {
              const col = `${alias ? `${alias}.` : ""}${q(String(c.name))}`;
              if (!wide(c)) return col;
              return `CONVERT(varchar(50), ${col}${c.type === "money" ? ", 2" : ""}) AS ${q(String(c.name))}`;
            })
            .join(", ");
        return { select, exact };
      });
      c.catch(() => columnLists.delete(name(t)));
      columnLists.set(name(t), c);
    }
    return c;
  };
  const exactRow = (row: Row, exact: string[]) => {
    for (const c of exact) row[c] = exactDecimal(row[c]);
    return row;
  };

  // Signature: the table's rowversion column when it has one (a new, larger value on every insert
  // and update), otherwise a hash of the row as JSON (SQL Server 2016 or later). Buckets: CHECKSUM of the key.
  const rowversions = new Map<string, Promise<string | undefined>>();
  const rowversionOf = (t: TableRef) => {
    let rv = rowversions.get(name(t));
    if (!rv) {
      rv = query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(@t) AND system_type_id = 189", { t: name(t) }).then((r) =>
        r[0] ? String(r[0].name) : undefined,
      );
      rv.catch(() => rowversions.delete(name(t)));
      rowversions.set(name(t), rv);
    }
    return rv;
  };
  /** FROM clause and signature expression. The hash goes through CROSS APPLY: SUM can't take a subquery. */
  const signed = async (t: TableRef) => {
    const rv = await rowversionOf(t);
    if (rv) return { from: `${name(t)} AS ${ALIAS}`, sig: `CAST(${ALIAS}.${q(rv)} AS BIGINT)` };
    const json = `(SELECT ${ALIAS}.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)`;
    return {
      from: `${name(t)} AS ${ALIAS} CROSS APPLY (SELECT CAST(SUBSTRING(HASHBYTES('SHA2_256', ${json}), 1, 8) AS BIGINT) AS sig) AS ashiato_h`,
      sig: "ashiato_h.sig",
    };
  };
  const bucketOf = (key: string[], n: number) =>
    key.length === 0 || n <= 1 ? "0" : `((CHECKSUM(${key.map((c) => `${ALIAS}.${q(c)}`).join(", ")}) % ${n}) + ${n}) % ${n}`;

  return {
    dialect: "mssql",
    async listTables() {
      // the base tables of INFORMATION_SCHEMA.TABLES. Version: object_id (a new one when created again)
      // and modify_date, which every ALTER TABLE changes.
      const rows = await query(
        `SELECT s.name AS TABLE_SCHEMA, o.name AS TABLE_NAME, CONCAT(o.object_id, ':', CONVERT(varchar(23), o.modify_date, 121)) AS version
           FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.type = 'U' ORDER BY s.name, o.name`,
      );
      return rows.map((r) => ({ schema: String(r.TABLE_SCHEMA), name: String(r.TABLE_NAME), version: String(r.version) }));
    },
    async primaryKey(t) {
      const rows = await query(
        `SELECT k.COLUMN_NAME
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS c
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
             ON k.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA
          WHERE c.CONSTRAINT_TYPE = 'PRIMARY KEY' AND c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
          ORDER BY k.ORDINAL_POSITION`,
        { schema: t.schema ?? "dbo", table: t.name },
      );
      return rows.map((r) => String(r.COLUMN_NAME));
    },
    async countRows(t) {
      const rows = await query(`SELECT COUNT_BIG(*) AS n FROM ${name(t)}`);
      return Number(rows[0]?.n ?? 0);
    },
    async readRows(t): Promise<Row[]> {
      const { select, exact } = await columnsOf(t);
      return (await query(`SELECT ${select()} FROM ${name(t)}`)).map((r) => exactRow(normalizeRow(r), exact));
    },
    async bucketSums(t, key, n) {
      const b = bucketOf(key, n);
      const { from, sig } = await signed(t);
      return toSums(
        await query(`SELECT ${b} AS b, COUNT_BIG(*) AS n, CAST(SUM(CAST(${sig} AS DECIMAL(38, 0))) AS VARCHAR(40)) AS s FROM ${from}${groupBy(b)}`),
      );
    },
    async readBuckets(t, key, n, which) {
      const b = bucketOf(key, n);
      const { from, sig } = await signed(t);
      const { select, exact } = await columnsOf(t);
      const where = which ? ` WHERE ${b} IN (${bucketList(which)})` : "";
      return (await query(`SELECT ${b} AS ${q(BUCKET)}, CAST(${sig} AS VARCHAR(20)) AS ${q(SIG)}, ${select(ALIAS)} FROM ${from}${where}`)).map(
        (r) => {
          const b = toBucketedRow(r);
          exactRow(b.row, exact);
          return b;
        },
      );
    },
    forget(t) {
      columnLists.delete(name(t));
      rowversions.delete(name(t));
    },
    async close() {
      await pool.close();
    },
  };
}
