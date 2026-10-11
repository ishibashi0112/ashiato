import type { Row, Session, Step, TableDiff } from "../core/types.js";
import type { Lang } from "./text.js";

/** A picture of the screen around a step, taken from the screen replay or a screen recording. */
export interface Screenshot {
  /** `before`: just before the step's user action. `after`: at the checkpoint. */
  moment: "before" | "after";
  /** When the screen looked like this. */
  at: string;
  source: "replay" | "video";
  /** JPEG image. */
  image: Buffer;
  width: number;
  height: number;
}

/** What an evidence document is made from. */
export interface Evidence {
  session: Session;
  /** The steps to include, in order. */
  steps: Step[];
  lang: Lang;
  /** Screenshots by step id. */
  screens: Map<number, Screenshot[]>;
  /** Why some or all screenshots are missing, if they are. */
  screensNote?: string;
  sessionFile?: string;
  exportedAt: string;
}

/** Columns of a table's changed rows, in the order they first appear. */
export function columnsOf(t: TableDiff): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  const add = (r: Row) => {
    for (const c of Object.keys(r)) if (!seen.has(c)) seen.add(c), cols.push(c);
  };
  for (const r of t.inserted) add(r);
  for (const u of t.updated) add(u.after), add(u.before);
  for (const r of t.deleted) add(r);
  // key columns first, as the database lists them
  return [...t.key.filter((k) => seen.has(k)), ...cols.filter((c) => !t.key.includes(c))];
}

/** `id=1, line=2`: the key of a row (the whole row for a table without a primary key). */
export function keyText(key: string[], row: Row): string {
  const cols = key.length ? key : Object.keys(row);
  return cols.map((c) => `${c}=${row[c] === null || row[c] === undefined ? "NULL" : String(row[c])}`).join(", ");
}
