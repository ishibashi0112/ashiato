/**
 * A page's accessibility tree, as Playwright's `ariaSnapshot()` writes it (YAML):
 *
 *   - heading "受注登録" [level=1]
 *   - textbox "数量": "3"
 *   - button "登録"
 *   - link "受注一覧":
 *     - /url: /orders
 *
 * Read back into nodes, so that `ashiato pack` can leave out what may show the database's values and
 * fold long lists, and `verify --auto` can name what is on the page when an element isn't found.
 */
export interface AriaNode {
  /** `text` for text on its own. */
  role: string;
  name?: string;
  /** `level=1`, `checked`, `selected`... */
  attrs: string[];
  /** Text after the colon: a text's text, a field's value, a paragraph's text. */
  value?: string;
  /** `/url`, `/placeholder`. */
  props: [string, string][];
  children: AriaNode[];
}

/** Reads `ariaSnapshot()` text. Lines it can't read become text nodes (shown as they are, or hidden with the other text). */
export function parseAria(yaml: string): AriaNode[] {
  const root: AriaNode = { role: "root", attrs: [], props: [], children: [] };
  const stack: { indent: number; node: AriaNode }[] = [{ indent: -1, node: root }];
  for (const raw of yaml.split(/\r?\n/)) {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.node;
    const entry = splitEntry(m[2]!);
    if (entry.key.startsWith("/")) {
      parent.props.push([entry.key.slice(1), entry.value ?? ""]);
      continue;
    }
    const node = readKey(entry.key);
    if (entry.value !== undefined) node.value = entry.value;
    parent.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

/** `key: value`, the key maybe in single quotes, the value maybe in double quotes. */
function splitEntry(content: string): { key: string; value?: string } {
  let key: string;
  let rest: string;
  if (content.startsWith("'")) {
    let i = 1;
    let k = "";
    for (; i < content.length; i++) {
      if (content[i] === "'") {
        if (content[i + 1] === "'") {
          k += "'";
          i++;
          continue;
        }
        break;
      }
      k += content[i];
    }
    key = k;
    rest = content.slice(i + 1);
  } else {
    // a key with ": " in it would have been quoted
    const colon = /:(?=\s|$)/.exec(content);
    key = colon ? content.slice(0, colon.index) : content;
    rest = colon ? content.slice(colon.index) : "";
  }
  const v = /^:\s?(.*)$/.exec(rest);
  if (!v || v[1] === "") return { key };
  return { key, value: yamlValue(v[1]!) };
}

function yamlValue(text: string): string {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text;
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** `button "Save" [disabled]` */
function readKey(key: string): AriaNode {
  const m = /^([a-z][\w-]*)(?:\s+("(?:[^"\\]|\\.)*"|\/(?:[^/\\]|\\.)*\/[a-z]*))?((?:\s*\[[^\]]*\])*)$/i.exec(key.trim());
  if (!m) return { role: "text", value: key, attrs: [], props: [], children: [] };
  let name: string | undefined;
  if (m[2]?.startsWith('"')) {
    try {
      name = JSON.parse(m[2]) as string;
    } catch {
      name = m[2].slice(1, -1);
    }
  } else if (m[2]) name = m[2];
  const attrs = [...(m[3] ?? "").matchAll(/\[([^\]]*)\]/g)].map((a) => a[1]!);
  return { role: m[1]!, ...(name !== undefined ? { name } : {}), attrs, props: [], children: [] };
}

/** Back to text, in the same form. */
export function formatAria(nodes: AriaNode[], indent = 0): string {
  const lines: string[] = [];
  const write = (n: AriaNode, depth: number) => {
    const pad = "  ".repeat(depth);
    const nested = n.children.length > 0 || n.props.length > 0;
    const head = `${n.role}${n.name !== undefined ? ` ${JSON.stringify(n.name)}` : ""}${n.attrs.map((a) => ` [${a}]`).join("")}`;
    lines.push(`${pad}- ${head}${n.value !== undefined ? `: ${n.value}` : nested ? ":" : ""}`);
    for (const [k, v] of n.props) lines.push(`${pad}  - /${k}: ${v}`);
    for (const c of n.children) write(c, depth + 1);
  };
  for (const n of nodes) write(n, indent);
  return lines.join("\n");
}

/** What hidden text is replaced with. */
export const HIDDEN = "…";

/** Roles that hold rows of data: their text, and the names of what is in them (but buttons), may be the database's values. */
const DATA = new Set(["row", "cell", "gridcell", "rowheader", "option", "treeitem"]);
/**
 * Roles whose name is the app's own wording: what to press, where to type, what a section or column is.
 * Every other name, and all other text, may show the database's values.
 */
const WORDING = new Set([
  "heading",
  "button",
  "link",
  "textbox",
  "searchbox",
  "spinbutton",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "radiogroup",
  "switch",
  "slider",
  "tab",
  "tablist",
  "tabpanel",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "region",
  "form",
  "search",
  "group",
  "dialog",
  "alertdialog",
  "banner",
  "main",
  "contentinfo",
  "complementary",
  "toolbar",
  "columnheader",
  "table",
  "grid",
  "treegrid",
  "tree",
  "list",
  "img",
  "figure",
  "progressbar",
  "meter",
  "separator",
]);
/** Inside rows of data, only these keep their names (a button's caption is the app's wording). */
const WORDING_IN_DATA = new Set(["button", "columnheader"]);
/** Long runs of these are folded: the first few are shown. */
const FOLD: Record<string, number> = { row: 3, listitem: 8, option: 8, treeitem: 8, article: 3, gridcell: 50, cell: 50 };

export interface ShapeOptions {
  /** Keep all of the page's text (it may show the database's values). Default: only the app's wording. */
  text?: boolean;
}

/**
 * The tree as `ashiato pack` gives it to a chat: long lists folded, names of rows and of cells
 * holding controls left out (they repeat what is in them), and, unless `text`, everything that may
 * show the database's values replaced with `…`: text, cells, options, what fields hold, links and
 * fields inside rows. Kept: the names of buttons, links, fields, headings, tabs, menus, dialogs and
 * column headers, and placeholders.
 */
export function shapeAria(nodes: AriaNode[], options: ShapeOptions = {}): AriaNode[] {
  const visit = (list: AriaNode[], inData: boolean): AriaNode[] => {
    const out: AriaNode[] = [];
    let run = 0;
    list.forEach((n, i) => {
      run = i > 0 && list[i - 1]!.role === n.role ? run + 1 : 1;
      const keep = FOLD[n.role];
      if (keep === undefined || run <= keep) return void out.push(shapeNode(n, inData));
      // one line for the rest of the run
      if (run === keep + 1) out.push({ role: "text", value: `(+${runLength(list, i)} ${plural(n.role)})`, attrs: [], props: [], children: [] });
    });
    return out;
  };
  const shapeNode = (n: AriaNode, inData: boolean): AriaNode => {
    const data = inData || DATA.has(n.role);
    const children = visit(n.children, data);
    const out: AriaNode = { role: n.role, attrs: n.attrs, props: [], children };
    // a row's name is its cells' text, a cell's name what it holds: said again by the children
    const repeated = n.role === "row" || ((n.role === "cell" || n.role === "gridcell") && n.children.length > 0);
    if (n.name !== undefined && n.name !== "" && !repeated) out.name = options.text || keepName(n.role, data) ? n.name : HIDDEN;
    if (n.value !== undefined) out.value = options.text ? n.value : HIDDEN;
    for (const [k, v] of n.props) {
      if (k === "placeholder") out.props.push([k, v]);
      // a link's address can hold an id (/orders/1042) or a query
      else if (k === "url" && (options.text || !data)) out.props.push([k, options.text ? v : v.replace(/[?#].*$/s, "")]);
    }
    return out;
  };
  return mergeHidden(visit(nodes, false));
}

const keepName = (role: string, inData: boolean) => (inData ? WORDING_IN_DATA.has(role) : WORDING.has(role));

function runLength(list: AriaNode[], from: number): number {
  let n = 0;
  for (let i = from; i < list.length && list[i]!.role === list[from]!.role; i++) n++;
  return n;
}

const plural = (role: string) => ({ row: "rows", listitem: "list items", option: "options", treeitem: "items", article: "articles", cell: "cells", gridcell: "cells" })[role] ?? role;

/** Hidden text nodes side by side say nothing more than one. */
function mergeHidden(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  for (const n of nodes) {
    n.children = mergeHidden(n.children);
    const last = out.at(-1);
    if (n.role === "text" && n.value === HIDDEN && last?.role === "text" && last.value === HIDDEN) continue;
    out.push(n);
  }
  return out;
}

/** Every node with a role and a name, depth first. */
export function namedNodes(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  const walk = (list: AriaNode[]) => {
    for (const n of list) {
      if (n.name) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Text on the page, from text nodes and inline values, depth first. */
export function texts(nodes: AriaNode[]): string[] {
  const out: string[] = [];
  const walk = (list: AriaNode[]) => {
    for (const n of list) {
      if (n.value !== undefined && n.value !== HIDDEN) out.push(n.value);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
