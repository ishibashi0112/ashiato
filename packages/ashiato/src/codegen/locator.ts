import { contentName, editableOf, hiddenItself, inFrame, isElement, namePattern, nameText, normalize, textOf, type Dom, type DomNode } from "./dom.js";

export interface Locator {
  /** Code that finds the element, after `page.`: `getByRole("button", { name: "Save", exact: true })`. */
  code: string;
  /** For comments: `button "Save"`. */
  label: string;
}

interface Candidate {
  code: string;
  matches: (n: DomNode) => boolean;
  /**
   * Playwright's getByRole leaves out hidden elements; other locators count them too. Elements
   * hidden by a stylesheet look visible here, so a position among them is taken with `includeHidden`.
   */
  visibleOnly: boolean;
  /** The same locator counting hidden elements too, when it differs from adding `includeHidden` (names then take in hidden text). */
  includingHidden?: Pick<Candidate, "code" | "matches">;
}

/** A string literal (line and paragraph separators escaped: they would end a comment). */
const q = (s: string) => JSON.stringify(s).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
/** For a CSS attribute selector in single quotes (the code then needs no escaped double quotes). */
const cssValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ");
/** The same role locator, counting hidden elements too. */
const includingHidden = (code: string) => (code.endsWith(")") && code.includes(", {") ? code.replace(/ }\)$/, ", includeHidden: true })") : code.replace(/\)$/, ", { includeHidden: true })"));

/** Roles a test finds by their name. */
const NAMED_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
/** Roles whose name comes from their content (else only from a label, aria-label or title), as Playwright has it. */
const NAMED_BY_CONTENT = new Set([...NAMED_ROLES, "cell", "columnheader", "gridcell", "heading", "row", "rowheader", "tooltip"]);
/** The roles Playwright knows: a role attribute takes the first of these it lists. */
const ROLES = new Set(
  "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(" "),
);
const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "label", "summary"]);
const FIELDS = new Set(["input", "select", "textarea"]);
/** Elements a <label> can label. */
const LABELABLE = new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);
const MAX_NAME = 80;

/**
 * How a test finds the element: by test id, role and name, label, placeholder or text when that is
 * unique on the page, else by an id or attribute, else the nth of the best match.
 */
export function locatorFor(dom: Dom, target: DomNode): Locator | { unsupported: string } {
  if (inFrame(target)) return { unsupported: "it is in a frame" };
  const el = actionable(target);
  const names = new Names(dom);
  const candidates = candidatesFor(el, names);
  const all = [...dom.elements()];
  const visible = all.filter((n) => !hidden(n));
  const label = describe(el, names);
  let fallback: { c: Candidate; index: number } | undefined;
  for (const c of candidates) {
    if (!c.matches(el)) continue;
    const found = (c.visibleOnly ? visible : all).filter((n) => c.matches(n));
    if (found.length === 1) return { code: c.code, label };
    if (fallback) continue;
    const counted = c.visibleOnly ? (c.includingHidden ?? { code: includingHidden(c.code), matches: c.matches }) : c;
    const index = all.filter((n) => counted.matches(n)).indexOf(el);
    if (index >= 0) fallback = { c: { ...c, ...counted }, index };
  }
  if (fallback) return { code: `${fallback.c.code}.nth(${fallback.index})`, label };
  const same = all.filter((n) => n.tag === el.tag);
  return { code: `locator(${q(el.tag)}).nth(${same.indexOf(el)})`, label };
}

/** A click on the text inside a button is a click on the button, and inside an editable area one on the area. */
function actionable(n: DomNode): DomNode {
  const area = editableOf(n);
  for (let p: DomNode | undefined = n; p && isElement(p); p = p.parent) {
    if (p === area) return p;
    const role = p.attrs.get("role");
    if (INTERACTIVE.has(p.tag) || (role && NAMED_ROLES.has(role))) return p;
  }
  return n;
}

function candidatesFor(el: DomNode, names: Names): Candidate[] {
  const out: Candidate[] = [];
  const tag = el.tag;
  const attr = (name: string) => el.attrs.get(name);
  // an editable area is filled like a field: its text is what the test changes
  const field = FIELDS.has(tag) || editableOf(el) === el;

  const testId = attr("data-testid");
  if (testId) out.push({ code: `getByTestId(${q(testId)})`, matches: (n) => n.attrs.get("data-testid") === testId, visibleOnly: false });

  const role = roleOf(el);
  const name = names.name(el);
  /**
   * By role and name: as a pattern where stylesheets decide whether a space is in it (`受注 ?一覧`).
   * Counting hidden elements, their hidden text is part of their names.
   */
  const byName = (): Candidate => {
    const option = (hidden: boolean) => {
      const name = names.name(el, hidden);
      const pattern = names.pattern(el, hidden);
      // a pattern fits names that differ only in spaces: counted so, what is unique here is unique in the browser
      const squash = (s: string) => s.replace(/ /g, "");
      return pattern
        ? { code: `name: /${pattern}/`, fits: (n: DomNode) => squash(names.name(n, hidden)) === squash(name) }
        : { code: `name: ${q(name)}, exact: true`, fits: (n: DomNode) => names.name(n, hidden) === name };
    };
    const [shown, all] = [option(false), option(true)];
    return {
      code: `getByRole(${q(role!)}, { ${shown.code} })`,
      matches: (n) => roleOf(n) === role && shown.fits(n),
      visibleOnly: true,
      includingHidden: { code: `getByRole(${q(role!)}, { ${all.code}, includeHidden: true })`, matches: (n) => roleOf(n) === role && all.fits(n) },
    };
  };
  if (role && NAMED_ROLES.has(role) && name && name.length <= MAX_NAME) out.push(byName());

  if (field) {
    // Playwright matches each label on its own
    const label = names.labels(el).find((l) => l && l.length <= MAX_NAME);
    if (label) out.push({ code: `getByLabel(${q(label)}, { exact: true })`, matches: (n) => names.labels(n).includes(label), visibleOnly: false });
  }
  const placeholder = attr("placeholder");
  if (placeholder && field && tag !== "select") {
    out.push({ code: `getByPlaceholder(${q(placeholder)}, { exact: true })`, matches: (n) => n.attrs.get("placeholder") === placeholder, visibleOnly: false });
  }

  // a clickable cell, list item or div: by its own text
  if (!role && !field) {
    const text = textOf(el);
    // Playwright's getByText also finds <input type=submit> and <input type=button> by their value
    const button = (n: DomNode) => n.tag === "input" && /^(submit|button)$/i.test(n.attrs.get("type") ?? "") && normalize(n.attrs.get("value") ?? "") === text;
    if (text && text.length <= MAX_NAME) out.push({ code: `getByText(${q(text)}, { exact: true })`, matches: (n) => ownText(n) === text || button(n), visibleOnly: false });
  }
  const title = attr("title");
  if (title) out.push({ code: `getByTitle(${q(title)}, { exact: true })`, matches: (n) => n.attrs.get("title") === title, visibleOnly: false });

  const id = attr("id");
  if (id && !/\d{3,}|^:|^(ember|ext-gen|react-|radix-|headlessui-|mui-)/i.test(id)) {
    const selector = /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id='${cssValue(id)}']`;
    out.push({ code: `locator(${q(selector)})`, matches: (n) => n.attrs.get("id") === id, visibleOnly: false });
  }
  const byAttr = (a: string) => {
    const v = attr(a);
    if (v === undefined || v.length > MAX_NAME) return;
    out.push({ code: `locator(${q(`${tag}[${a}='${cssValue(v)}']`)})`, matches: (n) => n.tag === tag && n.attrs.get(a) === v, visibleOnly: false });
  };
  if (FIELDS.has(tag)) byAttr("name");
  for (const a of el.attrs.keys()) if (a.startsWith("data-") && a !== "data-testid") byAttr(a);
  if (tag === "a") byAttr("href");
  if (role && name && name.length <= MAX_NAME) out.push(byName());
  if (role) out.push({ code: `getByRole(${q(role)})`, matches: (n) => roleOf(n) === role, visibleOnly: true });
  return out;
}

/** The element's text, when none of its child elements has all of it (Playwright's getByText finds the innermost). */
function ownText(n: DomNode): string | undefined {
  const text = textOf(n);
  return n.children.some((c) => isElement(c) && textOf(c) === text) ? undefined : text;
}

/** Hidden by an attribute or an inline style (stylesheets aren't looked at). */
function hidden(n: DomNode): boolean {
  if (n.tag === "input" && n.attrs.get("type")?.toLowerCase() === "hidden") return true;
  for (let p: DomNode | undefined = n; p && isElement(p); p = p.parent) if (hiddenItself(p)) return true;
  return false;
}

/**
 * The ARIA role of an element as Playwright takes it: the first known role of its role attribute, or
 * else the one its tag implies. `none` / `presentation` give none (a test finds the element otherwise),
 * unless the element can take the focus: then its tag's role stays.
 */
export function roleOf(n: DomNode): string | undefined {
  const explicit = n.attrs.get("role")?.split(/\s+/).find((r) => ROLES.has(r));
  if (explicit === "none" || explicit === "presentation") return focusable(n) ? implicitRole(n) : undefined;
  return explicit ?? implicitRole(n);
}

const focusable = (n: DomNode) =>
  n.attrs.has("tabindex") || ["button", "select", "textarea"].includes(n.tag) || (n.tag === "a" && n.attrs.has("href")) || (n.tag === "input" && inputType(n) !== "hidden");

/** An <input>'s type as the browser takes it: an unknown one is text. */
const INPUT_TYPES = new Set(["button", "checkbox", "color", "date", "datetime-local", "email", "file", "hidden", "image", "month", "number", "password", "radio", "range", "reset", "search", "submit", "tel", "text", "time", "url", "week"]);
const inputType = (n: DomNode) => {
  const type = (n.attrs.get("type") ?? "text").trim().toLowerCase();
  return INPUT_TYPES.has(type) ? type : "text";
};

function implicitRole(n: DomNode): string | undefined {
  switch (n.tag) {
    case "button":
      return "button";
    case "a":
    case "area":
      return n.attrs.has("href") ? "link" : undefined;
    case "input": {
      const type = inputType(n);
      if (["button", "submit", "reset", "image", "file"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (type === "hidden") return undefined;
      if (type === "search") return n.attrs.has("list") ? "combobox" : "searchbox";
      if (["text", "email", "tel", "url"].includes(type)) return n.attrs.has("list") ? "combobox" : "textbox";
      // date, time, password, color...
      return "textbox";
    }
    case "textarea":
      return "textbox";
    case "select":
      return n.attrs.has("multiple") || Number(n.attrs.get("size")) > 1 ? "listbox" : "combobox";
    case "option":
      return "option";
    default:
      return /^h[1-6]$/.test(n.tag) ? "heading" : undefined;
  }
}

const labelable = (n: DomNode) => LABELABLE.has(n.tag) && !(n.tag === "input" && inputType(n) === "hidden");

/** Accessible names and labels, computed once per element. */
class Names {
  /** Names with the places marked where an element begins or ends (see `contentName`). */
  private readonly names = new Map<DomNode, string>();
  private readonly hiddenNames = new Map<DomNode, string>();
  private readonly labelLists = new Map<DomNode, string[]>();
  private byId?: Map<string, DomNode>;
  private labelElements?: Map<DomNode, DomNode[]>;

  constructor(private readonly dom: Dom) {}

  /** What getByRole's `name` matches (with `includeHidden`, hidden text is part of it). */
  name(n: DomNode, includeHidden = false): string {
    return nameText(this.marked(n, includeHidden));
  }

  /** The name as a pattern, when stylesheets decide whether some of its spaces are there. */
  pattern(n: DomNode, includeHidden = false): string | undefined {
    return namePattern(this.marked(n, includeHidden));
  }

  private marked(n: DomNode, includeHidden: boolean): string {
    const cache = includeHidden ? this.hiddenNames : this.names;
    let name = cache.get(n);
    if (name === undefined) cache.set(n, (name = this.computeName(n, includeHidden)));
    return name;
  }

  /** What getByLabel matches, each on its own: the elements of aria-labelledby, aria-label, or the element's <label>s. */
  labels(n: DomNode): string[] {
    let labels = this.labelLists.get(n);
    if (labels === undefined) this.labelLists.set(n, (labels = this.computeLabels(n)));
    return labels;
  }

  /** Playwright's accessible name, for the elements a test clicks or fills (a few rarer rules left out). */
  private computeName(n: DomNode, hidden: boolean): string {
    const title = normalize(n.attrs.get("title") ?? "");
    const labelledBy = this.labelledBy(n);
    const byRefs = labelledBy?.map((l) => contentName(l, hidden)).join(" ");
    if (byRefs && nameText(byRefs)) return byRefs;
    const aria = normalize(n.attrs.get("aria-label") ?? "");
    if (aria) return aria;
    const labels = labelable(n) ? (this.labelsOf().get(n) ?? []) : [];
    const byLabels = () => labels.map((l) => contentName(l, hidden, n)).join(" ");
    if (n.tag === "input") {
      const type = inputType(n);
      if (type === "submit" || type === "reset" || type === "button") return normalize(n.attrs.get("value") ?? "") || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : title);
      if (type === "file") return labels.length ? byLabels() : "Choose File";
      if (type === "image") return labels.length ? byLabels() : normalize(n.attrs.get("alt") ?? "") || title || "Submit";
    }
    if (labels.length) return byLabels();
    if (FIELDS.has(n.tag)) {
      const placeholder = n.tag === "textarea" || (n.tag === "input" && ["text", "password", "search", "tel", "email", "url"].includes(inputType(n)));
      return title || (placeholder ? normalize(n.attrs.get("placeholder") ?? "") : "");
    }
    if (n.tag === "img") return normalize(n.attrs.get("alt") ?? "") || title;
    const role = roleOf(n);
    if ((role && NAMED_BY_CONTENT.has(role)) || n.tag === "summary") {
      const content = contentName(n, hidden);
      return nameText(content) ? content : title;
    }
    return title;
  }

  /** As Playwright's getByLabel reads them: the text of the elements of aria-labelledby, aria-label, or of the <label>s. */
  private computeLabels(n: DomNode): string[] {
    const labelledBy = this.labelledBy(n);
    if (labelledBy) return labelledBy.map((l) => textOf(l));
    const aria = n.attrs.get("aria-label");
    if (aria && normalize(aria)) return [normalize(aria)];
    return labelable(n) ? (this.labelsOf().get(n) ?? []).map((l) => textOf(l)) : [];
  }

  /** The elements aria-labelledby points at, if any are on the page. */
  private labelledBy(n: DomNode): DomNode[] | undefined {
    const ids = n.attrs.get("aria-labelledby");
    const found = ids?.split(/\s+/).flatMap((id) => this.ids().get(id) ?? []);
    return found?.length ? found : undefined;
  }

  private ids(): Map<string, DomNode> {
    if (!this.byId) {
      this.byId = new Map();
      for (const e of this.dom.elements()) {
        const id = e.attrs.get("id");
        if (id && !this.byId.has(id)) this.byId.set(id, e);
      }
    }
    return this.byId;
  }

  /** The <label>s of each element: by their `for`, or else the first element inside them a label can label. */
  private labelsOf(): Map<DomNode, DomNode[]> {
    if (!this.labelElements) {
      this.labelElements = new Map();
      for (const label of this.dom.elements()) {
        if (label.tag !== "label") continue;
        const target = label.attrs.has("for") ? this.ids().get(label.attrs.get("for")!) : [...this.dom.elements(label)].find(labelable);
        if (target) this.labelElements.set(target, [...(this.labelElements.get(target) ?? []), label]);
      }
    }
    return this.labelElements;
  }
}

/** `button "Save"`, `textbox "Email"`. */
function describe(el: DomNode, names: Names): string {
  const kind = roleOf(el) ?? el.tag;
  const field = FIELDS.has(el.tag) || editableOf(el) === el;
  const name = names.name(el) || (field ? "" : nameText(contentName(el))) || el.attrs.get("placeholder") || el.attrs.get("name") || "";
  const short = name.length > 40 ? `${name.slice(0, 40)}…` : name;
  return short ? `${kind} "${short}"` : kind;
}
