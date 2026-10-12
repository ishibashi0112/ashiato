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

/**
 * The text of a node, whitespace collapsed (scripts and styles left out). With `alt`, images count
 * by their alt text, as in accessible names (Playwright's text and label matching leaves them out).
 * With `name`, hidden parts (an icon marked aria-hidden) are left out, as in accessible names.
 */
export function textOf(n: DomNode, alt = true, name = false): string {
  const parts: string[] = [];
  const walk = (x: DomNode) => {
    if (x.type === TEXT) parts.push(x.text);
    if (x.type === ELEMENT && (x.tag === "script" || x.tag === "style" || x.tag === "noscript" || x.tag === "template")) return;
    if (name && x !== n && x.type === ELEMENT && hiddenItself(x)) return;
    if (alt && x.type === ELEMENT && x.tag === "img" && x.attrs.get("alt")) parts.push(` ${x.attrs.get("alt")} `);
    for (const c of x.children) walk(c);
  };
  walk(n);
  return normalize(parts.join(""));
}

/** Hidden by an attribute or an inline style of its own (stylesheets aren't looked at). */
export function hiddenItself(n: DomNode): boolean {
  if (n.attrs.has("hidden") || n.attrs.get("aria-hidden") === "true") return true;
  return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(n.attrs.get("style") ?? "");
}

/** Whitespace collapsed, as Playwright compares text (zero-width spaces and soft hyphens left out). */
export const normalize = (s: string) => s.replace(/[\u200b\u00ad]/g, "").replace(/\s+/g, " ").trim();
