// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { describe as describeEl, hookFetch, hookWebView, jsonRpc } from "../src/client/hooks.js";
import { Tracker, type CheckpointPayload } from "../src/client/tracker.js";

describe("jsonRpc codec", () => {
  it("recognizes requests, notifications and replies, as objects or JSON strings", () => {
    expect(jsonRpc.request({ jsonrpc: "2.0", id: 1, method: "orders.save", params: {} })).toEqual({ id: 1, method: "orders.save" });
    expect(jsonRpc.request('{"method":"log","params":[]}')).toEqual({ method: "log" });
    expect(jsonRpc.request({ type: "other" })).toBeNull();
    expect(jsonRpc.response({ id: 1, result: null })).toBe(1);
    expect(jsonRpc.response('{"id":"a","error":{"message":"x"}}')).toBe("a");
    expect(jsonRpc.response({ id: 2, method: "server.push" })).toBeNull();
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
});
