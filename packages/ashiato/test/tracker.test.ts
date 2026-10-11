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

  it("sends checkpoints one at a time, in order", async () => {
    const log: string[] = [];
    let release!: () => void;
    const t = new Tracker({
      page: () => "/",
      send: (p) => {
        log.push(`start ${p.label}`);
        // the action's own checkpoint is slow (big snapshot)
        const done = p.source === "sync" ? Promise.resolve() : new Promise<void>((r) => (release = r));
        return done.then(() => void log.push(`end ${p.label}`));
      },
    });
    t.userAction("click", "a");
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    await a.ready;
    a.end({ status: 200 });
    await flush(150);
    t.userAction("click", "b");
    const b = t.beginRequest({ kind: "http", method: "POST", url: "/b" });
    let bReady = false;
    void b.ready.then(() => (bReady = true));
    await flush(0);
    // b's sync must not overtake a's checkpoint, and b's request waits for it
    expect(log).toEqual(["start outside actions", "end outside actions", "start click a"]);
    expect(bReady).toBe(false);
    release();
    await flush(0);
    expect(log.slice(3)).toEqual(["end click a", "start outside actions", "end outside actions"]);
    expect(bReady).toBe(true);
  });

  it("keeps a later action's requests behind an earlier action's pending sync", async () => {
    let release!: () => void;
    const t = new Tracker({ page: () => "/", send: () => new Promise<void>((r) => (release = r)) });
    const order: string[] = [];
    t.userAction("click", "a");
    void t.beginRequest({ kind: "rpc", method: "a" }).ready.then(() => order.push("a"));
    await flush(400);
    t.userAction("click", "b");
    void t.beginRequest({ kind: "rpc", method: "b" }).ready.then(() => order.push("b"));
    await flush(0);
    expect(order).toEqual([]);
    release();
    await flush(0);
    expect(order).toEqual(["a", "b"]);
  });

  it("keeps two quick clicks apart once the first one has sent its requests", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/save" });
    await a.ready;
    a.end({ status: 200 });
    await flush(60);
    t.userAction("click", 'button "Delete"');
    const b = t.beginRequest({ kind: "http", method: "POST", url: "/del" });
    await flush(0);
    b.end({ status: 200 });
    await flush(200);
    expect(sent.filter((p) => p.source !== "sync").map((p) => [p.label, p.source])).toEqual([
      ['click button "Save"', "POST /save"],
      ['click button "Delete"', "POST /del"],
    ]);
  });

  it("takes the previous action's checkpoint before the next click's requests", async () => {
    const t = make({ settleMs: 1000 });
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/save" });
    await a.ready;
    a.end({ status: 200 });
    await flush(400); // Save is still waiting out its settle time
    t.userAction("click", 'button "Delete"');
    const b = t.beginRequest({ kind: "http", method: "POST", url: "/del" });
    await b.ready;
    // Save's checkpoint went out first, then Delete got its own sync instead of skipping it
    expect(sent.map((p) => p.label)).toEqual(["outside actions", 'click button "Save"', "outside actions"]);
  });

  it("labels a field change followed by a click on Save by the click", async () => {
    const t = make();
    t.userAction("change", 'input "quantity"');
    await flush(80);
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/save" });
    a.end();
    await flush(200);
    expect(sent.at(-1)).toMatchObject({ label: 'click button "Save"', action: { type: "click", target: 'button "Save"' } });
  });

  it("keeps a request made after a long confirm() with its click", async () => {
    let clock = 0;
    const t = make({ now: () => clock });
    t.userAction("click", 'button "Delete"');
    clock += 5000; // confirm() blocked the click handler; no timers ran meanwhile
    const a = t.beginRequest({ kind: "http", method: "DELETE", url: "/orders/1" });
    a.end();
    await flush(200);
    expect(sent.at(-1)?.label).toBe('click button "Delete"');
  });

  it("ends requests that never reply, so the action still gets its checkpoint", async () => {
    const t = make({ maxRequestMs: 2000 });
    t.userAction("click", 'button "Save"');
    t.beginRequest({ kind: "rpc", method: "orders.save" });
    await flush(2000 + 150);
    expect(sent.at(-1)).toMatchObject({ label: 'click button "Save"' });
    expect(sent.at(-1)?.action?.requests[0]?.error).toBe("no reply after 2s");
  });

  it("doesn't let a long-polling request switch off other actions' sync checkpoints", async () => {
    const t = make();
    const poll = t.beginRequest({ kind: "http", method: "GET", url: "/poll" });
    await poll.ready;
    await flush(6000);
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/save" });
    await a.ready;
    expect(sent.filter((p) => p.source === "sync")).toHaveLength(2);
  });

  it("drops actions that only read when nothing changed", async () => {
    const t = make();
    t.userAction("click", 'button "Search"');
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/search?q=x" });
    a.end();
    await flush(200);
    expect(sent.at(-1)).toMatchObject({ label: 'click button "Search"', dropIfEmpty: true });
  });

  it("says whether a request has to wait for the sync checkpoint", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    expect(a.waiting).toBe(true);
    await a.ready;
    const b = t.beginRequest({ kind: "http", method: "GET", url: "/b" });
    expect(b.waiting).toBe(false);
  });

  it("hands over settling actions when the page goes away", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    await a.ready;
    a.end();
    expect(t.flushSettled()).toMatchObject([{ label: 'click button "Save"' }]);
    await flush(200);
    expect(sent.map((p) => p.label)).toEqual(["outside actions"]); // not sent twice
  });

  it("lets an action settle although a fast poller keeps sending requests", async () => {
    const t = make();
    // a progress poll every 100ms, answered in 20ms: never quiet for settleMs
    const poll = setInterval(() => {
      const h = t.beginRequest({ kind: "http", method: "GET", url: "/api/progress" });
      setTimeout(() => h.end({ status: 200 }), 20);
    }, 100);
    try {
      await flush(1000);
      t.userAction("click", 'button "Save"');
      const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
      await save.ready;
      save.end({ status: 200 });
      // the action takes no requests once it is maxRequestMs old, so it can settle then
      await flush(30_000 + 300);
      const cp = sent.find((p) => p.label === 'click button "Save"');
      expect(cp?.action?.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      // the poller carries on in actions of its own, dropped when nothing changed
      const count = sent.length;
      await flush(30_000 + 300);
      expect(sent.slice(count)).toMatchObject([{ action: { type: "request" }, dropIfEmpty: true }]);
    } finally {
      clearInterval(poll);
    }
  });

  it("keeps a request with its click even when a confirm() was open longer than maxRequestMs", async () => {
    let clock = 0;
    const t = make({ now: () => clock, maxRequestMs: 2000 });
    t.userAction("click", 'button "Delete"');
    clock += 5000;
    const a = t.beginRequest({ kind: "http", method: "DELETE", url: "/orders/1" });
    a.end();
    await flush(200);
    expect(sent.at(-1)?.label).toBe('click button "Delete"');
  });

  it("stops waiting for sync checkpoints while the recorder doesn't answer one", async () => {
    sent = [];
    let answer!: () => void;
    const t = new Tracker({
      page: () => "/",
      syncTimeoutMs: 1000,
      send: (p) => {
        sent.push(p);
        // the recorder accepts the first request but doesn't answer it until answer()
        return sent.length === 1 ? new Promise<void>((r) => (answer = r)) : Promise.resolve();
      },
    });
    t.userAction("click", 'button "A"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    expect(a.waiting).toBe(true);
    await flush(1000); // waited out syncTimeoutMs
    a.end();
    await flush(150);

    t.userAction("click", 'button "B"');
    const b = t.beginRequest({ kind: "http", method: "POST", url: "/b" });
    expect(b.waiting).toBe(false); // no new sync to wait for
    b.end();
    await flush(150);
    expect(sent.map((p) => p.label)).toEqual(["outside actions"]); // the rest is queued behind it

    answer();
    await flush(0);
    expect(sent.map((p) => p.label)).toEqual(["outside actions", 'click button "A"', 'click button "B"']);
    // the recorder answers again: actions get their sync again
    t.userAction("click", 'button "C"');
    const c = t.beginRequest({ kind: "http", method: "POST", url: "/c" });
    expect(c.waiting).toBe(true);
    await c.ready;
    expect(sent.map((p) => p.label).at(-1)).toBe("outside actions");
  });

  it("tells the caller once a request has ended, also when the time cap ends it", async () => {
    const t = make({ maxRequestMs: 1000 });
    const ended: string[] = [];
    const a = t.beginRequest({ kind: "rpc", method: "a" }, () => ended.push("a"));
    t.beginRequest({ kind: "rpc", method: "b" }, () => ended.push("b"));
    a.end();
    a.end();
    expect(ended).toEqual(["a"]);
    await flush(1000);
    expect(ended).toEqual(["a", "b"]);
  });
});
