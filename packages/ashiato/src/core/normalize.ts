import type { JsonValue, Row } from "./types.js";

/**
 * Converts driver values (Date, Buffer, bigint, Decimal objects, ...) into JSON-safe values
 * so snapshots can be compared with `===` and saved to disk.
 */
export function normalizeValue(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "bigint":
      return v.toString();
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  if (typeof v === "object" && typeof (v as { toString?: unknown }).toString === "function") {
    const s = String(v);
    if (s !== "[object Object]") return s;
  }
  return JSON.stringify(v);
}

export function normalizeRow(raw: Record<string, unknown>): Row {
  const row: Row = {};
  for (const [k, v] of Object.entries(raw)) row[k] = normalizeValue(v);
  return row;
}
