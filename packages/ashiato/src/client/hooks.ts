import type { RequestHandle, Tracker } from "./tracker.js";

export interface RpcCodec {
  /** Returns the id and method of an outgoing request, or null when the message expects no reply. */
  request(message: unknown): { id?: string | number; method: string } | null;
  /** Returns the id of the request an incoming message answers, or null if it is not a reply. */
  response(message: unknown): string | number | null;
}

const parse = (m: unknown): Record<string, unknown> | null => {
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  return m && typeof m === "object" ? (m as Record<string, unknown>) : null;
};

const isId = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";

/** JSON-RPC style messages: `{ id, method, params }` → `{ id, result | error }`. Used by webview2-bridge. */
export const jsonRpc: RpcCodec = {
  request(message) {
    const m = parse(message);
    if (!m || typeof m.method !== "string") return null;
    return isId(m.id) ? { id: m.id, method: m.method } : { method: m.method };
  },
  response(message) {
    const m = parse(message);
    if (!m || typeof m.method === "string" || !isId(m.id) || !("result" in m || "error" in m)) return null;
    return m.id;
  },
};

/** Wraps `fetch` so each call is attached to the current action and waits for the sync checkpoint. */
export function hookFetch(win: Window & typeof globalThis, tracker: Tracker, ignore: (url: string) => boolean): void {
  const original = win.fetch.bind(win);
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (ignore(url)) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const h = tracker.beginRequest({ kind: "http", method, url });
    await h.ready;
    try {
      const res = await original(input, init);
      h.end({ status: res.status });
      return res;
    } catch (e) {
      h.end({ error: String(e) });
      throw e;
    }
  };
}

/** Wraps XMLHttpRequest (axios and older code use it). */
export function hookXhr(win: Window & typeof globalThis, tracker: Tracker, ignore: (url: string) => boolean): void {
  const proto = win.XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  type Tagged = XMLHttpRequest & { __ashiato?: { method: string; url: string } };
  proto.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
    // synchronous XHR can't wait for the sync checkpoint: leave it untracked
    this.__ashiato = rest[0] === false ? undefined : { method: method.toUpperCase(), url: String(url) };
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this.__ashiato;
    if (!meta || ignore(meta.url)) return send.call(this, body);
    const h: RequestHandle = tracker.beginRequest({ kind: "http", method: meta.method, url: meta.url });
    this.addEventListener("loadend", () => h.end(this.status ? { status: this.status } : { error: "network error" }));
    void h.ready.then(() => send.call(this, body));
  };
}

interface WebView {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
}

/** Wraps WebView2's `window.chrome.webview.postMessage` and pairs replies by id. */
export function hookWebView(win: Window & typeof globalThis, tracker: Tracker, codec: RpcCodec): boolean {
  const webview = (win as unknown as { chrome?: { webview?: WebView } }).chrome?.webview;
  if (!webview) return false;
  const original = webview.postMessage.bind(webview);
  const pending = new Map<string | number, RequestHandle>();

  webview.addEventListener("message", (e) => {
    const id = codec.response(e.data);
    if (id === null) return;
    const h = pending.get(id);
    if (!h) return;
    pending.delete(id);
    const m = parse(e.data);
    h.end(m && "error" in m && m.error ? { error: typeof m.error === "string" ? m.error : JSON.stringify(m.error) } : {});
  });

  webview.postMessage = (message: unknown) => {
    const req = codec.request(message);
    if (!req) return original(message);
    const h = tracker.beginRequest({ kind: req.id === undefined ? "message" : "rpc", method: req.method });
    if (req.id === undefined) setTimeout(() => h.end(), tracker.oneWayMs);
    else pending.set(req.id, h);
    void h.ready.then(() => original(message));
  };
  return true;
}

/** Records clicks, form submits, value changes and Enter presses as user actions. */
export function hookUserActions(doc: Document, tracker: Tracker): void {
  doc.addEventListener("click", (e) => tracker.userAction("click", describe(e.target)), true);
  doc.addEventListener("submit", (e) => tracker.userAction("submit", describe(e.target)), true);
  doc.addEventListener("change", (e) => tracker.userAction("change", describe(e.target)), true);
  doc.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.isComposing) tracker.userAction("enter", describe(e.target));
    },
    true,
  );
}

const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=option]";

/** A short human-readable name for the element, e.g. `button "Save"` or `input "quantity"`. */
export function describe(target: EventTarget | null): string | undefined {
  if (!target || !(target as Element).closest) return undefined;
  const el = (target as Element).closest(INTERACTIVE) ?? (target as Element);
  const tag = el.getAttribute("role") ?? el.tagName.toLowerCase();
  const name =
    el.getAttribute("aria-label") ??
    (el as HTMLElement).innerText?.trim() ??
    el.textContent?.trim() ??
    "";
  const fallback =
    (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
    el.getAttribute("name") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.id;
  const text = (["input", "select", "textarea"].includes(tag) ? fallback : name || fallback) ?? "";
  const short = text.replace(/\s+/g, " ").slice(0, 40);
  return short ? `${tag} "${short}"` : tag;
}
