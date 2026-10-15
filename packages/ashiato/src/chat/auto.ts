import type { Locator, Page } from "playwright-core";
import type { Lang } from "../export/text.js";
import type { RowScope, StepAction } from "./actions.js";
import { formatAria, namedNodes, parseAria, shapeAria, texts, type AriaNode } from "./aria.js";
import { appUrl } from "./browser.js";

/**
 * How a step's actions find their elements, the same way in `verify --auto` (on a live page) and in
 * the tests `export-tests` writes (as code): a button, link, tab, menu item or option by its exact
 * name; a field by its exact label or placeholder; a check box, radio button or switch by its exact
 * name. One that names no element, or several, fails: Playwright's strict mode, in both.
 */
const CLICKABLE = ["button", "link", "menuitem", "tab", "option"] as const;
const CHECKABLE = ["checkbox", "radio", "switch"] as const;

/** The helpers a generated test defines, doing what `locate` does. */
export const HELPERS = {
  clickable: `/** A button, link, tab, menu item or option with this name, as \`ashiato verify --auto\` finds it. */
const clickable = (scope: Page | Locator, name: string) =>
  (${JSON.stringify(CLICKABLE).replace(/,/g, ", ")} as const).map((role) => scope.getByRole(role, { name, exact: true })).reduce((a, b) => a.or(b));`,
  field: `/** A field with this label (or placeholder), as \`ashiato verify --auto\` finds it. */
const field = (scope: Page | Locator, label: string) => scope.getByLabel(label, { exact: true }).or(scope.getByPlaceholder(label, { exact: true }));`,
  checkable: `/** A check box, radio button or switch with this name, as \`ashiato verify --auto\` finds it. */
const checkable = (scope: Page | Locator, name: string) =>
  (${JSON.stringify(CHECKABLE).replace(/,/g, ", ")} as const).map((role) => scope.getByRole(role, { name, exact: true })).reduce((a, b) => a.or(b));`,
};
export type Helper = keyof typeof HELPERS;

const clickable = (scope: Page | Locator, name: string) => CLICKABLE.map((role) => scope.getByRole(role, { name, exact: true })).reduce((a, b) => a.or(b));
const field = (scope: Page | Locator, label: string) => scope.getByLabel(label, { exact: true }).or(scope.getByPlaceholder(label, { exact: true }));
const checkable = (scope: Page | Locator, name: string) => CHECKABLE.map((role) => scope.getByRole(role, { name, exact: true })).reduce((a, b) => a.or(b));

/** A string literal (line and paragraph separators escaped). */
export const q = (s: string) => JSON.stringify(s).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function scopeCode(row: RowScope | undefined): string {
  if (!row) return "page";
  return "text" in row ? `page.getByRole("row").filter({ hasText: ${q(row.text)} })` : `page.getByRole("row").${row.at}()`;
}

function scopeOf(page: Page, row: RowScope | undefined): Page | Locator {
  if (!row) return page;
  const rows = page.getByRole("row");
  return "text" in row ? rows.filter({ hasText: row.text }) : row.at === "first" ? rows.first() : rows.last();
}

/** The element an action acts on, as code (after `await `), and the helper it uses. Undefined for actions on no element. */
export function elementCode(a: StepAction): { code: string; helper?: Helper } | undefined {
  const scope = scopeCode(a.row);
  switch (a.verb) {
    case "click":
      if (!a.target) return { code: scope };
      return a.byText ? { code: `${scope}.getByText(${q(a.target)}, { exact: true })` } : { code: `clickable(${scope}, ${q(a.target)})`, helper: "clickable" };
    case "fill":
    case "select":
      return { code: `field(${scope}, ${q(a.target!)})`, helper: "field" };
    case "expect":
      return a.shown === undefined ? { code: `field(${scope}, ${q(a.target!)})`, helper: "field" } : undefined;
    case "check":
    case "uncheck":
      return { code: `checkable(${scope}, ${q(a.target!)})`, helper: "checkable" };
    default:
      return undefined;
  }
}

/** The same element on a live page. */
function elementOf(page: Page, a: StepAction): Locator | undefined {
  const scope = scopeOf(page, a.row);
  switch (a.verb) {
    case "click":
      if (!a.target) return scope as Locator;
      return a.byText ? scope.getByText(a.target, { exact: true }) : clickable(scope, a.target);
    case "fill":
    case "select":
      return field(scope, a.target!);
    case "expect":
      return a.shown === undefined ? field(scope, a.target!) : undefined;
    case "check":
    case "uncheck":
      return checkable(scope, a.target!);
    default:
      return undefined;
  }
}

/** How long a `wait` for a text waits; other actions wait `actionTimeout`. */
export const WAIT_TEXT_MS = 30_000;

/** The lines of a generated test that do the action (each after the test's indentation). */
export function actionCode(a: StepAction): string[] {
  const el = elementCode(a)?.code;
  // `visible=true` rather than filter({ visible: true }), which needs Playwright 1.51
  const shown = (text: string) => `page.getByText(${q(text)}).locator("visible=true")`;
  switch (a.verb) {
    case "open":
      return [`await page.goto(${q(a.target!)});`];
    case "fill":
      return [`await ${el}.fill(${q(a.value!)});`];
    case "select":
      return [`await ${el}.selectOption(${q(a.value!)});`];
    case "check":
    case "uncheck":
      return [`await ${el}.${a.verb}();`];
    case "click":
      return [`await ${el}.click();`];
    case "press":
      return [`await page.keyboard.press(${q(a.target!)});`];
    case "wait":
      if (a.ms !== undefined) return [`await page.waitForTimeout(${a.ms});`];
      return a.hidden
        ? [`await expect(${shown(a.shown!)}).toHaveCount(0, { timeout: ${WAIT_TEXT_MS} });`]
        : [`await expect(${shown(a.shown!)}.first()).toBeVisible({ timeout: ${WAIT_TEXT_MS} });`];
    case "expect":
      if (a.shown === undefined) return [`await expect(${el}).toHaveValue(${q(a.value!)});`];
      return a.hidden ? [`await expect(${shown(a.shown)}).toHaveCount(0);`] : [`await expect(${shown(a.shown)}.first()).toBeVisible();`];
    case "dialog":
      return [`dialogs.push(${a.accept === false ? "false" : a.value !== undefined ? q(a.value) : "true"}); // ${a.written.replace(/\s+/g, " ")}`];
  }
}

/** What happened to a step's actions in `verify --auto`. */
export interface ActionRun {
  /** How many actions were done (all of them, unless one failed). */
  done: number;
  failed?: ActionFailure;
  /** The dialogs that opened, and how they were answered. */
  dialogs: string[];
}

export interface ActionFailure {
  action: StepAction;
  message: string;
  /** What is on the page with a similar name, as the accessibility tree names it. */
  candidates?: string[];
  /** The page's accessibility tree when it failed (its text: the report holds the database's values anyway). */
  screen?: string;
}

const TEXT = {
  en: {
    notFound: (what: string) => `${what} was not found on the page.`,
    several: (what: string, n: number) => `${what} matches ${n} elements: name one of them (a row: \`click: Cancel (row "1042")\`).`,
    noRow: (row: string) => `No table row shows "${row}".`,
    textOnly: (name: string) => `"${name}" is on the page as text, not as a button or link: write \`click: text "${name}"\`.`,
    unlabelled: (name: string) => `"${name}" is on the page as text, but it isn't the label of a field (the field has no name): use the field's placeholder, or another field's name.`,
    notShown: (text: string) => `"${text}" was not shown.`,
    stillShown: (text: string) => `"${text}" was still shown.`,
    value: (label: string, expected: string, actual: string) => `${label} holds "${actual}", not "${expected}".`,
    options: (list: string) => `The options are: ${list}.`,
    notSelect: (label: string) => `${label} is not a list box (<select>): click it, then click the option.`,
    timeout: (ms: number) => `(waited ${ms / 1000}s)`,
    clickable: (name: string) => `a button or link "${name}"`,
    field: (name: string) => `a field "${name}"`,
    checkable: (name: string) => `a check box or radio button "${name}"`,
    text: (name: string) => `the text "${name}"`,
    row: (row: RowScope) => ("text" in row ? ` in the row showing "${row.text}"` : ` in the ${row.at} row`),
    theRow: (row: RowScope) => ("text" in row ? `the row showing "${row.text}"` : `the ${row.at} row`),
    dialog: (type: string, message: string, answer: string) => `${type} "${message}": ${answer}`,
  },
  ja: {
    notFound: (what: string) => `${what}が画面に見つかりません。`,
    several: (what: string, n: number) => `${what}が ${n} 個あります。どれか 1 つを指定してください(行なら「押す: キャンセル (「1042」の行)」)。`,
    noRow: (row: string) => `「${row}」を含む表の行がありません。`,
    textOnly: (name: string) => `「${name}」はボタンやリンクではなく文字として画面にあります。「押す: 文字「${name}」」と書いてください。`,
    unlabelled: (name: string) => `「${name}」は文字として画面にありますが、入力欄のラベルになっていません(入力欄に名前がありません)。入力欄のプレースホルダーか、ほかの名前を使ってください。`,
    notShown: (text: string) => `「${text}」が表示されませんでした。`,
    stillShown: (text: string) => `「${text}」が表示されたままでした。`,
    value: (label: string, expected: string, actual: string) => `${label} の値が「${expected}」ではなく「${actual}」でした。`,
    options: (list: string) => `選択肢: ${list}`,
    notSelect: (label: string) => `${label} はリストボックス(<select>)ではありません。押して開いてから、選択肢を押してください。`,
    timeout: (ms: number) => `(${ms / 1000} 秒待ちました)`,
    clickable: (name: string) => `ボタンかリンク「${name}」`,
    field: (name: string) => `入力欄「${name}」`,
    checkable: (name: string) => `チェックボックスかラジオボタン「${name}」`,
    text: (name: string) => `文字「${name}」`,
    row: (row: RowScope) => ("text" in row ? `(「${row.text}」の行)` : row.at === "first" ? "(最初の行)" : "(最後の行)"),
    theRow: (row: RowScope) => ("text" in row ? `「${row.text}」の行` : row.at === "first" ? "最初の行" : "最後の行"),
    dialog: (type: string, message: string, answer: string) => `${type}「${message}」: ${answer}`,
  },
};
type Text = (typeof TEXT)["en"];

export interface RunOptions {
  lang: Lang;
  /** The app's URL, that paths are opened from. */
  app?: string;
  /** How long an action waits for its element. Default 5000ms. */
  actionTimeout?: number;
}

/**
 * Runs actions on the page one after another, stopping at the first that fails. Dialogs are answered
 * as the actions before them say (`dialog: Cancel`), else with OK.
 */
export class ActionRunner {
  private readonly answers: StepAction[] = [];
  private dialogs: string[] = [];

  constructor(
    private readonly page: Page,
    private readonly options: RunOptions,
  ) {
    page.on("dialog", (d) => {
      const a = this.answers.shift();
      const t = TEXT[options.lang];
      const answer = a?.accept === false ? (options.lang === "ja" ? "キャンセル" : "Cancel") : a?.value !== undefined ? `OK (${a.value})` : "OK";
      this.dialogs.push(t.dialog(d.type(), d.message(), answer));
      void (a?.accept === false ? d.dismiss() : d.accept(a?.value)).catch(() => undefined);
    });
  }

  async run(actions: StepAction[]): Promise<ActionRun> {
    this.dialogs = [];
    const t = TEXT[this.options.lang];
    let done = 0;
    for (const a of actions) {
      try {
        await this.do(a, t);
      } catch (e) {
        const failure = await this.failure(a, e as Error, t);
        return { done, failed: failure, dialogs: this.dialogs };
      }
      done++;
    }
    return { done, dialogs: this.dialogs };
  }

  /** The page's accessibility tree with its text, for the report. */
  async screen(max = 4000): Promise<string | undefined> {
    const yaml = await this.page.locator("body").ariaSnapshot({ timeout: 2000 }).catch(() => undefined);
    if (yaml === undefined) return undefined;
    const text = formatAria(shapeAria(parseAria(yaml), { text: true }));
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
  }

  private get timeout() {
    return this.options.actionTimeout ?? 5000;
  }

  private async do(a: StepAction, t: Text): Promise<void> {
    const page = this.page;
    const timeout = this.timeout;
    const el = elementOf(page, a);
    switch (a.verb) {
      case "open":
        await page.goto(appUrl(a.target!, this.options.app, page.url()), { timeout: Math.max(timeout, 30_000) });
        return;
      case "fill":
        await el!.fill(a.value!, { timeout });
        return;
      case "select":
        await el!.selectOption(a.value!, { timeout });
        return;
      case "check":
        await el!.check({ timeout });
        return;
      case "uncheck":
        await el!.uncheck({ timeout });
        return;
      case "click":
        await el!.click({ timeout });
        return;
      case "press":
        await page.keyboard.press(a.target!);
        return;
      case "dialog":
        this.answers.push(a);
        return;
      case "wait":
        if (a.ms !== undefined) return void (await page.waitForTimeout(a.ms));
        return this.shown(a.shown!, !!a.hidden, WAIT_TEXT_MS, t);
      case "expect": {
        if (a.shown !== undefined) return this.shown(a.shown, !!a.hidden, timeout, t);
        const deadline = Date.now() + timeout;
        for (;;) {
          const value = await el!.inputValue({ timeout: Math.max(1, deadline - Date.now()) });
          if (value === a.value) return;
          if (Date.now() >= deadline) throw new Expected(t.value(a.target!, a.value!, value));
          await page.waitForTimeout(100);
        }
      }
    }
  }

  private async shown(text: string, hidden: boolean, timeout: number, t: Text): Promise<void> {
    const visible = this.page.getByText(text).locator("visible=true");
    if (!hidden) {
      await visible
        .first()
        .waitFor({ state: "visible", timeout })
        .catch(() => {
          throw new Expected(`${t.notShown(text)} ${t.timeout(timeout)}`);
        });
      return;
    }
    const deadline = Date.now() + timeout;
    while ((await visible.count()) > 0) {
      if (Date.now() >= deadline) throw new Expected(`${t.stillShown(text)} ${t.timeout(timeout)}`);
      await this.page.waitForTimeout(100);
    }
  }

  /** Why the action failed, in words a chat can act on, with what is on the page instead. */
  private async failure(a: StepAction, e: Error, t: Text): Promise<ActionFailure> {
    const screen = await this.screen();
    const base = { action: a, ...(screen ? { screen } : {}) };
    if (e instanceof Expected) return { ...base, message: e.message };
    const el = elementOf(this.page, a);
    const what = describe(a, t);
    if (!el) return { ...base, message: firstLine(e.message) };
    const count = await el.count().catch(() => -1);
    if (count > 1) return { ...base, message: t.several(what, count) };
    if (count === 0) {
      if (a.row && "text" in a.row && (await (scopeOf(this.page, a.row) as Locator).count().catch(() => 1)) === 0) return { ...base, message: t.noRow(a.row.text) };
      const nodes = parseAria((await this.page.locator("body").ariaSnapshot({ timeout: 2000 }).catch(() => "")) ?? "");
      const said = a.target && !a.byText && texts(nodes).some((x) => x.trim() === a.target);
      const hint = !said ? "" : a.verb === "click" ? ` ${t.textOnly(a.target!)}` : a.verb === "fill" || a.verb === "select" ? ` ${t.unlabelled(a.target!)}` : "";
      const candidates = similar(nodes, a);
      return { ...base, message: `${t.notFound(what)}${hint}`, ...(candidates.length ? { candidates } : {}) };
    }
    // found once, but it couldn't be done: not a select, an option that isn't there, disabled...
    if (a.verb === "select") {
      const options = await el
        .evaluate((node) => (node instanceof HTMLSelectElement ? [...node.options].map((o) => (o.value === o.text ? o.text : `${o.text} (${o.value})`)) : null))
        .catch(() => undefined);
      if (options === null) return { ...base, message: t.notSelect(what) };
      if (options) return { ...base, message: `${firstLine(e.message)} ${t.options(options.map((o) => `"${o}"`).join(", "))}` };
    }
    return { ...base, message: firstLine(e.message) };
  }
}

/** A failure the action itself reports (a text not shown, a value that differs). */
class Expected extends Error {}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.replace(/\u001b\[[0-9;]*m/g, "").trim() ?? s;

function describe(a: StepAction, t: Text): string {
  const row = a.row ? t.row(a.row) : "";
  if (a.verb === "click" && !a.target) return t.theRow(a.row!);
  if (a.verb === "click") return (a.byText ? t.text(a.target!) : t.clickable(a.target!)) + row;
  if (a.verb === "check" || a.verb === "uncheck") return t.checkable(a.target!) + row;
  return t.field(a.target ?? "") + row;
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "listbox", "slider"]);

/** What on the page has a name like the one written, of the kind the action needs (or, when none is alike, all of that kind). */
function similar(nodes: AriaNode[], a: StepAction, max = 8): string[] {
  const roles: ReadonlySet<string> =
    a.verb === "click" ? new Set<string>(CLICKABLE) : a.verb === "check" || a.verb === "uncheck" ? new Set<string>(CHECKABLE) : FIELD_ROLES;
  // a list box's options (<select>) are picked with select, not clicked
  const inSelect = new Set(collect(nodes, (n) => n.role === "combobox").flatMap((n) => n.children));
  const named = namedNodes(nodes).filter((n) => roles.has(n.role) && !inSelect.has(n));
  const placeholders = collect(nodes, (n) => roles.has(n.role) && n.props.some(([k]) => k === "placeholder"));
  const shown = (n: AriaNode) => `${n.role} "${n.name}"`;
  const items = [
    ...named.map((n) => ({ text: shown(n), name: n.name! })),
    ...placeholders.map((n) => {
      const p = n.props.find(([k]) => k === "placeholder")![1];
      return { text: `${n.role} (placeholder "${p}")`, name: p };
    }),
  ];
  const target = a.target ?? "";
  const scored = [...new Map(items.map((i) => [i.text, { ...i, score: likeness(target, i.name) }])).values()];
  const alike = scored.filter((s) => s.score >= 0.3).sort((x, y) => y.score - x.score);
  return (alike.length ? alike : scored).slice(0, max).map((s) => s.text);
}

function collect(nodes: AriaNode[], test: (n: AriaNode) => boolean): AriaNode[] {
  const out: AriaNode[] = [];
  const walk = (list: AriaNode[]) => {
    for (const n of list) {
      if (test(n)) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 0 to 1: how alike two names are (same letters in pairs, ignoring case, spaces and full / half width). */
export function likeness(a: string, b: string): number {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const pairs = (s: string) => {
    const chars = [...s];
    return chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
  };
  const px = pairs(x);
  const py = pairs(y);
  const left = [...py];
  let shared = 0;
  for (const p of px) {
    const i = left.indexOf(p);
    if (i >= 0) {
      shared++;
      left.splice(i, 1);
    }
  }
  return (2 * shared) / (px.length + py.length);
}
