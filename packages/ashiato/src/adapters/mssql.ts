import { exactDecimal, normalizeRow, normalizeValue } from "../core/normalize.js";
import type { JsonValue, Row, TableRef } from "../core/types.js";
import { ALIAS, BUCKET, SIG, bucketList, groupBy, toBucketedRow, toSums } from "./buckets.js";
import { loadDriver } from "./load.js";
import type { ColumnInfo, DbAdapter, QueryResult } from "./types.js";

const q = (id: string) => `[${id.replace(/]/g, "]]")}]`;
const name = (t: TableRef) => (t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name));

const text = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v));

/** sys.columns → a type as written in CREATE TABLE: varchar(20), nvarchar(max), decimal(10,2), datetime2(3). */
function columnInfo(c: Record<string, unknown>): ColumnInfo {
  const type = String(c.type);
  const length = Number(c.max_length);
  let full = type;
  if (/^(var)?(char|binary)$/.test(type)) full = `${type}(${length === -1 ? "max" : length})`;
  else if (/^n(var)?char$/.test(type)) full = `${type}(${length === -1 ? "max" : length / 2})`;
  else if (/^(decimal|numeric)$/.test(type)) full = `${type}(${c.precision},${c.scale})`;
  else if (/^(datetime2|datetimeoffset|time)$/.test(type)) full = `${type}(${c.scale})`;
  return { name: String(c.name), type: full, nullable: Boolean(c.is_nullable), comment: text(c.comment) };
}

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

  /**
   * A value of a query's result. Date and time columns come as Dates holding the stored wall-clock
   * time in UTC (the driver's useUTC): written back as that text, like the other databases give it.
   * DATETIMEOFFSET is a moment, so it stays ISO text in UTC.
   */
  const resultValue = (v: unknown, type: unknown): JsonValue => {
    if (!(v instanceof Date) || type === mssql.DateTimeOffset) return type === mssql.BigInt ? exactDecimal(v) : normalizeValue(v);
    const iso = normalizeValue(v);
    if (typeof iso !== "string") return iso;
    if (type === mssql.Date) return iso.slice(0, 10);
    if (type === mssql.Time) return iso.slice(11).replace(/Z$/, "");
    if (type === mssql.DateTime || type === mssql.DateTime2 || type === mssql.SmallDateTime) return iso.replace("T", " ").replace(/Z$/, "");
    return iso;
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
    async listViews() {
      const rows = await query(
        `SELECT s.name AS TABLE_SCHEMA, o.name AS TABLE_NAME FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE o.type = 'V' AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
      );
      return rows.map((r) => ({ schema: String(r.TABLE_SCHEMA), name: String(r.TABLE_NAME) }));
    },
    async describeTable(t) {
      // the comments are the MS_Description extended property (what A5:SQL Mk-2 and SSMS show as the description)
      const cols = await query(
        `SELECT c.name, TYPE_NAME(c.system_type_id) AS type, c.max_length, c.precision, c.scale, c.is_nullable,
                CONVERT(nvarchar(4000), ep.value) AS comment
           FROM sys.columns c
           LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
          WHERE c.object_id = OBJECT_ID(@t) AND ISNULL(COLUMNPROPERTY(c.object_id, c.name, 'IsHidden'), 0) = 0
          ORDER BY c.column_id`,
        { t: name(t) },
      );
      const table = await query(
        `SELECT CONVERT(nvarchar(4000), value) AS comment FROM sys.extended_properties
          WHERE class = 1 AND major_id = OBJECT_ID(@t) AND minor_id = 0 AND name = N'MS_Description'`,
        { t: name(t) },
      );
      return { columns: cols.map(columnInfo), comment: text(table[0]?.comment) };
    },
    async runQuery(sql, maxRows) {
      // SQL Server has no read-only transaction: the statement was checked to be a SELECT, the user
      // should only be granted SELECT, and it runs in a transaction that is always rolled back.
      // Rows are streamed, so a large result is cut off at maxRows.
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      const req = new mssql.Request(tx);
      req.stream = true;
      req.arrayRowMode = true;
      let types: unknown[] = [];
      let columns: string[] = [];
      let sets = 0;
      let more = false;
      let error: Error | undefined;
      const rows: JsonValue[][] = [];
      req.on("recordset", (cols: { name: string; type: unknown }[]) => {
        // only the first result is shown (SELECT 1 SELECT 2 without a semicolon returns two)
        if (++sets > 1) return;
        columns = cols.map((c) => c.name);
        types = cols.map((c) => c.type);
      });
      req.on("row", (row: unknown[]) => {
        if (sets !== 1 || more) return;
        if (rows.length === maxRows) {
          more = true;
          req.cancel();
          return;
        }
        rows.push(row.map((v, i) => resultValue(v, types[i])));
      });
      req.on("error", (e: Error) => {
        if (!more) error ??= e;
      });
      try {
        // in stream mode the promise settles after the "done" event, errors having gone to "error"
        await req.query(sql);
      } finally {
        // fails when the server already ended the transaction (a severe error): nothing is left to undo
        await tx.rollback().catch(() => undefined);
      }
      if (error) throw error;
      return { columns, rows, more } satisfies QueryResult;
    },
    async close() {
      await pool.close();
    },
  };
}
