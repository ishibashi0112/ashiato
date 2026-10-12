import { Window } from "happy-dom";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CHANGE_EVENT, DIALOG_EVENT, KEY_EVENT } from "../src/client/events.js";
import { Dom } from "../src/codegen/dom.js";
import { interactionsOf, type Interaction, type ReplayEvent } from "../src/codegen/interactions.js";
import { locatorFor } from "../src/codegen/locator.js";
import { playwrightTest } from "../src/codegen/playwright.js";
import type { Session, Step, TableDiff } from "../src/core/types.js";

/** A page as rrweb serializes it in a full snapshot, with the id of each element. */
function snapshot(html: string, firstId = 1) {
  const doc = new new Window().DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  let next = firstId;
  const ids = new Map<unknown, number>();
  const serialize = (n: Node): unknown => {
    const id = next++;
    ids.set(n, id);
    const childNodes = () => [...n.childNodes].filter((c) => c.nodeType !== 8 && c.nodeType !== 10).map(serialize);
    if (n.nodeType === 9) return { type: 0, id, childNodes: childNodes() };
    if (n.nodeType === 3) return { type: 3, id, textContent: n.textContent };
    const el = n as Element;
    return { type: 2, id, tagName: el.tagName.toLowerCase(), attributes: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])), childNodes: childNodes() };
  };
  const node = serialize(doc as unknown as Node);
  return { node, id: (selector: string) => ids.get(doc.querySelector(selector))!, next: () => next };
}

function domOf(html: string) {
  const page = snapshot(html);
  const dom = new Dom();
  dom.reset(page.node as never);
  return { dom, locate: (selector: string) => locatorFor(dom, dom.get(page.id(selector))!) };
}

const code = (l: ReturnType<typeof locatorFor>) => ("code" in l ? l.code : l);

describe("locators", () => {
  const { dom, locate } = domOf(`
    <button data-testid="save-order" id="save">保存</button>
    <button id="cancel"><span class="icon">×</span> <span>キャンセル</span></button>
    <button>編集</button><button>編集</button>
    <button style="display: none">削除</button><button>削除</button>
    <label for="qty">数量</label><input id="qty">
    <label>メール <input type="email"></label>
    <label for="both">外側</label><label>内側 <input id="both"></label>
    <span id="l1">開始</span><span id="l2">日</span><input aria-labelledby="l1 l2">
    <select aria-label="顧客"><option>A</option></select>
    <input placeholder="検索">
    <div class="row" onclick="open()">山田商事</div>
    <input data-code="P'1"> <input data-code="P2">
    <a href="/help" title="ヘルプ"><img alt="?"></a>
    <input type="checkbox" id="agree"><label for="agree">同意する</label>
    <iframe></iframe>
  `);

  it("prefers test ids, then roles with their names", () => {
    expect(code(locate("#save"))).toBe('getByTestId("save-order")');
    // a click on the text inside the button is a click on the button
    expect(code(locate("#cancel span:last-child"))).toBe('getByRole("button", { name: "× キャンセル", exact: true })');
    expect(code(locate("#agree"))).toBe('getByRole("checkbox", { name: "同意する", exact: true })');
    expect(code(locate("a"))).toBe('getByRole("link", { name: "?", exact: true })');
  });

  it("counts only visible elements for roles", () => {
    expect(code(locate("button:nth-of-type(6)"))).toBe('getByRole("button", { name: "削除", exact: true })');
  });

  it("finds same-looking elements by position", () => {
    expect(code(locate("button:nth-of-type(4)"))).toBe('getByRole("button", { name: "編集", exact: true }).nth(1)');
  });

  it("finds fields by each of their labels, as Playwright does", () => {
    expect(code(locate("#qty"))).toBe('getByLabel("数量", { exact: true })');
    expect(code(locate("input[type=email]"))).toBe('getByLabel("メール", { exact: true })');
    // labelled twice: either label finds it
    expect(code(locate("#both"))).toBe('getByLabel("外側", { exact: true })');
    // aria-labelledby: each element is a label of its own for getByLabel
    expect(code(locate("[aria-labelledby]"))).toBe('getByLabel("開始", { exact: true })');
    expect(code(locate("select"))).toBe('getByLabel("顧客", { exact: true })');
    expect(code(locate("[placeholder]"))).toBe('getByPlaceholder("検索", { exact: true })');
  });

  it("finds other elements by their text, or by an attribute", () => {
    expect(code(locate("div.row"))).toBe('getByText("山田商事", { exact: true })');
    expect(code(locate("[data-code=\"P'1\"]"))).toBe(`locator("input[data-code='P\\\\'1']")`);
    expect(code(locate("[data-code=P2]"))).toBe(`locator("input[data-code='P2']")`);
  });

  it("names elements for comments", () => {
    expect((locate("#qty") as { label: string }).label).toBe('textbox "数量"');
    expect((locate("div.row") as { label: string }).label).toBe('div "山田商事"');
  });

  it("can't find elements in frames", () => {
    const page = snapshot(`<iframe></iframe>`);
    const dom = new Dom();
    dom.reset(page.node as never);
    // rrweb puts a frame's document under its <iframe>
    const frame = snapshot(`<button>中</button>`, page.next());
    dom.mutate({ adds: [{ parentId: page.id("iframe"), nextId: null, node: frame.node as never }] });
    expect(locatorFor(dom, dom.get(frame.id("button"))!)).toEqual({ unsupported: "it is in a frame" });
    expect(dom.elements().next().value).toBeDefined();
  });
});

describe("the page mirror", () => {
  it("follows mutations, in any order", () => {
    const page = snapshot(`<ul id="list"><li id="a">a</li></ul><p id="p">x</p>`);
    const dom = new Dom();
    dom.reset(page.node as never);
    const list = page.id("#list");
    const [b, c, text] = [100, 101, 102];
    dom.mutate({
      // c goes before b, which comes later in the same batch
      adds: [
        { parentId: list, nextId: b, node: { type: 2, id: c, tagName: "li", attributes: {}, childNodes: [] } as never },
        { parentId: list, nextId: null, node: { type: 2, id: b, tagName: "LI", attributes: { class: "new" }, childNodes: [{ type: 3, id: text, textContent: "b" }] } as never },
      ],
      removes: [{ parentId: list, id: page.id("#a") }],
      texts: [{ id: text, value: "B" }],
      attributes: [{ id: page.id("#p"), attributes: { class: "done", style: { color: "red" } } }],
    });
    const items = dom.get(list)!.children.map((n) => n.id);
    expect(items).toEqual([c, b]);
    expect(dom.get(page.id("#a"))).toBeUndefined();
    expect(dom.get(b)!.tag).toBe("li");
    expect(dom.get(text)!.text).toBe("B");
    expect(dom.get(page.id("#p"))!.attrs.get("class")).toBe("done");
    // moving a node takes it out of its old place
    dom.mutate({ adds: [{ parentId: page.id("body"), nextId: null, node: { type: 2, id: b, tagName: "li", attributes: {}, childNodes: [] } as never }] });
    expect(dom.get(list)!.children.map((n) => n.id)).toEqual([c]);
  });
});

const T0 = Date.parse("2026-10-12T01:00:00Z");

/** rrweb events for a page, and helpers to add what the user did. */
function recording(html: string, href = "http://127.0.0.1:5173/orders") {
  const page = snapshot(html);
  const events: ReplayEvent[] = [
    { type: 4, timestamp: T0, data: { href } },
    { type: 2, timestamp: T0, data: { node: page.node } },
  ];
  const at = (ms: number) => T0 + ms;
  const r = {
    id: page.id,
    events,
    click: (ms: number, selector: string, type = 2) => (events.push({ type: 3, timestamp: at(ms), data: { source: 2, type, id: page.id(selector) } }), r),
    input: (ms: number, selector: string, text: string, extra: Record<string, unknown> = {}) => (
      events.push({ type: 3, timestamp: at(ms), data: { source: 5, text, isChecked: false, userTriggered: true, id: page.id(selector), ...extra } }),
      r
    ),
    custom: (ms: number, tag: string, payload: Record<string, unknown>) => (events.push({ type: 5, timestamp: at(ms), data: { tag, payload } }), r),
    load: (ms: number, url: string, html2: string) => {
      events.push({ type: 4, timestamp: at(ms), data: { href: url } }, { type: 2, timestamp: at(ms), data: { node: snapshot(html2).node } });
      return r;
    },
    interactions: () => interactionsOf(new Map([["tab1", events]])),
  };
  return r;
}

const brief = (list: Interaction[]) => list.map((i) => [i.kind, i.locator?.code ?? i.unsupported, i.value, ...(i.followed ? ["followed"] : []), ...(i.dialogs ? [i.dialogs] : [])].filter((x) => x !== undefined));

describe("what the user did", () => {
  const form = `
    <input id="name" placeholder="名前"> <input id="pw" type="password" placeholder="パスワード">
    <select id="customer"><option value="1">A</option><option value="2">B</option></select>
    <input type="checkbox" id="vip"><label for="vip">VIP</label>
    <input type="radio" name="ship" id="air"><label for="air">航空便</label>
    <button id="save">保存</button>`;

  it("turns typing into fills, and leaves out the clicks that come with them", () => {
    const r = recording(form)
      .click(100, "#name")
      .input(200, "#name", "山")
      .input(300, "#name", "山田")
      .click(400, "#pw")
      .input(500, "#pw", "********")
      .click(600, "#vip")
      .input(600, "#vip", "on", { isChecked: true })
      .input(700, "#air", "on", { isChecked: true })
      .click(800, "#save");
    expect(brief(r.interactions())).toEqual([
      ["goto", "http://127.0.0.1:5173/orders"],
      ["fill", 'getByPlaceholder("名前", { exact: true })', "山田"],
      ["fill", 'getByPlaceholder("パスワード", { exact: true })', ""],
      ["check", 'getByRole("checkbox", { name: "VIP", exact: true })'],
      ["check", 'getByRole("radio", { name: "航空便", exact: true })'],
      ["click", 'getByRole("button", { name: "保存", exact: true })'],
    ]);
    expect(r.interactions()[2]!.masked).toBe(true);
  });

  it("keeps an option picked by a test tool, whichever comes first: its change event or the value", () => {
    // Playwright's selectOption sends untrusted events: rrweb marks the value as not typed by the user
    const changeFirst = recording(form).custom(100, CHANGE_EVENT, { id: 0 });
    changeFirst.events.at(-1)!.data = { tag: CHANGE_EVENT, payload: { id: changeFirst.id("#customer") } };
    changeFirst.input(100, "#customer", "2", { userTriggered: false });
    const valueFirst = recording(form).input(100, "#customer", "2", { userTriggered: false });
    valueFirst.custom(101, CHANGE_EVENT, { id: valueFirst.id("#customer") });
    for (const r of [changeFirst, valueFirst]) expect(brief(r.interactions()).slice(1)).toEqual([["select", 'locator("#customer")', "2"]]);
  });

  it("leaves out values the page set by itself", () => {
    const r = recording(form).input(100, "#name", "初期値", { userTriggered: false }).input(2000, "#customer", "2", { userTriggered: false });
    r.custom(2500, CHANGE_EVENT, { id: r.id("#name") });
    expect(brief(r.interactions()).slice(1)).toEqual([]);
  });

  it("puts the value in before the Enter that submits it, and answers dialogs with the action that opened them", () => {
    const r = recording(form).input(100, "#name", "山");
    // typed on: the change comes after the key
    r.custom(200, KEY_EVENT, { key: "Enter", id: r.id("#name"), value: "山田" }).input(210, "#name", "山田");
    // Enter again, nothing typed
    r.custom(300, KEY_EVENT, { key: "Enter", id: r.id("#name"), value: "山田" });
    r.click(1000, "#save").custom(1100, DIALOG_EVENT, { type: "confirm", message: "保存しますか？", answer: true });
    expect(brief(r.interactions()).slice(1)).toEqual([
      ["fill", 'getByPlaceholder("名前", { exact: true })', "山田"],
      ["press", 'getByPlaceholder("名前", { exact: true })', "Enter"],
      ["press", 'getByPlaceholder("名前", { exact: true })', "Enter"],
      ["click", 'getByRole("button", { name: "保存", exact: true })', [{ type: "confirm", message: "保存しますか？", answer: true }]],
    ]);
  });

  it("makes one double click of click, click, dblclick", () => {
    const r = recording(form).click(100, "#save").click(150, "#save").click(150, "#save", 4);
    expect(brief(r.interactions()).slice(1)).toEqual([["dblclick", 'getByRole("button", { name: "保存", exact: true })']]);
  });

  it("tells page loads the user asked for from those that followed an action", () => {
    const r = recording(form).click(100, "#save").load(600, "http://127.0.0.1:5173/done", "<p>ok</p>").load(20_000, "http://127.0.0.1:5173/orders", form);
    expect(brief(r.interactions()).slice(1)).toEqual([
      ["click", 'getByRole("button", { name: "保存", exact: true })'],
      ["goto", "http://127.0.0.1:5173/done", "followed"],
      ["goto", "http://127.0.0.1:5173/orders"],
    ]);
  });

  it("finds elements added after the page loaded", () => {
    const r = recording(`<div id="app"></div>`);
    r.events.push({
      type: 3,
      timestamp: T0 + 50,
      data: { source: 0, adds: [{ parentId: r.id("#app"), nextId: null, node: { type: 2, id: 500, tagName: "button", attributes: {}, childNodes: [{ type: 3, id: 501, textContent: "追加" }] } }] },
    });
    r.events.push({ type: 3, timestamp: T0 + 100, data: { source: 2, type: 2, id: 501 } });
    expect(brief(r.interactions()).slice(1)).toEqual([["click", 'getByRole("button", { name: "追加", exact: true })']]);
  });
});

const iso = (ms: number) => new Date(T0 + ms).toISOString();
const orders = { schema: "main", name: "orders" };
const items = { schema: "main", name: "order_items" };
const stock = { schema: "main", name: "stock" };
const diffOf = (...tables: Partial<TableDiff>[]) => ({
  from: iso(0),
  to: iso(0),
  tables: tables.map((t) => ({ key: ["id"], inserted: [], deleted: [], updated: [], ...t }) as TableDiff),
});
const step = (id: number, ms: number, s: Partial<Step>): Step => ({ id, label: `step ${id}`, at: iso(ms + 500), diff: diffOf(), durationMs: 5, ...s });
const sessionOf = (steps: Step[], options: Session["options"] = {}): Session => ({
  version: 1,
  id: "s",
  startedAt: iso(0),
  dialect: "sqlite",
  tables: [orders, items, stock],
  options,
  steps,
});

describe("generated Playwright tests", () => {
  const form = `<input id="note" placeholder="備考"><button id="save">保存</button><button id="del">削除</button>`;
  const r = recording(form).input(100, "#note", "至急").click(1000, "#save").click(3000, "#del").custom(3100, DIALOG_EVENT, { type: "prompt", message: "理由", answer: "重複" });
  const click = (ms: number, target: string, requests = [{ kind: "http" as const, method: "POST", url: "/api/orders" }]) => ({ type: "click", target, tab: "tab1", startedAt: iso(ms), requests });
  const session = sessionOf(
    [
      step(1, 1000, {
        label: 'click button "保存"',
        source: "POST /api/orders",
        action: click(1000, 'button "保存"'),
        diff: diffOf(
          { table: orders, inserted: [{ id: 7, customer_id: 1, note: "至急", created_at: iso(1000), updated_at: iso(1000), public_id: "3f2b8c1e-8d1c-4f7a-9a51-2b7c1d9e0f11" }] },
          { table: items, key: ["order_id", "line"], inserted: [{ order_id: 7, line: 1, qty: 2 }] },
          { table: stock, key: ["item"], updated: [{ key: { item: 3 }, before: { item: 3, qty: 10, updated_at: "x" }, after: { item: 3, qty: 8, updated_at: "y" }, changed: ["qty", "updated_at"] }] },
        ),
      }),
      step(2, 2000, { label: "outside actions", source: "sync", diff: diffOf({ table: stock, key: ["item"], inserted: [{ item: 9, qty: 1 }] }) }),
      step(3, 3000, {
        label: 'click button "削除"',
        source: "orders.delete",
        action: click(3000, 'button "削除"', [{ kind: "rpc" as const, method: "orders.delete" } as never]),
        diff: diffOf({ table: orders, deleted: [{ id: 7, customer_id: 1, note: "至急" }] }, { table: items, key: ["order_id", "line"], deleted: [{ order_id: 7, line: 1, qty: 2 }] }),
      }),
      step(4, 5000, {
        label: "import",
        source: "manual",
        diff: diffOf({ table: stock, key: ["item"], inserted: Array.from({ length: 21 }, (_, i) => ({ item: 100 + i, qty: 0 })) }),
      }),
    ],
    { ignoreColumns: ["updated_at"] },
  );
  const generated = playwrightTest(session, { interactions: r.interactions(), sessionFile: "s.json", name: "orders" });

  it("does the recording again, checking each step's rows", () => {
    expect(generated).toContain(`test.use({
  baseURL: "http://127.0.0.1:5173",
  ashiato: { ignoreColumns: ["updated_at"] },
});`);
    expect(generated).toContain(`test("orders", async ({ page, expectDbChanges }) => {
  await page.goto("/orders");
  await page.getByPlaceholder("備考", { exact: true }).fill("至急");

  // #1 click button "保存" (POST /api/orders)
  await expectDbChanges(() => page.getByRole("button", { name: "保存", exact: true }).click(), {
    orders: {
      inserted: [
        { id: expect.any(Number), customer_id: 1, note: "至急", created_at: expect.any(String), public_id: expect.any(String) },
      ],
    },
    order_items: {
      inserted: [{ order_id: expect.any(Number), line: 1, qty: 2 }],
    },
    stock: {
      updated: [{ where: { item: 3 }, set: { qty: 8 } }],
    },
  });

  // #2 outside actions: changed while nothing was being done in the app, so not checked here

  // #3 click button "削除" (orders.delete)
  // sent to the desktop app (WebView2): run the test against the app hosting this page
  page.once("dialog", (dialog) => dialog.accept("重複")); // prompt: 理由
  await expectDbChanges(() => page.getByRole("button", { name: "削除", exact: true }).click(), {
    orders: {
      deleted: [{ id: expect.any(Number) }],
    },
    order_items: {
      deleted: [{ order_id: expect.any(Number), line: 1 }],
    },
  });

  // #4 import
  await expectDbChanges(async () => {
    // TODO: what was done before the checkpoint "import"
  }, {
    stock: {
      inserted: 21,
    },
  });
});
`);
  });

  it("is valid TypeScript", () => {
    const { diagnostics } = ts.transpileModule(generated, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    expect(diagnostics).toEqual([]);
  });

  it("leaves the actions as TODOs without a screen replay", () => {
    const code = playwrightTest(session, {});
    expect(code).toContain("No screen replay was recorded");
    expect(code).toContain("// TODO: click button \"保存\" (not found in the screen replay)");
    expect(code).not.toContain("test.use({\n  baseURL");
  });

  it("wraps the page load that sent requests by itself, and quotes names that aren't identifiers", () => {
    const page = recording(form);
    const s = sessionOf([
      step(1, 300, {
        label: "GET /api/init",
        source: "http",
        action: { type: "request", tab: "tab1", startedAt: iso(300), requests: [{ kind: "http", method: "GET", url: "/api/init" }] },
        diff: diffOf({ table: { schema: "main", name: "access log" }, key: [], inserted: [{ "user-id": "u1", at: "2020-01-01" }] }),
      }),
    ]);
    const code = playwrightTest(s, { interactions: page.interactions() });
    expect(code).toContain(`  // #1 GET /api/init
  await expectDbChanges(() => page.goto("/orders"), {
    "access log": {
      inserted: [{ "user-id": "u1", at: "2020-01-01" }],
    },
  });`);
  });
});
