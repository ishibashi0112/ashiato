// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { captioned, describe as describeEl, hookFetch, hookWebView, hookXhr, jsonRpc } from "../src/client/hooks.js";
import { Tracker, type CheckpointPayload } from "../src/client/tracker.js";

type Win = Window & typeof globalThis;
type FakeWebView = { postMessage(m: unknown): void };
const webviewOf = (win: Win) => (win as unknown as { chrome: { webview: FakeWebView } }).chrome.webview;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A recorder whose checkpoints take until release() (a big database): requests wait for the sync. */
const slowRecorder = () => {
  const sent: CheckpointPayload[] = [];
  const pending: (() => void)[] = [];
  const tracker = new Tracker({ send: (p) => (sent.push(p), new Promise<void>((r) => pending.push(r))), settleMs: 5 });
  // the tracker hands checkpoints to send() a microtask later: let it start them first
  const release = async () => {
    await tick();
    pending.splice(0).forEach((r) => r());
  };
  return { tracker, sent, release };
};
const checkpointOf = (sent: CheckpointPayload[], label: string) => sent.find((p) => p.label === label);

describe("jsonRpc codec", () => {
  it("recognizes requests, notifications and replies, as objects or JSON strings", () => {
    expect(jsonRpc.request({ jsonrpc: "2.0", id: 1, method: "orders.save", params: {} })).toEqual({ id: 1, method: "orders.save" });
    expect(jsonRpc.request('{"method":"log","params":[]}')).toEqual({ method: "log" });
    expect(jsonRpc.request({ type: "other" })).toBeNull();
    expect(jsonRpc.response({ id: 1, result: null })).toBe(1);
    expect(jsonRpc.response('{"id":"a","error":{"message":"x"}}')).toBe("a");
    expect(jsonRpc.response({ id: 2, method: "server.push" })).toBeNull();
    // a void method's reply may carry only the id
    expect(jsonRpc.response({ jsonrpc: "2.0", id: 99 })).toBe(99);
  });
});

describe("describe()", () => {
  it("names the clicked control", () => {
    document.body.innerHTML = `
      <button id="b"><span id="s">保存</span></button>
      <input id="q" name="quantity" />
      <button id="x" aria-label="Close">×</button>`;
    expect(describeEl(document.getElementById("s"))).toBe('button "保存"');
    expect(describeEl(document.getElementById("q"))).toBe('input "quantity"');
    expect(describeEl(document.getElementById("x"))).toBe('button "Close"');
    document.body.innerHTML = `<input id="i" type="submit" name="ctl00$Main$btnSave" value="登録" />`;
    expect(describeEl(document.getElementById("i"))).toBe('input "登録"');
  });

  it("marks only buttons' captions and fields' labels as the app's own wording", () => {
    document.body.innerHTML = `
      <button id="b"><span id="s">保存</span></button>
      <input id="i" type="submit" value="登録" /><input id="t" name="qty" /><select id="sel" name="kind"></select><textarea id="ta" name="memo"></textarea>
      <a id="a" href="/c/1">Yamada Taro</a><table><tr role="button"><td id="td">Suzuki Hanako</td></tr></table>
      <div role="button"><span id="r">Sato Ichiro</span></div><button role="tab" id="tab">Tanaka Trading</button>
      <label><input id="c" type="checkbox" />Suzuki Trading</label><details><summary id="sum">Order 1234</summary></details>`;
    const marked = (id: string) => captioned(document.getElementById(id));
    for (const id of ["s", "i", "t", "sel", "ta"]) expect(marked(id), id).toBe(true);
    for (const id of ["a", "td", "r", "tab", "c", "sum"]) expect(marked(id), id).toBe(false);
  });
});

describe("hooks", () => {
  it("pairs WebView2 postMessage requests with their replies", async () => {
    const sent: CheckpointPayload[] = [];
    const tracker = new Tracker({ send: async (p) => void sent.push(p), settleMs: 10 });
    let listener: ((e: { data: unknown }) => void) | undefined;
    const posted: unknown[] = [];
    const win = window as unknown as Window & typeof globalThis & { chrome: unknown };
    win.chrome = {
      webview: {
        postMessage: (m: unknown) => posted.push(m),
        addEventListener: (_: string, l: (e: { data: unknown }) => void) => (listener = l),
      },
    };
    expect(hookWebView(win, tracker, jsonRpc)).toBe(true);
    const webview = (win.chrome as { webview: { postMessage(m: unknown): void } }).webview;

    tracker.userAction("click", 'button "保存"');
    webview.postMessage({ jsonrpc: "2.0", id: 7, method: "orders.save", params: { qty: 10 } });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(sent).toHaveLength(1); // the sync checkpoint went first

    listener!({ data: { jsonrpc: "2.0", id: 7, result: { ok: true } } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ label: 'click button "保存"', source: "orders.save" });
    expect(sent[1]!.action?.requests[0]).toMatchObject({ kind: "rpc", method: "orders.save" });
  });

  it("wraps fetch but leaves ignored URLs alone", async () => {
    const calls: string[] = [];
    // a request that waited for the sync is sent as a Request copied at call time
    const win = {
      fetch: async (u: string | Request) => (calls.push(u instanceof Request ? new URL(u.url).pathname : u), new Response("ok", { status: 201 })),
    } as unknown as Window & typeof globalThis;
    const sent: CheckpointPayload[] = [];
    const tracker = new Tracker({ send: async (p) => void sent.push(p), settleMs: 5 });
    hookFetch(win, tracker, (u) => u.startsWith("http://127.0.0.1:4100"));

    await win.fetch("http://127.0.0.1:4100/api/checkpoint");
    expect(sent).toEqual([]);

    const res = await win.fetch("/api/orders", { method: "post" });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.action?.requests[0]).toMatchObject({ method: "POST", url: "/api/orders", status: 201 });
    expect(calls).toEqual(["http://127.0.0.1:4100/api/checkpoint", "/api/orders"]);
  });

  it("accepts anything fetch() accepts as its input", async () => {
    const calls: unknown[] = [];
    const win = { fetch: async (u: unknown) => (calls.push(u), new Response("ok")) } as unknown as Window & typeof globalThis;
    hookFetch(win, new Tracker({ send: async () => undefined, syncBefore: false }), () => false);
    const like = { href: "http://localhost/page", toString: () => "http://localhost/page" };
    await expect(win.fetch(like as unknown as URL)).resolves.toBeInstanceOf(Response);
    await expect(win.fetch({ toString: () => "/x" } as unknown as URL)).resolves.toBeInstanceOf(Response);
    // arguments it can't even read are the native fetch's to reject
    await expect(win.fetch(Object.create(null) as URL)).resolves.toBeInstanceOf(Response);
    expect(calls).toHaveLength(3);
  });

  it("pairs replies whose id comes back as a string, and posts synchronously when no sync is pending", async () => {
    const sent: CheckpointPayload[] = [];
    const tracker = new Tracker({ send: async (p) => void sent.push(p), settleMs: 10, syncBefore: false });
    let listener: ((e: { data: unknown }) => void) | undefined;
    const win = window as unknown as Window & typeof globalThis & { chrome: unknown };
    win.chrome = {
      webview: {
        postMessage: (m: { fail?: boolean }) => {
          if (m.fail) throw new Error("circular");
        },
        addEventListener: (_: string, l: (e: { data: unknown }) => void) => (listener = l),
      },
    };
    hookWebView(win, tracker, jsonRpc);
    const webview = (win.chrome as { webview: { postMessage(m: unknown): void } }).webview;
    // errors still reach the app's try/catch
    expect(() => webview.postMessage({ id: 1, method: "bad", fail: true })).toThrow("circular");

    tracker.userAction("click", 'button "Save"');
    webview.postMessage({ id: 2, method: "orders.save" });
    listener!({ data: { id: "2" } });
    await vi.waitFor(() => expect(sent.some((p) => p.label === 'click button "Save"')).toBe(true));
  });

  it("keeps XMLHttpRequest semantics: synchronous requests, and abort() while waiting for the sync", async () => {
    const calls: string[] = [];
    class FakeXhr {
      status = 0;
      private listeners: Record<string, (() => void)[]> = {};
      open(method: string, url: string, async?: boolean) {
        calls.push(`open ${method} ${url} ${String(async)}`);
      }
      send() {
        calls.push("send");
      }
      abort() {
        calls.push("abort");
        for (const l of this.listeners.loadend ?? []) l();
      }
      addEventListener(type: string, l: () => void) {
        (this.listeners[type] ??= []).push(l);
      }
    }
    const pending: (() => void)[] = [];
    const tracker = new Tracker({ send: () => new Promise<void>((r) => pending.push(r)) });
    const win = { XMLHttpRequest: FakeXhr } as unknown as Window & typeof globalThis;
    hookXhr(win, tracker, () => false);

    // async argument given but falsy (undefined, 0, ""): synchronous natively, so it must go out at once
    const sync = new win.XMLHttpRequest();
    sync.open("GET", "/s", undefined as unknown as boolean);
    sync.send();
    expect(calls).toEqual(["open GET /s undefined", "send"]);

    calls.length = 0;
    const x = new win.XMLHttpRequest();
    x.open("POST", "/a");
    x.send("body");
    expect(calls).toEqual(["open POST /a undefined"]); // waiting for the sync checkpoint
    x.abort();
    expect(calls).toEqual(["open POST /a undefined", "send", "abort"]);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c === "send")).toHaveLength(1); // not sent again after the sync
  });

  it("calls fetch synchronously with the caller's own arguments when no sync is pending", async () => {
    const calls: unknown[][] = [];
    const win = { fetch: (...args: unknown[]) => (calls.push(args), Promise.resolve(new Response("ok"))) } as unknown as Win;
    hookFetch(win, new Tracker({ send: async () => undefined, syncBefore: false }), () => false);
    const init: RequestInit = { method: "POST", body: "1", keepalive: true };
    const res = win.fetch("/api/items", init);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("/api/items");
    expect(calls[0]![1]).toBe(init);
    await expect(res).resolves.toBeInstanceOf(Response);
  });

  it("sends a fetch that waits for the sync with the arguments it was called with", async () => {
    const bodies: Promise<string>[] = [];
    const win = {
      fetch: async (input: Request | string, init?: RequestInit) => (
        bodies.push(input instanceof Request ? input.text() : Promise.resolve(String(init?.body))), new Response("ok")
      ),
    } as unknown as Win;
    const { tracker, release } = slowRecorder();
    hookFetch(win, tracker, () => false);

    tracker.userAction("click", 'button "Save all"');
    // one init object reused for every call, as a loop over items might
    const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" } };
    const done = [1, 2, 3].map((id) => {
      init.body = JSON.stringify({ id });
      return win.fetch("/api/items", init);
    });
    await tick();
    expect(bodies).toEqual([]); // still waiting for the sync
    await release();
    await Promise.all(done);
    expect(await Promise.all(bodies)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
  });

  it("lets fetch report invalid arguments at once while a sync is pending", async () => {
    const calls: unknown[][] = [];
    const win = {
      fetch: (...args: unknown[]) => (calls.push(args), Promise.reject(new TypeError("Request with GET/HEAD method cannot have body."))),
    } as unknown as Win;
    const { tracker } = slowRecorder();
    hookFetch(win, tracker, () => false);
    tracker.userAction("click", 'button "Search"');
    const init = { body: "x" };
    await expect(win.fetch("/api/search", init)).rejects.toThrow("cannot have body");
    expect(calls).toEqual([["/api/search", init]]);
  });

  it("rejects a fetch aborted while it waits for the sync at once, without sending it", async () => {
    const calls: unknown[] = [];
    const win = { fetch: (input: unknown) => (calls.push(input), Promise.resolve(new Response("ok"))) } as unknown as Win;
    const { tracker, sent, release } = slowRecorder();
    hookFetch(win, tracker, () => false);
    tracker.userAction("click", 'button "Search"');
    const reason = new DOMException("stopped", "AbortError");
    const ac = new AbortController();
    const res = win.fetch("/api/search?q=a", { signal: ac.signal });
    ac.abort(reason);
    await expect(res).rejects.toBe(reason);
    await expect(win.fetch("/api/search?q=ab", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);

    await release();
    await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Search"')).toBeDefined());
    expect(calls).toEqual([]);
    expect(checkpointOf(sent, 'click button "Search"')!.action?.requests.map((r) => r.error)).toEqual([String(reason), String(reason)]);
  });

  it("copies an XHR body the app could still change while send() waits for the sync", async () => {
    const bodies: unknown[] = [];
    class FakeXhr {
      status = 0;
      open() {}
      send(body: unknown) {
        bodies.push(body);
      }
      addEventListener() {}
    }
    const win = { XMLHttpRequest: FakeXhr } as unknown as Win;
    const { tracker, release } = slowRecorder();
    hookXhr(win, tracker, () => false);
    tracker.userAction("click", 'button "Upload"');

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const buffer = new Uint8Array([5, 6]).buffer;
    const form = new FormData();
    form.append("qty", "1");
    form.append("file", new File(["x"], "a.txt"));
    const params = new URLSearchParams({ qty: "1" });
    const text = "qty=1";
    const blob = new Blob(["qty=1"]);
    for (const body of [bytes.subarray(1, 3), new DataView(bytes.buffer, 2, 2), buffer, form, params, text, blob]) {
      const x = new win.XMLHttpRequest();
      x.open("POST", "/upload");
      x.send(body);
    }
    // the app reuses its buffers and form for the next upload
    bytes.fill(0);
    new Uint8Array(buffer).fill(0);
    form.set("qty", "2");
    params.set("qty", "2");
    expect(bodies).toEqual([]);
    await release();
    await tick();

    expect([...(bodies[0] as Uint8Array)]).toEqual([2, 3]);
    expect([...(bodies[1] as Uint8Array)]).toEqual([3, 4]);
    expect([...new Uint8Array(bodies[2] as ArrayBuffer)]).toEqual([5, 6]);
    expect((bodies[3] as FormData).get("qty")).toBe("1");
    expect(((bodies[3] as FormData).get("file") as File).name).toBe("a.txt");
    expect(String(bodies[4])).toBe("qty=1");
    expect(bodies[5]).toBe(text);
    expect(bodies[6]).toBe(blob);

    // once the sync is done, send() gets the app's own body
    const x = new win.XMLHttpRequest();
    x.open("POST", "/upload");
    x.send(bytes);
    expect(bodies[7]).toBe(bytes);
  });

  it("ends an XHR request cancelled by open() on the same object, which fires no loadend in Chromium", async () => {
    class FakeXhr {
      status = 0;
      readyState = 0;
      listeners: Record<string, (() => void)[]> = {};
      open() {
        this.readyState = 1;
      }
      send() {}
      addEventListener(type: string, l: () => void) {
        (this.listeners[type] ??= []).push(l);
      }
      /** The response arrives: readystatechange (DONE) comes before load and loadend. */
      finish(status: number, onDone: () => void) {
        this.readyState = 4;
        this.status = status;
        onDone();
        for (const l of this.listeners.loadend ?? []) l();
      }
    }
    const sent: CheckpointPayload[] = [];
    const tracker = new Tracker({ send: async (p) => void sent.push(p), settleMs: 5, syncBefore: false });
    const win = { XMLHttpRequest: FakeXhr } as unknown as Win;
    hookXhr(win, tracker, () => false);

    tracker.userAction("click", 'button "Search"');
    const x = new win.XMLHttpRequest() as unknown as FakeXhr & XMLHttpRequest;
    x.open("GET", "/search?q=a");
    x.send();
    x.open("GET", "/search?q=ab"); // cancelled by re-opening; the app then decides not to send
    await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Search"')).toBeDefined());
    expect(checkpointOf(sent, 'click button "Search"')!.action?.requests).toMatchObject([{ url: "/search?q=a", error: "aborted" }]);

    // re-opened for the next request from the readystatechange handler of a finished one: keeps its status
    tracker.userAction("click", 'button "Next"');
    x.open("GET", "/page/1");
    x.send();
    x.finish(200, () => x.open("GET", "/page/2"));
    await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Next"')).toBeDefined());
    expect(checkpointOf(sent, 'click button "Next"')!.action?.requests).toMatchObject([{ url: "/page/1", status: 200 }]);
    expect(checkpointOf(sent, 'click button "Next"')!.action?.requests[0]?.error).toBeUndefined();
  });

  it("ends an XHR request re-opened while it waits for the sync", async () => {
    const calls: string[] = [];
    class FakeXhr {
      status = 0;
      readyState = 0;
      open(method: string, url: string) {
        calls.push(`open ${url}`);
      }
      send() {
        calls.push("send");
      }
      addEventListener() {}
    }
    const { tracker, sent, release } = slowRecorder();
    const win = { XMLHttpRequest: FakeXhr } as unknown as Win;
    hookXhr(win, tracker, () => false);
    tracker.userAction("click", 'button "Search"');
    const x = new win.XMLHttpRequest();
    x.open("GET", "/search?q=a");
    x.send();
    x.open("GET", "/search?q=ab");
    expect(calls).toEqual(["open /search?q=a", "send", "open /search?q=ab"]);
    await release();
    await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Search"')).toBeDefined());
    expect(checkpointOf(sent, 'click button "Search"')!.action?.requests).toMatchObject([{ error: "aborted" }]);
  });

  it("posts a WebView message as it was when posted, also while it waits for the sync", async () => {
    const posted: string[] = [];
    let listener: ((e: { data: unknown }) => void) | undefined;
    const win = {
      chrome: {
        webview: {
          // WebView2 serializes the message as JSON when it is posted
          postMessage: (m: unknown) => posted.push(JSON.stringify(m)),
          addEventListener: (_: string, l: (e: { data: unknown }) => void) => (listener = l),
        },
      },
    } as unknown as Win;
    const { tracker, sent, release } = slowRecorder();
    hookWebView(win, tracker, jsonRpc);
    const webview = webviewOf(win);

    tracker.userAction("click", 'button "Save all"');
    const message: { jsonrpc: string; method: string; id?: number; params?: unknown } = { jsonrpc: "2.0", method: "orders.save" };
    for (const [id, qty] of [
      [1, 10],
      [2, 20],
    ]) {
      message.id = id;
      message.params = { qty };
      webview.postMessage(message);
    }
    // a message WebView2 can't serialize throws to the caller, as it does natively
    const circular: Record<string, unknown> = { id: 3, method: "orders.save" };
    circular.self = circular;
    expect(() => webview.postMessage(circular)).toThrow(TypeError);
    expect(posted).toEqual([]);

    await release();
    await tick();
    expect(posted).toEqual([
      '{"jsonrpc":"2.0","method":"orders.save","id":1,"params":{"qty":10}}',
      '{"jsonrpc":"2.0","method":"orders.save","id":2,"params":{"qty":20}}',
    ]);
    listener!({ data: { id: 1, result: {} } });
    listener!({ data: { id: 2, result: {} } });
    await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Save all"')).toBeDefined());
    const errors = checkpointOf(sent, 'click button "Save all"')!.action?.requests.map((r) => r.error);
    expect(errors).toEqual([undefined, undefined, expect.stringContaining("circular")]);
  });

  it("reports a WebView post that fails after waiting for the sync instead of leaving an unhandled rejection", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const win = {
        chrome: {
          webview: {
            postMessage: () => {
              throw new Error("host is gone");
            },
            addEventListener: () => undefined,
          },
        },
      } as unknown as Win;
      const { tracker, sent, release } = slowRecorder();
      hookWebView(win, tracker, jsonRpc);
      tracker.userAction("click", 'button "Save"');
      webviewOf(win).postMessage({ id: 1, method: "orders.save" });
      await release();
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
      expect(String(consoleError.mock.calls[0])).toContain("host is gone");
      await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Save"')).toBeDefined());
      expect(checkpointOf(sent, 'click button "Save"')!.action?.requests[0]?.error).toBe("Error: host is gone");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("ends a WebView call whose id is reused before its reply", async () => {
    const sent: CheckpointPayload[] = [];
    const tracker = new Tracker({ send: async (p) => void sent.push(p), settleMs: 5, syncBefore: false });
    let listener: ((e: { data: unknown }) => void) | undefined;
    const win = {
      chrome: { webview: { postMessage: () => undefined, addEventListener: (_: string, l: (e: { data: unknown }) => void) => (listener = l) } },
    } as unknown as Win;
    hookWebView(win, tracker, jsonRpc);
    tracker.userAction("click", 'button "Save"');
    webviewOf(win).postMessage({ id: 1, method: "orders.validate" });
    webviewOf(win).postMessage({ id: 1, method: "orders.save" });
    listener!({ data: { id: 1, result: {} } });
    // without this the first call would hold the action open until the maxRequestMs cap
    await vi.waitFor(() => expect(checkpointOf(sent, 'click button "Save"')).toBeDefined());
    expect(checkpointOf(sent, 'click button "Save"')!.action?.requests.map((r) => [r.method, r.error])).toEqual([
      ["orders.validate", "id reused before a reply"],
      ["orders.save", undefined],
    ]);
  });
});
