import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tracker, type CheckpointPayload } from "../src/client/tracker.js";

let sent: CheckpointPayload[];
const make = (opts: Partial<ConstructorParameters<typeof Tracker>[0]> = {}) => {
  sent = [];
  return new Tracker({ send: async (p) => void sent.push(p), page: () => "/orders", ...opts });
};
const flush = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Tracker", () => {
  it("syncs before the first request, then checkpoints once all requests of the action settle", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/api/orders" });
    await a.ready;
    expect(sent).toEqual([{ label: "outside actions", source: "sync", dropIfEmpty: true }]);

    const b = t.beginRequest({ kind: "http", method: "GET", url: "/api/stock?item=3" });
    a.end({ status: 201 });
    await flush(100);
    b.end({ status: 200 });
    await flush(149);
    expect(sent).toHaveLength(1);
    await flush(1);

    expect(sent).toHaveLength(2);
    const cp = sent[1]!;
    expect(cp.label).toBe('click button "Save"');
    expect(cp.source).toBe("POST /api/orders, GET /api/stock");
    expect(cp.dropIfEmpty).toBe(false);
    expect(cp.action?.page).toBe("/orders");
    expect(cp.action?.requests.map((r) => [r.method, r.status])).toEqual([
      ["POST", 201],
      ["GET", 200],
    ]);
  });

  it("keeps chained requests (started during the settle time) in the same action", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    await a.ready;
    a.end({ status: 200 });
    await flush(50);
    const b = t.beginRequest({ kind: "http", method: "GET", url: "/b" });
    b.end({ status: 200 });
    await flush(150);
    expect(sent.filter((p) => p.source !== "sync")).toHaveLength(1);
    expect(sent.at(-1)?.action?.requests).toHaveLength(2);
  });

  it("treats a click followed by submit as one action", async () => {
    const t = make();
    t.userAction("click", 'button "Send"');
    await flush(10);
    t.userAction("submit", "form");
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/send" });
    a.end();
    await flush(200);
    expect(sent.at(-1)?.label).toBe('click button "Send"');
  });

  it("checkpoints requests without a user action, dropping them when nothing changed", async () => {
    const t = make();
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/api/orders" });
    a.end({ status: 200 });
    await flush(200);
    expect(sent.at(-1)).toMatchObject({ label: "GET /api/orders", dropIfEmpty: true, action: { type: "request" } });
  });

  it("does not attach a late request to an old click that had no requests", async () => {
    const t = make();
    t.userAction("click", 'tab "Details"');
    await flush(5000);
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/poll" });
    a.end();
    await flush(200);
    expect(sent.at(-1)?.action?.type).toBe("request");
  });

  it("skips the sync checkpoint while another action is still running", async () => {
    const t = make();
    t.userAction("click", 'button "A"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    await flush(400);
    t.userAction("click", 'button "B"');
    t.beginRequest({ kind: "http", method: "POST", url: "/b" });
    expect(sent.filter((p) => p.source === "sync")).toHaveLength(1);
    a.end();
  });

  it("does not block requests when the recorder hangs", async () => {
    const t = new Tracker({ send: () => new Promise(() => {}), syncTimeoutMs: 1000 });
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/x" });
    let ready = false;
    void a.ready.then(() => (ready = true));
    await flush(999);
    expect(ready).toBe(false);
    await flush(1);
    expect(ready).toBe(true);
  });

  it("keeps defaults for options passed as undefined", async () => {
    const t = make({ syncBefore: undefined, settleMs: undefined });
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/x" });
    await a.ready;
    expect(sent).toHaveLength(1);
    a.end();
    await flush(149);
    expect(sent).toHaveLength(1);
    await flush(1);
    expect(sent).toHaveLength(2);
  });

  it("can turn the sync checkpoint off", async () => {
    const t = make({ syncBefore: false });
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/x" });
    await a.ready;
    expect(sent).toEqual([]);
  });
});
