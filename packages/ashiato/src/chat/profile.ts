import { createHmac } from "node:crypto";
import type { ColumnInfo, DbAdapter, ForeignKey, TableInfo } from "../adapters/types.js";
import { tableId } from "../core/diff.js";
import type { JsonValue, TableRef } from "../core/types.js";

/**
 * `ashiato schema --data`: what the rows of the test database look like, for an AI in a chat that
 * would otherwise ask the person to run a SELECT and paste the result. Everything is read with
 * SELECT through `runQuery` (read-only, or always rolled back). Actual values are written in three
 * places only (the values of a column that reads as a code, the lowest and highest number or date,
 * and the sample rows asked for with --samples), and never for a hidden column: the rest is counts,
 * lengths and shapes (C999).
 */

/** What a column holds, as far as describing its data goes. */
export type ColumnKind =
  /** lowest and highest value, values when it reads as a code */
  | "number"
  /** lowest and highest value */
  | "date"
  /** length, shape, values when it reads as a code */
  | "string"
  /** values (bit, boolean) */
  | "flag"
  /** long text: NULLs and length */
  | "text"
  /** can be counted but isn't shown (uuid): NULLs and number of values */
  | "other"
  /** NULLs only (binary, XML, JSON, ...) */
  | "opaque"
  /** not read at all (Oracle LONG, which no expression may use) */
  | "skip";

/** The kind of a column, from the type `describeTable` gives. */
export function columnKind(dialect: string, type: string): ColumnKind {
  const t = type.toLowerCase().trim();
  const base = t.replace(/\(.*$/, "").trim();
  switch (dialect) {
    case "mssql":
      if (/^(tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/.test(base)) return "number";
      if (base === "bit") return "flag";
      if (/^(date|datetime|datetime2|smalldatetime|datetimeoffset|time)$/.test(base)) return "date";
      if (/^n?(var)?char$/.test(base)) return t.includes("(max)") ? "text" : "string";
      if (base === "uniqueidentifier") return "other";
      // text / ntext can't be compared or measured with LEN; timestamp is rowversion (binary)
      return "opaque";
    case "oracle":
      if (/^(number|float|binary_float|binary_double|integer)$/.test(base)) return "number";
      if (base === "date" || base.startsWith("timestamp")) return "date";
      if (/^n?(var)?char2?$/.test(base)) return "string";
      if (/^n?clob$/.test(base)) return "text";
      if (base === "long") return "skip";
      return "opaque";
    case "postgres":
      if (/^(smallint|integer|bigint|numeric|decimal|real|double precision|money)$/.test(base)) return "number";
      if (base === "boolean") return "flag";
      if (/^(date|timestamp|time)\b/.test(base)) return "date";
      if (/^(character varying|varchar|character|char|text|citext|bpchar)$/.test(base)) return "string";
      if (base === "uuid") return "other";
      return "opaque";
    case "mysql":
      if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)\b/.test(base)) return "number";
      if (base === "bit") return "flag";
      if (/^(date|datetime|timestamp|time)$/.test(base)) return "date";
      if (/^(char|varchar|enum|set)$/.test(base)) return "string";
      if (/^(tiny|medium|long)?text$/.test(base)) return "text";
      return "opaque";
    case "sqlite": {
      // the declared type's affinity (https://www.sqlite.org/datatype3.html), dates and booleans by name
      const u = t.toUpperCase();
      if (u === "") return "other";
      if (u.includes("INT")) return "number";
      if (/BOOL/.test(u)) return "flag";
      if (/DATE|TIME/.test(u)) return "date";
      if (/CHAR|CLOB|TEXT/.test(u)) return "string";
      if (u.includes("BLOB")) return "opaque";
      return "number";
    }
    default:
      return "opaque";
  }
}

/** A quoted column name. */
export function quoteColumn(dialect: string, name: string): string {
  if (dialect === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

const LENGTH: Record<string, string> = { mssql: "LEN", oracle: "LENGTH", postgres: "CHAR_LENGTH", mysql: "CHAR_LENGTH", sqlite: "LENGTH" };

/** SELECT <select> FROM <from> [ORDER BY ...], first n rows only, in the database's own words. */
export function firstRows(dialect: string, select: string, from: string, n: number, orderBy?: string): string {
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";
  if (dialect === "mssql") return `SELECT TOP (${n}) ${select} FROM ${from}${order}`;
  // ROWNUM: Oracle 11g has no FETCH FIRST
  if (dialect === "oracle") return orderBy ? `SELECT * FROM (SELECT ${select} FROM ${from}${order}) WHERE ROWNUM <= ${n}` : `SELECT ${select} FROM ${from} WHERE ROWNUM <= ${n}`;
  return `SELECT ${select} FROM ${from}${order} LIMIT ${n}`;
}

/** Columns to hide (`hide`) or to show although their name looks personal (`show`): `TABLE.COLUMN` or `COLUMN`, with * and ?. */
export interface DataRules {
  hide?: string[];
  show?: string[];
}

/** Reads docs/db/data-rules.json's text: only `hide` and `show`, each a list of patterns. */
export function parseDataRules(text: string, file: string): DataRules {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not JSON (${(e as Error).message})`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${file}: expected { "hide": [...], "show": [...] }`);
  const rules: DataRules = {};
  for (const [k, v] of Object.entries(json)) {
    if (k !== "hide" && k !== "show") throw new Error(`${file}: unknown key "${k}" (only "hide" and "show")`);
    if (!Array.isArray(v) || !v.every((p) => typeof p === "string")) throw new Error(`${file}: "${k}" must be a list of patterns like "M_EMPLOYEE.*" or "*.SALARY"`);
    rules[k] = v as string[];
  }
  return rules;
}

const wildcard = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

function ruleMatches(patterns: string[] | undefined, table: TableRef, column: string): boolean {
  for (const raw of patterns ?? []) {
    const p = raw.trim();
    const dot = p.lastIndexOf(".");
    const col = dot < 0 ? p : p.slice(dot + 1);
    if (!wildcard(col).test(column)) continue;
    if (dot < 0) return true;
    const tbl = wildcard(p.slice(0, dot));
    if (tbl.test(table.name) || tbl.test(tableId(table))) return true;
  }
  return false;
}

/**
 * Words in a column's name or comment that say it may hold something about a person, a credential or
 * free text. Hiding too much only costs the AI a hint; the person can show a column with data-rules.json.
 */
const SENSITIVE = [
  // names and contact
  /NAME|KANA|SHIMEI|SIMEI|TEL|PHONE|FAX|MOBILE|KEITAI|DENWA|MAIL|ADDR|JUSHO|JUSYO|JUUSYO|ZIP|POSTAL|POST_?CODE|YUU?BIN|BIRTH|SEINEN|TANJOU?/i,
  /氏名|名前|名称|フリガナ|ふりがな|カナ|かな|電話|携帯|ＴＥＬ|ＦＡＸ|メール|住所|郵便|〒|生年月日|誕生|名$/,
  // credentials and numbers
  /PASS|PWD|TOKEN|SECRET|CREDIT|CARD_?N(O|UM)|ACCOUNT_?N(O|UM)|ACCT_?NO|KOU?ZA|MY_?NUMBER/i,
  /パスワード|暗証|口座|カード番号|マイナンバー|個人番号/,
];
/** Free text: the sample rows show only its length. */
const FREE_TEXT = [/NOTE|MEMO|REMARK|COMMENT|BIKOU?|DESCRIPTION/i, /備考|メモ|摘要|コメント|説明|内容/];

const said = (words: RegExp[], c: ColumnInfo) => words.some((w) => w.test(c.name) || (c.comment !== undefined && w.test(c.comment)));

/** Whether a column's values are left out: data-rules.json's hide, then its show, then the words above. */
export function isHidden(table: TableRef, c: ColumnInfo, rules: DataRules): boolean {
  if (ruleMatches(rules.hide, table, c.name)) return true;
  if (ruleMatches(rules.show, table, c.name)) return false;
  return said(SENSITIVE, c) || said(FREE_TEXT, c);
}

/** The shape of a value: digits 9, letters A / a, kana あ / ア / ｱ, kanji 漢; anything else stays. */
export function shapeOf(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x30 && c <= 0x39) out += "9";
    else if (c >= 0x41 && c <= 0x5a) out += "A";
    else if (c >= 0x61 && c <= 0x7a) out += "a";
    else if (c >= 0xff10 && c <= 0xff19) out += "９";
    else if (c >= 0xff21 && c <= 0xff3a) out += "Ａ";
    else if (c >= 0xff41 && c <= 0xff5a) out += "ａ";
    else if (c >= 0x3041 && c <= 0x3096) out += "あ";
    else if ((c >= 0x30a1 && c <= 0x30fa) || c === 0x30fc) out += "ア";
    else if (c >= 0xff66 && c <= 0xff9f) out += "ｱ";
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || c === 0x3005) out += "漢";
    else out += ch;
  }
  return out;
}

/**
 * The shapes of a column's values when they are few (3 at most, 30 characters at most), most common
 * first. A letter that is the same in every value of a shape is written as itself (C999).
 */
export function formatsOf(values: string[]): string[] | undefined {
  const groups = new Map<string, string[][]>();
  for (const v of values) {
    const text = v.replace(/ +$/, "");
    const shape = shapeOf(text);
    if ([...shape].length > 30) return undefined;
    const list = groups.get(shape) ?? [];
    list.push([...text]);
    groups.set(shape, list);
    if (groups.size > 3) return undefined;
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([shape, chars]) =>
      [...shape]
        .map((s, i) => {
          if (!"AaＡａ".includes(s)) return s;
          const first = chars[0]![i]!;
          return chars.every((c) => c[i] === first) ? first : s;
        })
        .join(""),
    );
}

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  hidden: boolean;
  /** Free text (by name, by comment, or longer than 50 characters): the sample rows show its length only. */
  freeText: boolean;
  /** Of the rows read. */
  nulls?: number;
  distinct?: number;
  min?: JsonValue;
  max?: JsonValue;
  minLength?: number;
  maxLength?: number;
  /** Every value and its count, most frequent first, when the column reads as a code. */
  values?: { value: JsonValue; count: number }[];
  formats?: string[];
  /** Its statements failed; the database's message is in TableProfile.problems. */
  failed?: boolean;
}

/** A relation between two tables: a declared foreign key, or one inferred from the values. */
export interface Reference {
  columns: string[];
  references: TableRef;
  referencedColumns: string[];
  inferred: boolean;
}

export interface TableProfile {
  table: TableRef;
  rows: number;
  /** The rows the column figures come from: all of them, or the first `sampleRows` of a large table. */
  read: number;
  columns: ColumnProfile[];
  references: Reference[];
  /** --samples: the column names and the rows' cells, hidden columns already replaced. */
  samples?: { columns: string[]; rows: SampleCell[][]; ordered: boolean };
  /** Messages for the terminal: statements that failed and why (they may quote values, so never in the file). */
  problems: string[];
}

/** A cell of a sample row: a value, a stand-in for a hidden one, the length of a free text, or left out. */
export type SampleCell = { value: JsonValue } | { standIn: string } | { length: number } | { date: true } | { omitted: true };

export interface ProfileOptions {
  /** Tables with more rows than this are described from their first `sampleRows` rows; the count stays exact. */
  largeTable: number;
  sampleRows: number;
  /** Sample rows to show per table (0: none). */
  samples: number;
  rules: DataRules;
  /** Made for one run: the same value gets the same stand-in in every table, and a stand-in can't be traced back. */
  key: Buffer;
}

export const PROFILE_DEFAULTS = { largeTable: 1_000_000, sampleRows: 100_000 } as const;

/** Columns per statement: Oracle allows 1000 expressions in a SELECT list. */
const CHUNK = 30;
/** A column reads as a code with at most this many values... */
const MAX_CODES = 20;
/** ...each used by this many rows on average (so 5 people's names in 5 rows are no code)... */
const MIN_USES = 5;
/** ...and, for text, at most this long. */
const MAX_CODE_LENGTH = 20;
/** Values read to find a column's shapes. */
const SHAPE_VALUES = 1000;

const num = (v: JsonValue | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Describes one table's rows. `info` and `key` are what `describeTable` and `primaryKey` gave. */
export async function profileTable(db: DbAdapter, table: TableRef, info: TableInfo, key: string[], options: ProfileOptions): Promise<TableProfile> {
  if (!db.runQuery || !db.fromClause) throw new Error(`ashiato schema --data can't read rows on ${db.dialect}`);
  const run = db.runQuery.bind(db);
  const dialect = db.dialect;
  const col = (name: string) => `s.${quoteColumn(dialect, name)}`;
  const from = db.fromClause(table);
  const rows = await db.countRows(table);
  const large = rows > options.largeTable;
  const src = large ? `(${firstRows(dialect, "*", from, options.sampleRows)}) s` : `${from} s`;
  const problems: string[] = [];
  const columns: ColumnProfile[] = info.columns.map((c) => ({
    name: c.name,
    kind: columnKind(dialect, c.type),
    hidden: isHidden(table, c, options.rules),
    freeText: said(FREE_TEXT, c),
  }));
  let read = large ? Math.min(rows, options.sampleRows) : rows;

  // NULLs, number of values, lowest and highest (numbers, dates) or length (text): one statement per 30 columns
  const figures = async (chunk: ColumnProfile[]) => {
    const exprs: string[] = ["COUNT(*)"];
    const slots: { c: ColumnProfile; what: "nulls" | "distinct" | "min" | "max" | "minLength" | "maxLength" }[] = [];
    const add = (c: ColumnProfile, what: (typeof slots)[number]["what"], expr: string) => {
      exprs.push(expr);
      slots.push({ c, what });
    };
    for (const c of chunk) {
      const x = col(c.name);
      add(c, "nulls", `SUM(CASE WHEN ${x} IS NULL THEN 1 ELSE 0 END)`);
      if (c.kind !== "opaque" && c.kind !== "text") add(c, "distinct", `COUNT(DISTINCT ${x})`);
      // a hidden column's lowest and highest values aren't even read
      if ((c.kind === "number" || c.kind === "date") && !c.hidden) {
        add(c, "min", `MIN(${x})`);
        add(c, "max", `MAX(${x})`);
      }
      if (c.kind === "string" || c.kind === "text") {
        add(c, "minLength", `MIN(${LENGTH[dialect] ?? "LENGTH"}(${x}))`);
        add(c, "maxLength", `MAX(${LENGTH[dialect] ?? "LENGTH"}(${x}))`);
      }
    }
    const sql = `SELECT ${exprs.map((e, i) => `${e} AS a${i}`).join(", ")} FROM ${src}`;
    const r = (await run(sql, 1)).rows[0] ?? [];
    read = num(r[0]);
    slots.forEach(({ c, what }, i) => {
      const v = r[i + 1] ?? null;
      if (what === "min" || what === "max") c[what] = v;
      else if (v !== null) c[what] = num(v);
    });
  };
  const readable = columns.filter((c) => c.kind !== "skip");
  for (let i = 0; i < readable.length; i += CHUNK) {
    const chunk = readable.slice(i, i + CHUNK);
    try {
      await figures(chunk);
    } catch {
      // find the column the database refuses, and keep the others
      for (const c of chunk) {
        try {
          await figures([c]);
        } catch (e) {
          c.failed = true;
          problems.push(`${tableId(table)}.${c.name}: ${(e as Error).message}`);
        }
      }
    }
  }

  for (const c of readable) {
    if (c.failed || c.hidden) continue;
    const nonNull = read - (c.nulls ?? 0);
    const distinct = c.distinct ?? 0;
    const code =
      distinct > 0 &&
      distinct <= MAX_CODES &&
      (c.kind === "flag" ||
        ((c.kind === "number" || (c.kind === "string" && (c.maxLength ?? Infinity) <= MAX_CODE_LENGTH)) && nonNull >= MIN_USES * distinct));
    try {
      if (code) {
        const x = col(c.name);
        const res = await run(`SELECT ${x} AS v, COUNT(*) AS n FROM ${src} WHERE ${x} IS NOT NULL GROUP BY ${x} ORDER BY 2 DESC, 1`, MAX_CODES + 1);
        c.values = res.rows.map((r) => ({ value: r[0] ?? null, count: num(r[1]) }));
      } else if (c.kind === "string" && distinct >= MIN_USES && (c.maxLength ?? Infinity) <= 30) {
        const x = col(c.name);
        const res = await run(`SELECT DISTINCT ${x} AS v FROM ${src} WHERE ${x} IS NOT NULL`, SHAPE_VALUES);
        // the values are only turned into shapes here: none of them is kept
        const formats = formatsOf(res.rows.map((r) => String(r[0])));
        if (formats) c.formats = formats;
      }
    } catch (e) {
      problems.push(`${tableId(table)}.${c.name}: ${(e as Error).message}`);
    }
  }
  for (const c of columns) if (c.kind === "text" || (c.maxLength ?? 0) > 50) c.freeText = true;

  const references: Reference[] = [];
  if (db.foreignKeys) {
    try {
      for (const fk of await db.foreignKeys(table)) references.push({ ...fk, inferred: false });
    } catch (e) {
      problems.push(`${tableId(table)} (foreign keys): ${(e as Error).message}`);
    }
  }

  const profile: TableProfile = { table, rows, read, columns, references, problems };
  if (options.samples > 0 && rows > 0) {
    try {
      profile.samples = await sampleRows(db, from, key, columns, options);
    } catch (e) {
      problems.push(`${tableId(table)} (sample rows): ${(e as Error).message}`);
    }
  }
  return profile;
}

async function sampleRows(
  db: DbAdapter,
  from: string,
  key: string[],
  columns: ColumnProfile[],
  options: ProfileOptions,
): Promise<NonNullable<TableProfile["samples"]>> {
  const dialect = db.dialect;
  const shown = columns.filter((c) => c.kind !== "skip");
  // long text and binary aren't read: their length, or nothing
  const select = shown
    .map((c, i) => {
      const x = quoteColumn(dialect, c.name);
      if (c.kind === "opaque") return `NULL AS c${i}`;
      if (c.kind === "text") return `${LENGTH[dialect] ?? "LENGTH"}(${x}) AS c${i}`;
      return `${x} AS c${i}`;
    })
    .join(", ");
  const order = key.length ? key.map((k) => `${quoteColumn(dialect, k)} DESC`).join(", ") : undefined;
  const res = await db.runQuery!(firstRows(dialect, select, from, options.samples, order), options.samples);
  const rows = res.rows.map((r) =>
    shown.map((c, i): SampleCell => {
      const v = r[i] ?? null;
      if (c.kind === "opaque") return { omitted: true };
      if (v === null) return { value: null };
      if (c.kind === "text") return { length: num(v) };
      if (!c.hidden) return { value: v };
      if (c.kind === "date") return { date: true };
      if (c.freeText) return { length: [...String(v)].length };
      return { standIn: standIn(String(v), options.key) };
    }),
  );
  return { columns: shown.map((c) => c.name), rows, ordered: Boolean(order) };
}

/**
 * A value of the same shape: other digits, other letters, 〇 for any other letter (kana, kanji),
 * the rest (- @ . spaces) as it was. The same value gives the same stand-in within one run.
 */
export function standIn(value: string, key: Buffer): string {
  let bytes = Buffer.alloc(0);
  let block = 0;
  const next = () => {
    if (!bytes.length) bytes = createHmac("sha256", key).update(`${block++}\u0000${value}`).digest();
    const b = bytes[0]!;
    bytes = bytes.subarray(1);
    return b;
  };
  let out = "";
  for (const ch of value) {
    if (/[0-9]/.test(ch)) out += String(next() % 10);
    else if (/[A-Z]/.test(ch)) out += String.fromCharCode(65 + (next() % 26));
    else if (/[a-z]/.test(ch)) out += String.fromCharCode(97 + (next() % 26));
    else if (/\p{L}|\p{N}/u.test(ch)) out += "〇";
    else out += ch;
  }
  return out;
}

/** A table for inferring references: its columns, its primary key, its profile (the rows read) and the keys declared on it. */
export interface ReferenceCandidate {
  table: TableRef;
  columns: string[];
  key: string[];
  profile: TableProfile;
}

/** Statements at most for inferring references, so a database with hundreds of tables can't take hours. */
const MAX_CHECKS = 300;

/**
 * Relations no foreign key declares (SQL Server databases often have none): table A has every column
 * of table B's primary key, by name, and each of those value combinations in A is also in B. Not
 * when A's own primary key is the same columns (two tables keyed by ID), and not when two tables fit.
 */
export async function inferReferences(db: DbAdapter, tables: ReferenceCandidate[], options: Pick<ProfileOptions, "largeTable" | "sampleRows">): Promise<string[]> {
  const problems: string[] = [];
  if (!db.runQuery || !db.fromClause) return problems;
  const dialect = db.dialect;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.some((y) => same(x, y)));
  let checks = 0;
  for (const a of tables) {
    const found = new Map<string, Reference[]>();
    for (const b of tables) {
      if (b === a || !b.key.length || sameSet(a.key, b.key)) continue;
      const columns = b.key.map((k) => a.columns.find((c) => same(c, k)));
      if (columns.some((c) => c === undefined)) continue;
      const cols = columns as string[];
      if (a.profile.references.some((r) => sameSet(r.columns, cols))) continue;
      // no values to check
      if (cols.some((c) => a.profile.columns.find((p) => p.name === c)?.nulls === a.profile.read)) continue;
      if (a.profile.read === 0) continue;
      if (++checks > MAX_CHECKS) {
        problems.push(`Stopped inferring references after ${MAX_CHECKS} checks: pick the tables with --tables`);
        return problems;
      }
      const from = db.fromClause(a.table);
      const src = a.profile.rows > options.largeTable ? `(${firstRows(dialect, "*", from, options.sampleRows)}) s` : `${from} s`;
      const q = (c: string) => quoteColumn(dialect, c);
      const sql =
        `SELECT COUNT(*) AS n, SUM(CASE WHEN m.${q(b.key[0]!)} IS NULL THEN 1 ELSE 0 END) AS missing FROM ` +
        `(SELECT DISTINCT ${cols.map((c, i) => `s.${q(c)} AS k${i}`).join(", ")} FROM ${src} WHERE ${cols.map((c) => `s.${q(c)} IS NOT NULL`).join(" AND ")}) x ` +
        `LEFT JOIN ${db.fromClause(b.table)} m ON ${b.key.map((k, i) => `m.${q(k)} = x.k${i}`).join(" AND ")}`;
      try {
        const r = (await db.runQuery(sql, 1)).rows[0] ?? [];
        if (num(r[0]) > 0 && num(r[1]) === 0) {
          const id = cols.join("\u0000").toLowerCase();
          found.set(id, [...(found.get(id) ?? []), { columns: cols, references: b.table, referencedColumns: b.key, inferred: true }]);
        }
      } catch {
        // types that can't be compared (a code as text against a number): not a reference
      }
    }
    for (const refs of found.values()) if (refs.length === 1) a.profile.references.push(refs[0]!);
  }
  return problems;
}
