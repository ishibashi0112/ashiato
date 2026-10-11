import { countChanges, tableId } from "./diff.js";
import type { JsonValue, Row, Step } from "./types.js";

const color = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);

const show = (v: JsonValue | undefined) => (v === null || v === undefined ? "NULL" : typeof v === "string" ? JSON.stringify(v) : String(v));

function keyText(key: string[], row: Row): string {
  if (key.length === 0) return Object.entries(row).map(([k, v]) => `${k}=${show(v)}`).join(", ");
  return key.map((k) => `${k}=${show(row[k])}`).join(", ");
}

/** Human-readable summary of one step for the terminal. */
export function formatStep(step: Step, maxRowsPerKind = 5, showSkipped = true): string {
  const c = countChanges(step.diff);
  const via = step.source && !["manual", "http", "ui"].includes(step.source) && step.source !== step.label ? `  ${dim(step.source)}` : "";
  const lines = [`#${step.id} ${step.label}${via}  ${dim(`(+${c.inserted} ~${c.updated} -${c.deleted}, ${step.durationMs}ms)`)}`];
  if (step.diff.tables.length === 0) lines.push(dim("  no changes"));
  if (showSkipped) for (const s of step.skipped ?? []) lines.push(yellow(`  ! ${tableId(s.table)} not compared: ${s.reason}`));
  for (const t of step.diff.tables) {
    lines.push(`  ${tableId(t.table)}`);
    for (const r of t.inserted.slice(0, maxRowsPerKind)) lines.push(green(`    + ${keyText(t.key, r)}`));
    for (const u of t.updated.slice(0, maxRowsPerKind)) {
      const changes = u.changed.map((col) => `${col}: ${show(u.before[col])} → ${show(u.after[col])}`).join(", ");
      lines.push(yellow(`    ~ ${keyText(t.key, u.key)}  ${changes}`));
    }
    for (const r of t.deleted.slice(0, maxRowsPerKind)) lines.push(red(`    - ${keyText(t.key, r)}`));
    const hidden =
      Math.max(0, t.inserted.length - maxRowsPerKind) +
      Math.max(0, t.updated.length - maxRowsPerKind) +
      Math.max(0, t.deleted.length - maxRowsPerKind);
    if (hidden) lines.push(dim(`    … ${hidden} more`));
  }
  return lines.join("\n");
}
