/**
 * The page as it was at a moment of its screen replay, rebuilt from rrweb's events: just enough of
 * it (elements, attributes, text) to say how a test can find the element an event happened on.
 */

/** rrweb's serialized node types. */
const DOCUMENT = 0;
const ELEMENT = 2;
const TEXT = 3;

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SerializedNode[];
}

interface MutationData {
  texts?: { id: number; value: string | null }[];
  attributes?: { id: number; attributes: Record<string, unknown> }[];
  removes?: { parentId: number; id: number }[];
  adds?: { parentId: number; nextId: number | null; node: SerializedNode }[];
}

export interface DomNode {
  id: number;
  type: number;
  /** Lower case. */
  tag: string;
  attrs: Map<string, string>;
  text: string;
  parent?: DomNode;
  children: DomNode[];
}

export class Dom {
  private readonly nodes = new Map<number, DomNode>();
  root?: DomNode;

  /** A full snapshot: the page starts over. */
  reset(node: SerializedNode): void {
    this.nodes.clear();
    this.root = this.build(node);
  }

  get(id: number): DomNode | undefined {
    return this.nodes.get(id);
  }

  mutate(m: MutationData): void {
    for (const r of m.removes ?? []) {
      const node = this.nodes.get(r.id);
      if (!node) continue;
      if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
      this.drop(node);
    }
    // a node can come before its parent, or before the sibling it goes in front of: retry those
    let pending = [...(m.adds ?? [])];
    while (pending.length) {
      const later = pending.filter((a) => {
        const parent = this.nodes.get(a.parentId);
        if (!parent || (a.nextId !== null && !this.nodes.has(a.nextId))) return true;
        this.insert(parent, a.node, a.nextId === null ? undefined : this.nodes.get(a.nextId));
        return false;
      });
      if (later.length === pending.length) {
        // what is still missing never comes: put the nodes whose parent is there at its end
        for (const a of later) {
          const parent = this.nodes.get(a.parentId);
          if (parent) this.insert(parent, a.node, undefined);
        }
        break;
      }
      pending = later;
    }
    for (const t of m.texts ?? []) {
      const node = this.nodes.get(t.id);
      if (node) node.text = t.value ?? "";
    }
    for (const a of m.attributes ?? []) {
      const node = this.nodes.get(a.id);
      if (!node) continue;
      for (const [name, value] of Object.entries(a.attributes)) {
        if (value === null) node.attrs.delete(name);
        else if (typeof value === "string") node.attrs.set(name, value);
        // style changes come as objects: they don't help find an element
      }
    }
  }

  /** Every element of the page, in document order: not those of its frames, nor of its <head> (a test doesn't find those). */
  *elements(from = this.root): Generator<DomNode> {
    if (!from) return;
    if (from.type === DOCUMENT && from.parent) return;
    if (from.type === ELEMENT) {
      if (from.tag === "head") return;
      yield from;
    }
    for (const c of from.children) yield* this.elements(c);
  }

  private insert(parent: DomNode, s: SerializedNode, before: DomNode | undefined): void {
    // a node added again (moved) leaves its old place
    const old = this.nodes.get(s.id);
    if (old?.parent) old.parent.children = old.parent.children.filter((c) => c !== old);
    const node = this.build(s, parent);
    const i = before ? parent.children.indexOf(before) : -1;
    if (i >= 0) parent.children.splice(i, 0, node);
    else parent.children.push(node);
  }

  private build(s: SerializedNode, parent?: DomNode): DomNode {
    const old = this.nodes.get(s.id);
    if (old) this.drop(old);
    const attrs = new Map<string, string>();
    for (const [k, v] of Object.entries(s.attributes ?? {})) if (typeof v === "string") attrs.set(k, v);
    const node: DomNode = { id: s.id, type: s.type, tag: (s.tagName ?? "").toLowerCase(), attrs, text: s.type === TEXT ? (s.textContent ?? "") : "", parent, children: [] };
    this.nodes.set(s.id, node);
    for (const c of s.childNodes ?? []) node.children.push(this.build(c, node));
    return node;
  }

  private drop(node: DomNode): void {
    if (this.nodes.get(node.id) === node) this.nodes.delete(node.id);
    for (const c of node.children) this.drop(c);
  }
}

export const isElement = (n: DomNode | undefined): n is DomNode => n?.type === ELEMENT;

/** Inside a frame of the page (rrweb puts a frame's document under its <iframe>). */
export function inFrame(n: DomNode): boolean {
  for (let p = n.parent; p; p = p.parent) if (p.type === DOCUMENT && p.parent) return true;
  return false;
}

const SKIPPED = new Set(["script", "style", "noscript", "template"]);

/**
 * The text of a node as Playwright's getByText and getByLabel match it: its text nodes run together,
 * whitespace collapsed, with the value of an <input type=submit|button> inside (images don't count).
 */
export function textOf(n: DomNode): string {
  const walk = (x: DomNode): string => {
    if (x.type === TEXT) return x.text;
    if (x.type === ELEMENT) {
      if (SKIPPED.has(x.tag)) return "";
      if (x.tag === "input" && /^(submit|button)$/i.test(x.attrs.get("type") ?? "")) return x.attrs.get("value") ?? "";
    }
    return x.children.map(walk).join("");
  };
  return normalize(walk(n));
}

/**
 * The accessible name an element gets from its content, as Playwright computes it for getByRole: hidden
 * parts left out (unless `includeHidden`, as getByRole then does), images by their alt text, and a
 * space around each element that isn't shown inline. Whether it is depends on stylesheets, not known
 * here: where an element begins or ends, the name is marked (see `nameText` and `namePattern`), unless
 * its inline style says. `skip` is the element being named (inside its <label>).
 */
export function contentName(n: DomNode, includeHidden = false, skip?: DomNode): string {
  const walk = (x: DomNode, top: boolean): string => {
    if (x.type === TEXT) return x.text;
    if (x.type !== ELEMENT) return "";
    if (x === skip || SKIPPED.has(x.tag) || (!top && !includeHidden && hiddenItself(x))) return "";
    const aria = normalize(x.attrs.get("aria-label") ?? "");
    let token: string;
    if (!top && aria) token = aria;
    else if (x.tag === "img") token = normalize(x.attrs.get("alt") ?? "") || (x.attrs.get("title") ?? "");
    else if (x.tag === "input" && /^(submit|button|reset)$/i.test(x.attrs.get("type") ?? "")) {
      const type = x.attrs.get("type")!.toLowerCase();
      token = normalize(x.attrs.get("value") ?? "") || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : (x.attrs.get("title") ?? ""));
    } else if (!top && (x.tag === "input" || x.tag === "textarea" || x.tag === "select")) token = x.attrs.get("value") ?? "";
    else {
      token = x.children.map((c) => walk(c, false)).join("");
      if (!top && !nameText(token)) token = x.attrs.get("title") ?? "";
    }
    if (top) return token;
    if (x.tag === "br") return ` ${token} `;
    const display = displayOf(x);
    if (display) return display === "inline" || display === "contents" ? token : ` ${token} `;
    const mark = INLINE.has(x.tag) ? JOIN : GAP;
    return `${mark}${token}${mark}`;
  };
  return walk(n, true);
}

/** Where an element of a name begins or ends, shown inline by default: no space, unless a stylesheet says otherwise. */
const JOIN = "\u0001";
/** Where an element of a name begins or ends, not shown inline by default (a <div>): a space, unless a stylesheet says otherwise. */
const GAP = "\u0002";
const MARKS = /[\u0001\u0002]/g;

/** A name from `contentName` as the browser most likely has it. */
export const nameText = (name: string) => normalize(name.replace(/\u0002/g, " ").replace(/\u0001/g, ""));

/**
 * A name from `contentName` as a regular expression (source), when a place between two of its
 * characters may or may not hold a space depending on stylesheets: `受注 ?一覧`. Else undefined.
 */
export function namePattern(name: string): string | undefined {
  const pieces = name.replace(/[\u200b\u00ad]/g, "").split(/([\s\u0001\u0002]+)/).filter((p) => p !== "");
  const separator = (p: string) => /^[\s\u0001\u0002]+$/.test(p);
  while (pieces.length && separator(pieces[0]!)) pieces.shift();
  while (pieces.length && separator(pieces.at(-1)!)) pieces.pop();
  let loose = false;
  const source = pieces
    .map((p) => {
      if (!separator(p)) return p.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
      if (/\s/.test(p.replace(MARKS, ""))) return " ";
      loose = true;
      return " ?";
    })
    .join("");
  return loose ? `^${source}$` : undefined;
}

/** Elements the browser shows inline unless styled otherwise. */
const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "font", "i", "img", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr", "svg", "picture", "canvas", "video", "audio", "iframe", "object", "embed"]);

/** The display an element's inline style gives it. */
const displayOf = (n: DomNode) => /(?:^|;)\s*display\s*:\s*([a-z-]+)/i.exec(n.attrs.get("style") ?? "")?.[1]?.toLowerCase();

/** The editable area (contenteditable) the node is in: Playwright fills it like a field. */
export function editableOf(node: DomNode | undefined): DomNode | undefined {
  let found: DomNode | undefined;
  for (let p = node; p && isElement(p); p = p.parent) {
    const v = p.attrs.get("contenteditable");
    if (v === "false") break;
    if (v !== undefined && ["", "true", "plaintext-only"].includes(v.toLowerCase())) found = p;
  }
  return found;
}

/** Hidden by an attribute or an inline style of its own (stylesheets aren't looked at). */
export function hiddenItself(n: DomNode): boolean {
  if (n.attrs.has("hidden") || n.attrs.get("aria-hidden") === "true") return true;
  return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.attrs.get("style") ?? "");
}

/** Whitespace collapsed, as Playwright compares text (zero-width spaces and soft hyphens left out). */
export const normalize = (s: string) => s.replace(/[\u200b\u00ad]/g, "").replace(/\s+/g, " ").trim();
