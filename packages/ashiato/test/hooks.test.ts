// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { describe as describeEl, hookFetch, hookWebView, hookXhr, jsonRpc } from "../src/client/hooks.js";
import { Tracker, type CheckpointPayload } from "../src/client/tracker.js";

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
    const win = { fetch: async (u: string) => (calls.push(u), new Response("ok", { status: 201 })) } as unknown as Window & typeof globalThis;
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
});
