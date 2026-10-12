import { hiddenItself, inFrame, isElement, normalize, textOf, type Dom, type DomNode } from "./dom.js";

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
}

const q = (s: string) => JSON.stringify(s);
/** For a CSS attribute selector in single quotes (the code then needs no escaped double quotes). */
const cssValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ");
/** The same role locator, counting hidden elements too. */
const includingHidden = (code: string) => (code.endsWith(")") && code.includes(", {") ? code.replace(/ }\)$/, ", includeHidden: true })") : code.replace(/\)$/, ", { includeHidden: true })"));

/** Roles a test finds by their name. */
const NAMED_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
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
    const index = (c.visibleOnly ? all.filter((n) => c.matches(n)) : found).indexOf(el);
    if (!fallback && index >= 0) fallback = { c, index };
  }
  if (fallback) return { code: `${fallback.c.visibleOnly ? includingHidden(fallback.c.code) : fallback.c.code}.nth(${fallback.index})`, label };
  const same = all.filter((n) => n.tag === el.tag);
  return { code: `locator(${q(el.tag)}).nth(${same.indexOf(el)})`, label };
}

/** A click on the text inside a button is a click on the button. */
function actionable(n: DomNode): DomNode {
  for (let p: DomNode | undefined = n; p && isElement(p); p = p.parent) {
    const role = p.attrs.get("role");
    if (INTERACTIVE.has(p.tag) || (role && NAMED_ROLES.has(role))) return p;
  }
  return n;
}

function candidatesFor(el: DomNode, names: Names): Candidate[] {
  const out: Candidate[] = [];
  const tag = el.tag;
  const attr = (name: string) => el.attrs.get(name);

  const testId = attr("data-testid");
  if (testId) out.push({ code: `getByTestId(${q(testId)})`, matches: (n) => n.attrs.get("data-testid") === testId, visibleOnly: false });

  const role = roleOf(el);
  const name = names.name(el);
  if (role && NAMED_ROLES.has(role) && name && name.length <= MAX_NAME) {
    out.push({ code: `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, matches: (n) => roleOf(n) === role && names.name(n) === name, visibleOnly: true });
  }

  if (FIELDS.has(tag)) {
    // Playwright matches each label on its own
    const label = names.labels(el).find((l) => l && l.length <= MAX_NAME);
    if (label) out.push({ code: `getByLabel(${q(label)}, { exact: true })`, matches: (n) => names.labels(n).includes(label), visibleOnly: false });
  }
  const placeholder = attr("placeholder");
  if (placeholder && (tag === "input" || tag === "textarea")) {
    out.push({ code: `getByPlaceholder(${q(placeholder)}, { exact: true })`, matches: (n) => n.attrs.get("placeholder") === placeholder, visibleOnly: false });
  }

  // a clickable cell, list item or div: by its own text
  if (!role && !FIELDS.has(tag)) {
    const text = textOf(el, false);
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
  if (role && name) out.push({ code: `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`, matches: (n) => roleOf(n) === role && names.name(n) === name, visibleOnly: true });
  if (role) out.push({ code: `getByRole(${q(role)})`, matches: (n) => roleOf(n) === role, visibleOnly: true });
  return out;
}

/** The element's text, when none of its child elements has all of it (Playwright's getByText finds the innermost). */
function ownText(n: DomNode): string | undefined {
  const text = textOf(n, false);
  return n.children.some((c) => isElement(c) && textOf(c, false) === text) ? undefined : text;
}

/** Hidden by an attribute or an inline style (stylesheets aren't looked at). */
function hidden(n: DomNode): boolean {
  if (n.tag === "input" && n.attrs.get("type")?.toLowerCase() === "hidden") return true;
  for (let p: DomNode | undefined = n; p && isElement(p); p = p.parent) if (hiddenItself(p)) return true;
  return false;
}

/** The ARIA role of an element, explicit or implied by its tag. */
export function roleOf(n: DomNode): string | undefined {
  const explicit = n.attrs.get("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  switch (n.tag) {
    case "button":
      return "button";
    case "a":
    case "area":
      return n.attrs.has("href") ? "link" : undefined;
    case "input": {
      const type = (n.attrs.get("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "number") return "spinbutton";
      if (type === "range") return "slider";
      if (type === "search") return n.attrs.has("list") ? "combobox" : "searchbox";
      if (["text", "email", "tel", "url", ""].includes(type)) return n.attrs.has("list") ? "combobox" : "textbox";
      return undefined;
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

const labelable = (n: DomNode) => LABELABLE.has(n.tag) && !(n.tag === "input" && n.attrs.get("type")?.toLowerCase() === "hidden");

/** Accessible names and labels, computed once per element. */
class Names {
  private readonly names = new Map<DomNode, string>();
  private readonly labelLists = new Map<DomNode, string[]>();
  private byId?: Map<string, DomNode>;
  private labelElements?: Map<DomNode, DomNode[]>;

  constructor(private readonly dom: Dom) {}

  /** What getByRole's `name` matches. */
  name(n: DomNode): string {
    let name = this.names.get(n);
    if (name === undefined) this.names.set(n, (name = this.computeName(n)));
    return name;
  }

  /** What getByLabel matches, each on its own: the elements of aria-labelledby, aria-label, or the element's <label>s. */
  labels(n: DomNode): string[] {
    let labels = this.labelLists.get(n);
    if (labels === undefined) this.labelLists.set(n, (labels = this.computeLabels(n)));
    return labels;
  }

  /** The label the element is known by, for its name and comments. */
  label(n: DomNode): string {
    return normalize(this.labels(n).join(" "));
  }

  private computeName(n: DomNode): string {
    const labelledBy = this.labelledBy(n);
    if (labelledBy) return normalize(labelledBy.map((l) => textOf(l, true, true)).join(" "));
    const label = this.label(n);
    if (label) return label;
    if (n.tag === "input") {
      const type = (n.attrs.get("type") ?? "").toLowerCase();
      if (type === "submit" || type === "reset" || type === "button") return normalize(n.attrs.get("value") ?? (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""));
      if (type === "image") return normalize(n.attrs.get("alt") ?? "");
      return normalize(n.attrs.get("title") ?? "");
    }
    if (FIELDS.has(n.tag)) return normalize(n.attrs.get("title") ?? "");
    return textOf(n, true, true) || normalize(n.attrs.get("title") ?? "");
  }

  private computeLabels(n: DomNode): string[] {
    const labelledBy = this.labelledBy(n);
    if (labelledBy) return labelledBy.map((l) => textOf(l, false));
    const aria = n.attrs.get("aria-label");
    if (aria && normalize(aria)) return [normalize(aria)];
    return labelable(n) ? (this.labelsOf().get(n) ?? []).map((l) => textOf(l, false)) : [];
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
  const name = names.name(el) || el.attrs.get("placeholder") || el.attrs.get("name") || "";
  const short = name.length > 40 ? `${name.slice(0, 40)}…` : name;
  return short ? `${kind} "${short}"` : kind;
}
