import { countChanges, tableId } from "../core/diff.js";
import type { JsonValue, Step, TableDiff } from "../core/types.js";
import { columnsOf, keyText, type Evidence, type Screenshot } from "./evidence.js";
import { actionText, localTime, requestText, stepLabel, TEXT, valueText, zoneOf, type Text } from "./text.js";
import { MAX_ROWS, sheetRef, Workbook, type Cell, type CellStyle, type Sheet } from "./xlsx.js";

const S = {
  title: { bold: true, size: 14 },
  heading: { bold: true, size: 12 },
  header: { bold: true, fill: "F2F2F2", border: true },
  keyHeader: { bold: true, underline: true, fill: "DDEBF7", border: true },
  muted: { italic: true, color: "7F7F7F" },
  link: { color: "0563C1", underline: true },
  linkCell: { color: "0563C1", underline: true, border: true },
  cell: { border: true },
  wrap: { border: true, wrap: true },
  ins: { fill: "E2EFDA", border: true },
  del: { fill: "FCE4E4", border: true },
  before: { color: "7F7F7F", border: true },
  changedBefore: { color: "B91C1C", fill: "FFF2CC", border: true },
  changedAfter: { bold: true, fill: "FFF2CC", border: true },
} satisfies Record<string, CellStyle>;

const KIND: Record<"ins" | "before" | "after" | "del", CellStyle> = {
  ins: { bold: true, color: "15803D", fill: "E2EFDA", border: true },
  before: { bold: true, color: "B45309", border: true },
  after: { bold: true, color: "B45309", border: true },
  del: { bold: true, color: "B91C1C", fill: "FCE4E4", border: true },
};

/** Pictures are shown at most this wide in the workbook (they keep their full size inside). */
const PICTURE_WIDTH = 640;
/** Room left under Excel's row limit for the notes written after a table. */
const ROOM = 16;

/** The evidence workbook: a summary, every change in one filterable list, and one sheet per step. */
export function evidenceWorkbook(ev: Evidence): Buffer {
  const t = TEXT[ev.lang];
  const book = new Workbook(ev.lang === "ja" ? "Yu Gothic" : "Calibri");
  const summary = book.sheet(t.summary);
  const all = book.sheet(t.allChanges);
  const sheets = new Map<number, Sheet>();
  for (const step of ev.steps) sheets.set(step.id, book.sheet(`#${step.id} ${stepLabel(step, t)}`));
  const linkTo = (step: Step) => `${sheetRef(sheets.get(step.id)!.name)}!A1`;

  writeSummary(summary, ev, t, linkTo);
  writeAllChanges(all, ev, t, linkTo);
  for (const step of ev.steps) writeStep(sheets.get(step.id)!, step, ev, t, `${sheetRef(summary.name)}!A1`);
  return book.toBuffer();
}

const info = (t: Text, label: string, value: string | number): Cell => ({ v: `${label}${t.sep}${value}`, noWidth: true });

function writeSummary(sheet: Sheet, ev: Evidence, t: Text, linkTo: (s: Step) => string) {
  const { session } = ev;
  sheet.add({ v: t.title, s: S.title, noWidth: true });
  sheet.skip();
  sheet.add(info(t, t.started, `${localTime(session.startedAt)} (${zoneOf(new Date(session.startedAt))})`));
  sheet.add(info(t, t.database, session.dialect));
  sheet.add(info(t, t.watched, `${session.tables.length} (${session.tables.map(tableId).join(", ")})`));
  sheet.add(info(t, t.steps, ev.steps.length === session.steps.length ? ev.steps.length : `${ev.steps.length} / ${session.steps.length}`));
  sheet.add(info(t, t.exported, localTime(ev.exportedAt)));
  if (ev.sessionFile) sheet.add(info(t, t.file, ev.sessionFile));
  if (ev.screensNote) sheet.add({ v: ev.screensNote, s: S.muted, noWidth: true });
  sheet.skip();

  const header = [t.step, t.time, t.label, t.page, t.requests, t.inserted, t.updated, t.deleted, t.tables, t.notCompared];
  const first = sheet.add(...header.map((v) => ({ v, s: S.header })));
  for (const step of ev.steps) {
    const c = countChanges(step.diff);
    const requests = step.action?.requests ?? [];
    sheet.add(
      { v: `#${step.id}`, s: S.linkCell, link: linkTo(step) },
      { v: localTime(step.at), s: S.cell },
      { v: stepLabel(step, t), s: S.cell },
      { v: step.action?.page ?? "", s: S.cell },
      { v: requests.map(requestText).join("\n"), s: requests.length > 1 ? S.wrap : S.cell },
      { v: c.inserted, s: S.cell },
      { v: c.updated, s: S.cell },
      { v: c.deleted, s: S.cell },
      { v: step.diff.tables.map((d) => tableId(d.table)).join(", "), s: S.cell },
      { v: (step.skipped ?? []).map((s) => tableId(s.table)).join(", "), s: S.cell },
    );
  }
  if (ev.steps.length === 0) sheet.add({ v: t.noSteps, s: S.muted });
  else sheet.filter = [first, sheet.rowCount - 1, header.length];
  // the request list shows one request per line; keep the column readable
  sheet.widths[4] = 48;
}

function writeAllChanges(sheet: Sheet, ev: Evidence, t: Text, linkTo: (s: Step) => string) {
  const header = [t.step, t.time, t.label, t.table, t.change, t.key, t.column, t.before, t.after];
  sheet.add(...header.map((v) => ({ v, s: S.header })));
  sheet.freeze = { rows: 1 };
  const values = (r: Record<string, JsonValue>) => Object.entries(r).map(([c, v]) => `${c}=${valueText(v)}`).join(", ");
  let left = 0;
  for (const step of ev.steps) {
    const head = (table: TableDiff): Cell[] => [
      { v: `#${step.id}`, s: S.linkCell, link: linkTo(step) },
      { v: localTime(step.at), s: S.cell },
      { v: stepLabel(step, t), s: S.cell },
      { v: tableId(table.table), s: S.cell },
    ];
    for (const d of step.diff.tables) {
      const lines = d.inserted.length + d.deleted.length + d.updated.reduce((n, u) => n + u.changed.length, 0);
      if (sheet.rowCount + lines > MAX_ROWS - ROOM) {
        left += lines;
        continue;
      }
      for (const r of d.inserted) sheet.add(...head(d), { v: t.inserted, s: KIND.ins }, { v: keyText(d.key, r), s: S.cell }, { v: "", s: S.cell }, { v: "", s: S.cell }, { v: values(r), s: S.cell });
      for (const u of d.updated) {
        for (const col of u.changed) {
          sheet.add(...head(d), { v: t.updated, s: KIND.after }, { v: keyText(d.key, u.key), s: S.cell }, { v: col, s: S.cell }, typed(u.before[col], S.cell), typed(u.after[col], S.cell));
        }
      }
      for (const r of d.deleted) sheet.add(...head(d), { v: t.deleted, s: KIND.del }, { v: keyText(d.key, r), s: S.cell }, { v: "", s: S.cell }, { v: values(r), s: S.cell }, { v: "", s: S.cell });
    }
  }
  const last = sheet.rowCount - 1;
  if (left) sheet.add({ v: t.notWritten(left), s: S.muted, noWidth: true });
  sheet.filter = [0, Math.max(last, 1), header.length];
}

function writeStep(sheet: Sheet, step: Step, ev: Evidence, t: Text, back: string) {
  const c = countChanges(step.diff);
  sheet.add({ v: `#${step.id} ${stepLabel(step, t)}`, s: S.title, noWidth: true });
  sheet.add({ v: t.back, s: S.link, link: back, noWidth: true });
  sheet.add(info(t, t.time, localTime(step.at)));
  // the label usually says what was done already (click button "Save"): the action only when it says more
  const action = actionText(step.action, t);
  if (action && action !== step.label) sheet.add(info(t, t.action, action));
  if (step.action?.page) sheet.add(info(t, t.page, step.action.page));
  for (const r of step.action?.requests ?? []) sheet.add(info(t, t.requests, requestText(r)));
  sheet.add(info(t, t.changes, `${t.inserted} ${c.inserted} / ${t.updated} ${c.updated} / ${t.deleted} ${c.deleted}`));
  if (step.source === "sync") sheet.add({ v: t.outside, s: S.muted, noWidth: true });
  for (const table of step.addedTables ?? []) sheet.add({ v: t.newTable(tableId(table)), s: { color: "15803D" }, noWidth: true });
  for (const table of step.removedTables ?? []) sheet.add({ v: t.goneTable(tableId(table)), s: { color: "B91C1C" }, noWidth: true });
  for (const s of step.skipped ?? []) sheet.add({ v: `${t.notCompared}${t.sep}${tableId(s.table)} (${s.reason})`, s: { color: "B45309" }, noWidth: true });

  for (const shot of ev.screens.get(step.id) ?? []) {
    sheet.skip();
    sheet.add({ v: screenCaption(shot, t), s: { bold: true }, noWidth: true });
    const scale = Math.min(1, PICTURE_WIDTH / shot.width, PICTURE_WIDTH / shot.height);
    sheet.picture({
      data: shot.image,
      type: "jpeg",
      width: Math.round(shot.width * scale),
      height: Math.round(shot.height * scale),
      description: screenCaption(shot, t),
    });
  }

  if (step.diff.tables.length === 0) {
    sheet.skip();
    sheet.add({ v: t.noChanges, s: S.muted, noWidth: true });
  }
  for (const d of step.diff.tables) {
    sheet.skip();
    writeTable(sheet, d, t);
  }
}

export function screenCaption(shot: Screenshot, t: Text): string {
  return `${shot.moment === "before" ? t.screenBefore : t.screenAfter} (${shot.source === "replay" ? t.replay : t.video}, ${localTime(shot.at)})`;
}

function writeTable(sheet: Sheet, d: TableDiff, t: Text) {
  const cols = columnsOf(d);
  sheet.add(
    { v: tableId(d.table), s: S.heading, noWidth: true },
    ...[
      d.inserted.length ? `${t.inserted} ${d.inserted.length}` : "",
      d.updated.length ? `${t.updated} ${d.updated.length}` : "",
      d.deleted.length ? `${t.deleted} ${d.deleted.length}` : "",
    ]
      .filter(Boolean)
      .map((v) => ({ v, noWidth: true })),
  );
  if (d.key.length === 0) sheet.add({ v: t.noKey, s: S.muted, noWidth: true });
  sheet.add({ v: t.change, s: S.header }, ...cols.map((c) => ({ v: c, s: d.key.includes(c) ? S.keyHeader : S.header })));

  let left = d.inserted.length + d.updated.length + d.deleted.length;
  const room = (rows: number) => sheet.rowCount + rows <= MAX_ROWS - ROOM;
  for (const r of d.inserted) {
    if (!room(1)) break;
    sheet.add({ v: t.inserted, s: KIND.ins }, ...cols.map((c) => typed(r[c], S.ins)));
    left--;
  }
  for (const u of d.updated) {
    if (!room(2)) break;
    sheet.add({ v: t.before, s: KIND.before }, ...cols.map((c) => typed(u.before[c], u.changed.includes(c) ? S.changedBefore : S.before)));
    sheet.add({ v: t.after, s: KIND.after }, ...cols.map((c) => typed(u.after[c], u.changed.includes(c) ? S.changedAfter : S.cell)));
    left--;
  }
  for (const r of d.deleted) {
    if (!room(1)) break;
    sheet.add({ v: t.deleted, s: KIND.del }, ...cols.map((c) => typed(r[c], S.del)));
    left--;
  }
  if (left > 0) sheet.add({ v: t.notWritten(left), s: S.muted, noWidth: true });
}

const nullStyles = new Map<CellStyle, CellStyle>();

/** A database value in a cell, keeping its type; NULL is shown as such. */
function typed(v: JsonValue | undefined, s: CellStyle): Cell {
  if (v !== null && v !== undefined) return { v, s };
  let ns = nullStyles.get(s);
  if (!ns) nullStyles.set(s, (ns = { ...s, italic: true, color: "A6A6A6" }));
  return { v: "NULL", s: ns };
}
