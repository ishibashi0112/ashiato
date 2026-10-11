import { countChanges, tableId } from "../core/diff.js";
import type { JsonValue, Step, TableDiff } from "../core/types.js";
import { screenCaption } from "./excel.js";
import { columnsOf, type Evidence } from "./evidence.js";
import { actionText, kindText, localTime, stepLabel, TEXT, zoneOf, type Text } from "./text.js";

/** Rows shown per kind (inserted / updated / deleted) of a table; the Excel export has them all. */
const ROW_LIMIT = 200;

/**
 * The evidence as one self-contained HTML page, laid out for printing on A4 landscape (the PDF
 * export prints it). It loads nothing: no scripts, styles and images are inline.
 */
export function evidenceHtml(ev: Evidence): string {
  const t = TEXT[ev.lang];
  const { session } = ev;
  const info: [string, string][] = [
    [t.started, `${localTime(session.startedAt)} (${zoneOf(new Date(session.startedAt))})`],
    [t.database, session.dialect],
    [t.watched, `${session.tables.length} (${session.tables.map(tableId).join(", ")})`],
    [t.steps, ev.steps.length === session.steps.length ? String(ev.steps.length) : `${ev.steps.length} / ${session.steps.length}`],
    [t.exported, localTime(ev.exportedAt)],
    ...(ev.sessionFile ? [[t.file, ev.sessionFile] as [string, string]] : []),
  ];
  return `<!doctype html>
<html lang="${ev.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${h(`${t.title} ${localTime(session.startedAt)}`)}</title>
<style>${CSS}</style>
</head>
<body>
<section class="cover" id="summary">
<h1>${h(t.title)}</h1>
<table class="info">${info.map(([k, v]) => `<tr><th>${h(k)}</th><td>${h(v)}</td></tr>`).join("")}</table>
${ev.screensNote ? `<p class="note">${h(ev.screensNote)}</p>` : ""}
<h2>${h(t.summary)}</h2>
${summary(ev, t)}
</section>
${ev.steps.map((s) => step(s, ev, t)).join("\n")}
</body>
</html>
`;
}

function summary(ev: Evidence, t: Text): string {
  if (ev.steps.length === 0) return `<p class="note">${h(t.noSteps)}</p>`;
  const rows = ev.steps.map((s) => {
    const c = countChanges(s.diff);
    return (
      `<tr><td><a href="#step-${s.id}">#${s.id}</a></td><td class="nowrap">${h(localTime(s.at))}</td><td>${h(stepLabel(s, t))}</td>` +
      `<td>${h(s.action?.page ?? "")}</td><td class="num ins">${c.inserted}</td><td class="num upd">${c.updated}</td><td class="num del">${c.deleted}</td>` +
      `<td>${h(s.diff.tables.map((d) => tableId(d.table)).join(", "))}</td><td>${h((s.skipped ?? []).map((x) => tableId(x.table)).join(", "))}</td></tr>`
    );
  });
  return (
    `<table class="grid"><thead><tr>${[t.step, t.time, t.label, t.page, t.inserted, t.updated, t.deleted, t.tables, t.notCompared].map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table>`
  );
}

function step(s: Step, ev: Evidence, t: Text): string {
  const c = countChanges(s.diff);
  const action = actionText(s.action, t);
  const meta = [localTime(s.at), action && action !== s.label ? action : "", s.action?.page ?? ""].filter(Boolean);
  const requests = s.action?.requests ?? [];
  const shots = ev.screens.get(s.id) ?? [];
  return `<section class="step" id="step-${s.id}">
<h2>#${s.id} ${h(stepLabel(s, t))}</h2>
<p class="meta">${meta.map(h).join(" · ")} · <span class="ins">${h(t.inserted)} ${c.inserted}</span> <span class="upd">${h(t.updated)} ${c.updated}</span> <span class="del">${h(t.deleted)} ${c.deleted}</span></p>
${
  requests.length
    ? `<table class="grid requests"><thead><tr><th>${h(t.kind)}</th><th>${h(t.method)}</th><th>${h(t.url)}</th><th>${h(t.result)}</th><th>${h(t.duration)}</th></tr></thead><tbody>${requests
        .map(
          (r) =>
            `<tr><td>${kindText(r)}</td><td>${h(r.method)}</td><td class="wrap">${h(r.url ?? "")}</td><td class="${r.error || (r.status ?? 0) >= 400 ? "del" : ""}">${h(String(r.error ?? r.status ?? ""))}</td><td class="num">${r.durationMs !== undefined ? `${r.durationMs}ms` : ""}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : ""
}
${s.source === "sync" ? `<p class="note">${h(t.outside)}</p>` : ""}
${(s.addedTables ?? []).map((x) => `<p class="ins">${h(t.newTable(tableId(x)))}</p>`).join("")}
${(s.removedTables ?? []).map((x) => `<p class="del">${h(t.goneTable(tableId(x)))}</p>`).join("")}
${(s.skipped ?? []).map((x) => `<p class="warn">${h(t.notCompared)}${h(t.sep)}${h(tableId(x.table))} (${h(x.reason)})</p>`).join("")}
${
  shots.length
    ? `<div class="screens n${shots.length}">${shots
        .map((shot) => `<figure><img src="data:image/jpeg;base64,${shot.image.toString("base64")}" alt=""><figcaption>${h(screenCaption(shot, t))}</figcaption></figure>`)
        .join("")}</div>`
    : ""
}
${s.diff.tables.length === 0 ? `<p class="note">${h(t.noChanges)}</p>` : s.diff.tables.map((d) => table(d, t)).join("\n")}
</section>`;
}

function table(d: TableDiff, t: Text): string {
  // a table with only updates shows its key and the changed columns: rows stay readable on paper
  const all = columnsOf(d);
  const changed = new Set(d.updated.flatMap((u) => u.changed));
  const cols = d.inserted.length || d.deleted.length ? all : all.filter((c) => d.key.includes(c) || changed.has(c));
  const head = `<tr><th>${h(t.change)}</th>${cols.map((c) => `<th class="${d.key.includes(c) ? "key" : ""}">${h(c)}</th>`).join("")}</tr>`;
  const rows: string[] = [];
  const plain = (cls: string, kind: string, r: Record<string, JsonValue>) =>
    `<tr class="${cls}"><td class="kind">${h(kind)}</td>${cols.map((c) => `<td>${value(r[c])}</td>`).join("")}</tr>`;
  for (const r of d.inserted.slice(0, ROW_LIMIT)) rows.push(plain("ins", t.inserted, r));
  for (const u of d.updated.slice(0, ROW_LIMIT)) {
    rows.push(
      `<tr class="upd"><td class="kind">${h(t.updated)}</td>${cols
        .map((c) =>
          u.changed.includes(c)
            ? `<td class="changed"><span class="before">${value(u.before[c])}</span> → <span class="after">${value(u.after[c])}</span></td>`
            : `<td class="same">${value(u.after[c])}</td>`,
        )
        .join("")}</tr>`,
    );
  }
  for (const r of d.deleted.slice(0, ROW_LIMIT)) rows.push(plain("del", t.deleted, r));
  const hidden = d.inserted.length + d.updated.length + d.deleted.length - rows.length;
  const counts = [
    d.inserted.length ? `<span class="ins">${h(t.inserted)} ${d.inserted.length}</span>` : "",
    d.updated.length ? `<span class="upd">${h(t.updated)} ${d.updated.length}</span>` : "",
    d.deleted.length ? `<span class="del">${h(t.deleted)} ${d.deleted.length}</span>` : "",
  ].join(" ");
  return `<div class="table">
<h3>${h(tableId(d.table))} ${counts}</h3>
${d.key.length === 0 ? `<p class="note">${h(t.noKey)}</p>` : ""}
<table class="grid rows${cols.length > 14 ? " wide" : ""}"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>
${hidden > 0 ? `<p class="note">${h(t.notShownPdf(hidden))}</p>` : ""}
</div>`;
}

const value = (v: JsonValue | undefined) => (v === null || v === undefined ? `<i class="null">NULL</i>` : h(String(v)));

function h(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "�");
}

const CSS = `
@page { size: A4 landscape; margin: 12mm 10mm 14mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #1c1917; font: 9pt/1.45 "Segoe UI", "Yu Gothic UI", "Yu Gothic", Meiryo, "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif; }
@media screen { body { max-width: 1100px; margin: 24px auto; padding: 0 16px; } }
h1 { font-size: 18pt; margin: 0 0 8px; }
h2 { font-size: 13pt; margin: 14px 0 4px; }
h3 { font-size: 10pt; margin: 12px 0 4px; }
h3 span { font-weight: 400; margin-left: 6px; font-size: 8.5pt; }
a { color: #1d4ed8; text-decoration: none; }
.step { break-before: page; }
.step h2 { margin-top: 0; padding-bottom: 4px; border-bottom: 2px solid #1c1917; }
.meta { color: #57534e; margin: 4px 0 8px; }
.note { color: #78716c; font-style: italic; margin: 4px 0; }
.warn { color: #b45309; margin: 4px 0; }
table { border-collapse: collapse; }
.info th { text-align: left; padding: 2px 16px 2px 0; color: #57534e; font-weight: 600; white-space: nowrap; vertical-align: top; }
.info td { padding: 2px 0; }
.grid { width: 100%; margin: 4px 0 8px; }
.grid th, .grid td { border: 1px solid #d6d3d1; padding: 2px 5px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.grid th { background: #f5f5f4; font-weight: 600; }
.grid thead { display: table-header-group; }
.grid tr { break-inside: avoid; }
.rows { width: auto; max-width: 100%; font: 8pt/1.35 Consolas, "Cascadia Mono", "BIZ UDGothic", "MS Gothic", ui-monospace, monospace; }
.rows td { white-space: pre-wrap; }
.rows.wide { font-size: 6.5pt; }
.rows th.key { background: #dbeafe; text-decoration: underline; }
.requests { width: auto; min-width: 60%; }
td.num { text-align: right; white-space: nowrap; }
td.nowrap { white-space: nowrap; }
td.kind { font-weight: 700; white-space: nowrap; }
tr.ins td { background: #ecfdf3; } tr.ins td.kind { color: #15803d; }
tr.del td { background: #fef2f2; } tr.del td.kind { color: #b91c1c; }
tr.upd td.kind { color: #b45309; }
td.same { color: #78716c; }
td.changed { background: #fffbeb; }
.before { color: #b91c1c; text-decoration: line-through; }
.after { color: #15803d; font-weight: 700; }
.ins { color: #15803d; } .upd { color: #b45309; } .del { color: #b91c1c; }
.null { color: #a8a29e; }
.screens { display: grid; gap: 8px; margin: 8px 0; break-inside: avoid; }
.screens.n2 { grid-template-columns: 1fr 1fr; }
figure { margin: 0; break-inside: avoid; }
figure img { display: block; max-width: 100%; max-height: 110mm; margin: 0 auto; border: 1px solid #a8a29e; }
figcaption { color: #57534e; font-size: 8pt; margin-top: 2px; text-align: center; }
.table { break-inside: auto; }
.table h3 { break-after: avoid; }
`;
