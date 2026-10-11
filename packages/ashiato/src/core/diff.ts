import type { Diff, Row, Snapshot, TableDiff, TableRef, TableSnapshot, UpdatedRow } from "./types.js";

export interface DiffOptions {
  /** Column names ignored when deciding whether a row was updated (e.g. `updated_at`). Case-insensitive. */
  ignoreColumns?: string[];
}

export function tableId(t: TableRef): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

/** Compares two snapshots of the same tables and returns what was inserted, updated and deleted. */
export function diffSnapshots(before: Snapshot, after: Snapshot, options: DiffOptions = {}): Diff {
  const ignore = new Set((options.ignoreColumns ?? []).map((c) => c.toLowerCase()));
  const beforeById = new Map(before.tables.map((t) => [tableId(t.table), t]));
  const tables: TableDiff[] = [];

  for (const a of after.tables) {
    const b = beforeById.get(tableId(a.table));
    if (!b || a.skipped || b.skipped) continue;
    const d = a.key.length > 0 ? diffByKey(b, a, ignore) : diffAsMultiset(b, a, ignore);
    if (d.inserted.length || d.deleted.length || d.updated.length) tables.push(d);
  }

  return { from: before.takenAt, to: after.takenAt, tables };
}

function diffByKey(before: TableSnapshot, after: TableSnapshot, ignore: Set<string>): TableDiff {
  const key = after.key;
  const keyOf = (r: Row) => JSON.stringify(key.map((k) => r[k] ?? null));
  const beforeRows = new Map(before.rows.map((r) => [keyOf(r), r]));
  const inserted: Row[] = [];
  const updated: UpdatedRow[] = [];

  for (const row of after.rows) {
    const k = keyOf(row);
    const prev = beforeRows.get(k);
    if (!prev) {
      inserted.push(row);
      continue;
    }
    beforeRows.delete(k);
    const changed = changedColumns(prev, row, ignore);
    if (changed.length) {
      updated.push({ key: Object.fromEntries(key.map((c) => [c, row[c] ?? null])), before: prev, after: row, changed });
    }
  }

  return { table: after.table, key, inserted, deleted: [...beforeRows.values()], updated };
}

/** Tables without a primary key: rows are compared as whole values, so an update shows up as delete + insert. */
function diffAsMultiset(before: TableSnapshot, after: TableSnapshot, ignore: Set<string>): TableDiff {
  const fingerprint = (r: Row) =>
    JSON.stringify(
      Object.keys(r)
        .filter((c) => !ignore.has(c.toLowerCase()))
        .sort()
        .map((c) => [c, r[c]]),
    );
  const remaining = new Map<string, Row[]>();
  for (const r of before.rows) {
    const f = fingerprint(r);
    const list = remaining.get(f);
    if (list) list.push(r);
    else remaining.set(f, [r]);
  }
  const inserted: Row[] = [];
  for (const r of after.rows) {
    const list = remaining.get(fingerprint(r));
    if (list && list.length) list.pop();
    else inserted.push(r);
  }
  const deleted = [...remaining.values()].flat();
  return { table: after.table, key: [], inserted, deleted, updated: [] };
}

function changedColumns(before: Row, after: Row, ignore: Set<string>): string[] {
  const cols = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const c of cols) {
    if (ignore.has(c.toLowerCase())) continue;
    if (before[c] !== after[c]) changed.push(c);
  }
  return changed;
}

export function countChanges(diff: Diff): { inserted: number; updated: number; deleted: number } {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  for (const t of diff.tables) {
    inserted += t.inserted.length;
    updated += t.updated.length;
    deleted += t.deleted.length;
  }
  return { inserted, updated, deleted };
}
