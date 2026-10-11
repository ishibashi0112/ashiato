import type { ActionInfo, JsonValue, RequestInfo, Step } from "../core/types.js";

export type Lang = "en" | "ja";

const en = {
  /** Between a label and its value. */
  sep: ": ",
  title: "Database change evidence",
  summary: "Summary",
  allChanges: "All changes",
  started: "Recording started",
  database: "Database",
  watched: "Watched tables",
  steps: "Steps",
  exported: "Exported",
  file: "Session file",
  step: "Step",
  time: "Time",
  label: "Label",
  action: "Action",
  page: "Page",
  requests: "Requests",
  changes: "Changes",
  inserted: "Inserted",
  updated: "Updated",
  deleted: "Deleted",
  tables: "Changed tables",
  notCompared: "Not compared",
  table: "Table",
  change: "Change",
  key: "Key",
  column: "Column",
  before: "Before",
  after: "After",
  kind: "Kind",
  method: "Method",
  url: "URL",
  result: "Result",
  duration: "Duration",
  screenBefore: "Screen just before the action",
  screenAfter: "Screen at the checkpoint",
  replay: "screen replay",
  video: "screen recording",
  noChanges: "No rows changed in the watched tables.",
  outside: "These rows changed while no action was running (another user, a batch job, or the app itself).",
  outsideLabel: "outside actions",
  noKey: "No primary key: an update appears as a delete plus an insert.",
  noUserAction: "Request without a user action",
  notShown: (n: number) => `${n} more rows are not shown here.`,
  notShownPdf: (n: number) => `${n} more rows are not shown here: see the Excel export.`,
  notWritten: (n: number) => `${n} more rows are not written (Excel's row limit).`,
  back: "Back to the summary",
  noSteps: "No steps.",
  newTable: (name: string) => `New table: ${name} is watched from this step on; its rows are shown as inserted.`,
  goneTable: (name: string) => `Table gone: ${name} was dropped, renamed, or can no longer be read, so it is no longer watched.`,
  screensMissing: (why: string) => `Screenshots were not taken: ${why}`,
  screensFailed: (n: number) => `${n} screenshot(s) could not be taken.`,
};

const ja: typeof en = {
  sep: ":",
  title: "DB変更の証跡",
  summary: "概要",
  allChanges: "変更一覧",
  started: "記録開始",
  database: "データベース",
  watched: "監視テーブル数",
  steps: "ステップ数",
  exported: "出力日時",
  file: "セッションファイル",
  step: "ステップ",
  time: "時刻",
  label: "操作",
  action: "操作内容",
  page: "画面",
  requests: "通信",
  changes: "変更",
  inserted: "追加",
  updated: "更新",
  deleted: "削除",
  tables: "変更したテーブル",
  notCompared: "比較できなかったテーブル",
  table: "テーブル",
  change: "種別",
  key: "キー",
  column: "列",
  before: "変更前",
  after: "変更後",
  kind: "種類",
  method: "メソッド",
  url: "URL",
  result: "結果",
  duration: "所要時間",
  screenBefore: "操作直前の画面",
  screenAfter: "チェックポイント時点の画面",
  replay: "画面リプレイ",
  video: "画面録画",
  noChanges: "監視対象のテーブルに変更はありません。",
  outside: "操作していない間に変わった行です(他の利用者、バッチ、アプリ自身など)。",
  outsideLabel: "操作外の変更",
  noKey: "主キーがないため、更新は「削除+追加」として表示されます。",
  noUserAction: "ユーザー操作なしの通信",
  notShown: (n: number) => `ほか ${n} 行は表示していません。`,
  notShownPdf: (n: number) => `ほか ${n} 行は表示していません(Excel 出力を参照)。`,
  notWritten: (n: number) => `ほか ${n} 行は Excel の行数の上限のため出力していません。`,
  back: "概要に戻る",
  noSteps: "ステップがありません。",
  newTable: (name: string) => `新しいテーブル:${name}(このステップから監視します。今ある行は追加として表示します)`,
  goneTable: (name: string) => `なくなったテーブル:${name}(削除・名前変更・読み取り不可のため、監視をやめました)`,
  screensMissing: (why: string) => `画面キャプチャは撮れませんでした:${why}`,
  screensFailed: (n: number) => `${n} 枚の画面キャプチャを撮れませんでした。`,
};

export type Text = typeof en;
export const TEXT: Record<Lang, Text> = { en, ja };

/** Japanese when the machine's locale (or the given one) is Japanese, English otherwise. */
export function langOf(locale = Intl.DateTimeFormat().resolvedOptions().locale): Lang {
  return /^ja\b/i.test(locale) ? "ja" : "en";
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `2026-10-11 22:55:03` in the local time zone. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The local time zone as `UTC+09:00`. */
export function zoneOf(d = new Date()): string {
  const offset = -d.getTimezoneOffset();
  return `UTC${offset < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function stepLabel(step: Step, t: Text): string {
  return step.source === "sync" && step.label === en.outsideLabel ? t.outsideLabel : step.label;
}

export function actionText(action: ActionInfo | undefined, t: Text): string {
  if (!action) return "";
  return action.type === "request" ? t.noUserAction : `${action.type} ${action.target ?? ""}`.trim();
}

export function requestText(r: RequestInfo): string {
  const kind = r.kind === "http" ? "" : `${r.kind.toUpperCase()} `;
  const result = r.error ?? r.status;
  return `${kind}${r.method}${r.url ? ` ${r.url}` : ""}${result !== undefined ? ` → ${result}` : ""}${r.durationMs !== undefined ? ` (${r.durationMs}ms)` : ""}`;
}

export const kindText = (r: RequestInfo) => (r.kind === "http" ? "HTTP" : r.kind === "rpc" ? "RPC" : "MSG");

/** A value as shown in a cell or table. */
export const valueText = (v: JsonValue | undefined) => (v === null || v === undefined ? "NULL" : String(v));
