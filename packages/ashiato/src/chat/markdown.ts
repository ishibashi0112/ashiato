import type { JsonValue } from "../core/types.js";

export const DIALECT_NAMES: Record<string, string> = {
  mssql: "SQL Server",
  oracle: "Oracle",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
};

/** Long values (a CLOB, an XML document) are cut here, so one cell can't fill the chat's paste limit. */
const MAX_CELL = 300;

/** A value in a Markdown table cell: NULL for null, '' for an empty string, | escaped, line breaks as <br>. */
export function markdownCell(v: JsonValue): string {
  if (v === null) return "NULL";
  let s = String(v);
  if (s === "") return "''";
  const chars = [...s];
  if (chars.length > MAX_CELL) s = `${chars.slice(0, MAX_CELL).join("")}…(${chars.length})`;
  return s.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

/** A fenced code block that the code itself can't close (it may hold ```). */
export function codeFence(code: string, lang: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${code}\n${fence}`;
}
