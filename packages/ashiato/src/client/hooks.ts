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
    // any message with an id and no method answers that id; hosts may omit `result` for void methods
    const m = parse(message);
    if (!m || typeof m.method === "string" || !isId(m.id)) return null;
    return m.id;
  },
};

/** The URL of anything fetch() accepts: a string, URL, Request, or any object with toString (e.g. `location`). */
function urlOf(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") return (input as { url: string }).url;
  if (input && typeof input === "object" && typeof (input as { href?: unknown }).href === "string") return (input as { href: string }).href;
  return String(input);
}

/** Wraps `fetch` so each call is attached to the current action and waits for the sync checkpoint. */
export function hookFetch(win: Window & typeof globalThis, tracker: Tracker, ignore: (url: string) => boolean): void {
  const original = win.fetch.bind(win);
  /** Calls fetch now and ends the handle when it settles; the app gets the same response or error. */
  const track = (h: RequestHandle, call: () => Promise<Response>): Promise<Response> => {
    let res: Promise<Response>;
    try {
      res = call();
    } catch (e) {
      h.end({ error: String(e) });
      throw e;
    }
    return res.then(
      (r) => (h.end({ status: r.status }), r),
      (e: unknown) => {
        h.end({ error: String(e) });
        throw e;
      },
    );
  };
  /** The URL and method to record, or null when the call isn't tracked. */
  const describeCall = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = urlOf(input);
      if (ignore(url)) return null;
      return { url, method: String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() };
    } catch {
      return null; // arguments that can't be read (no toString): native fetch rejects, it doesn't throw
    }
  };
  win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const call = describeCall(input, init);
    if (!call) return original(input, init);
    const h = tracker.beginRequest({ kind: "http", ...call });
    // no sync pending: call fetch synchronously with the caller's own arguments, like the native call
    if (!h.waiting) return track(h, () => original(input, init));
    let request: Request;
    try {
      // fetch reads its arguments when called: copy them now, so an init object or body the app
      // reuses for its next call doesn't change this request while it waits
      request = new Request(input, init);
    } catch {
      // invalid arguments: the native call reports the error
      return track(h, () => original(input, init));
    }
    const signal = request.signal;
    return new Promise<Response>((resolve, reject) => {
      // aborting while waiting rejects at once, as it does natively
      const abort = () => {
        h.end({ error: String(signal.reason) });
        reject(signal.reason);
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      h.ready
        .then(() => {
          signal.removeEventListener("abort", abort);
          if (!signal.aborted) track(h, () => original(request)).then(resolve, reject);
        })
        .catch(reject);
    });
  };
}

/** A copy of an XHR body the app could still change: native send() reads it at once. */
function copyBody(body: Document | XMLHttpRequestBodyInit | null | undefined): Document | XMLHttpRequestBodyInit | null | undefined {
  try {
    if (body instanceof ArrayBuffer) return body.slice(0);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
    if (body instanceof URLSearchParams) return new URLSearchParams(body);
    if (body instanceof FormData) {
      const copy = new FormData();
      for (const [name, value] of body) copy.append(name, value);
      return copy;
    }
  } catch {
    // e.g. a detached buffer: leave it to send()
  }
  // strings and Blobs can't change; Documents are sent as they are
  return body;
}

const outcome = (xhr: XMLHttpRequest) => (xhr.status ? { status: xhr.status } : { error: "network error" });

/** Wraps XMLHttpRequest (axios and older code use it). */
export function hookXhr(win: Window & typeof globalThis, tracker: Tracker, ignore: (url: string) => boolean): void {
  const proto = win.XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const abort = proto.abort;
  type Waiting = { body: Document | XMLHttpRequestBodyInit | null | undefined; cancelled: boolean };
  type Tagged = XMLHttpRequest & { __ashiato?: { method: string; url: string }; __ashiatoWaiting?: Waiting; __ashiatoRequest?: RequestHandle };

  /** abort() or open() while send() waits for the sync: send now, so the native call behaves as the app expects. */
  const sendNow = (xhr: Tagged) => {
    const w = xhr.__ashiatoWaiting;
    if (!w) return;
    w.cancelled = true;
    xhr.__ashiatoWaiting = undefined;
    try {
      send.call(xhr, w.body);
    } catch {
      // the native abort / open that follows reports the state
    }
  };

  proto.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
    sendNow(this);
    // re-opening cancels a request still in flight without a loadend event (Chromium), so end it here;
    // one that is already done (open() in its readystatechange or load handler) keeps its status
    const previous = this.__ashiatoRequest;
    const result = previous && (this.readyState === 4 ? outcome(this) : { error: "aborted" });
    // synchronous XHR (async argument given and falsy) can't wait for the sync checkpoint: leave it untracked
    const sync = rest.length > 0 && !rest[0];
    this.__ashiato = sync ? undefined : { method: String(method).toUpperCase(), url: String(url) };
    (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    if (previous) {
      if (this.__ashiatoRequest === previous) this.__ashiatoRequest = undefined;
      previous.end(result);
    }
  } as typeof proto.open;

  proto.abort = function (this: Tagged) {
    sendNow(this);
    return abort.call(this);
  };

  proto.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = this.__ashiato;
    if (!meta || ignore(meta.url)) return send.call(this, body);
    const h: RequestHandle = tracker.beginRequest({ kind: "http", method: meta.method, url: meta.url });
    this.addEventListener(
      "loadend",
      () => {
        if (this.__ashiatoRequest === h) this.__ashiatoRequest = undefined;
        h.end(outcome(this));
      },
      { once: true },
    );
    if (!h.waiting) {
      // no sync pending: send synchronously, exactly like the native call (errors reach the caller)
      try {
        send.call(this, body);
      } catch (e) {
        h.end({ error: String(e) });
        throw e;
      }
      this.__ashiatoRequest = h;
      return;
    }
    this.__ashiatoRequest = h;
    // send() reads the body at once natively: copy one the app could change while this waits
    const w: Waiting = { body: copyBody(body), cancelled: false };
    this.__ashiatoWaiting = w;
    void h.ready.then(() => {
      if (w.cancelled) return;
      this.__ashiatoWaiting = undefined;
      try {
        send.call(this, w.body);
      } catch (e) {
        h.end({ error: String(e) });
      }
    });
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
  // keyed by String(id): hosts may echo 1 as "1"
  const pending = new Map<string, RequestHandle>();

  webview.addEventListener("message", (e) => {
    const id = codec.response(e.data);
    if (id === null) return;
    const h = pending.get(String(id));
    if (!h) return;
    pending.delete(String(id));
    const m = parse(e.data);
    h.end(m && "error" in m && m.error ? { error: typeof m.error === "string" ? m.error : JSON.stringify(m.error) } : {});
  });

  webview.postMessage = (message: unknown) => {
    const req = codec.request(message);
    if (!req) return original(message);
    let key: string | undefined;
    const h: RequestHandle = tracker.beginRequest({ kind: req.id === undefined ? "message" : "rpc", method: req.method }, () => {
      // ended by its reply, an error or the time cap
      if (key !== undefined && pending.get(key) === h) pending.delete(key);
    });
    let posted = message;
    if (h.waiting && typeof message !== "string") {
      try {
        // WebView2 serializes the message to JSON when it is posted: do that now, so later changes
        // to a reused object aren't sent, and a circular message throws to the caller as it would
        posted = JSON.parse(JSON.stringify(message));
      } catch (e) {
        h.end({ error: String(e) });
        throw e;
      }
    }
    const id = posted === message ? req.id : codec.request(posted)?.id;
    if (id !== undefined) {
      key = String(id);
      // the earlier call can no longer be paired with its reply: don't leave it waiting for the time cap
      pending.get(key)?.end({ error: "id reused before a reply" });
      pending.set(key, h);
    }
    const post = () => {
      try {
        original(posted);
      } catch (e) {
        h.end({ error: String(e) });
        throw e;
      }
      // a one-way message: give the host a moment to act on it, counted from when it was really sent
      if (id === undefined) setTimeout(() => h.end(), tracker.oneWayMs);
    };
    // without a pending sync, post synchronously so errors still reach the app's try/catch
    if (!h.waiting) return post();
    // the app's call has already returned: report the error instead of leaving an unhandled rejection
    h.ready.then(post).catch((e: unknown) => console.error("[ashiato] chrome.webview.postMessage failed:", e));
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
  // <input type=submit value="Save">; textContent rather than innerText: no layout, fast on big containers
  const value = el.tagName === "INPUT" && /^(submit|button|reset)$/i.test((el as HTMLInputElement).type) ? (el as HTMLInputElement).value : "";
  const name = el.getAttribute("aria-label") ?? (value || (el.textContent ?? "").slice(0, 200).trim());
  const fallback =
    (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
    el.getAttribute("name") ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.id;
  const text = (["input", "select", "textarea"].includes(tag) && !value ? fallback : name || fallback) ?? "";
  const short = text.replace(/\s+/g, " ").slice(0, 40);
  return short ? `${tag} "${short}"` : tag;
}
