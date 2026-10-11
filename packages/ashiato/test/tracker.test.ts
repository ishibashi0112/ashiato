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
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/api/visits" });
    a.end({ status: 200 });
    await flush(200);
    expect(sent.at(-1)).toMatchObject({ label: "POST /api/visits", dropIfEmpty: true, action: { type: "request" } });
  });

  it("takes no checkpoint for requests without a user action that only read (polling, page loads)", async () => {
    const t = make();
    const a = t.beginRequest({ kind: "http", method: "GET", url: "/api/notifications" });
    expect(a.waiting).toBe(false);
    a.end({ status: 200 });
    await flush(200);
    expect(sent).toEqual([]);
  });

  it("does not attach a late request to an old click that had no requests", async () => {
    const t = make();
    t.userAction("click", 'tab "Details"');
    await flush(5000);
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/heartbeat" });
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
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/x" });
    let ready = false;
    void a.ready.then(() => (ready = true));
    await flush(999);
    expect(ready).toBe(false);
    await flush(1);
    expect(ready).toBe(true);
  });

  it("keeps defaults for options passed as undefined", async () => {
    const t = make({ syncBefore: undefined, settleMs: undefined });
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/x" });
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

  it("keeps a later action's requests behind an earlier action's pending sync, as far apart as they began", async () => {
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
    expect(order).toEqual(["a"]);
    await flush(399);
    expect(order).toEqual(["a"]);
    await flush(1);
    expect(order).toEqual(["a", "b"]); // a is still running: the two overlap, as they would without ashiato
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
    // Save's checkpoint went out first, and Delete waited for it: taken as Delete began, it stands in for Delete's sync
    expect(sent.map((p) => p.label)).toEqual(["outside actions", 'click button "Save"']);
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
    const poll = t.beginRequest({ kind: "http", method: "POST", url: "/subscribe" }); // long-polling
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

  it("hands over a click's checkpoint, not a search's, when the page goes away right after saving", async () => {
    const t = make();
    t.userAction("click", 'button "Search"');
    const search = t.beginRequest({ kind: "http", method: "GET", url: "/api/search" });
    await search.ready;
    await flush(400);
    t.userAction("click", 'button "Save and close"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    await save.ready;
    search.end({ status: 200 });
    save.end({ status: 200 }); // then the app navigates away
    const out = t.flushSettled();
    expect(out).toMatchObject([{ label: 'click button "Save and close"', dropIfEmpty: false }]);
    expect(out[0]?.action?.requests.map((r) => r.url)).toEqual(["/api/search", "/api/save"]);
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
      // the poller carries on in actions of its own, which only read: no checkpoints
      const count = sent.length;
      await flush(30_000 + 300);
      expect(sent.slice(count)).toEqual([]);
    } finally {
      clearInterval(poll);
    }
  });

  it("keeps a click's changes out of a request that was running when it started", async () => {
    const t = make();
    // a page-load request that writes, still running
    const visit = t.beginRequest({ kind: "http", method: "POST", url: "/api/visits" }, undefined);
    await visit.ready;
    await flush(6000); // open for long: it doesn't hold back the click's sync
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    expect(save.waiting).toBe(true);
    await save.ready;
    visit.end({ status: 200 });
    await flush(150); // the visit settles while Save's POST runs: its checkpoint would take Save's changes
    expect(sent.map((p) => p.label)).toEqual(["outside actions", "outside actions"]);
    save.end({ status: 200 });
    await flush(150);
    expect(sent.slice(2)).toMatchObject([{ label: 'click button "Save"', dropIfEmpty: false }]);
    expect(sent[2]?.action?.requests.map((r) => r.url)).toEqual(["/api/visits", "/api/save"]);
  });

  it("puts actions whose writes overlap into one step, named after the first click", async () => {
    const t = make();
    t.userAction("click", 'button "Order"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/api/orders" });
    await a.ready;
    await flush(100);
    t.userAction("click", 'button "Order"'); // double click: the second POST starts before the first one ends
    const b = t.beginRequest({ kind: "http", method: "POST", url: "/api/orders" });
    expect(b.waiting).toBe(false);
    a.end({ status: 200 });
    await flush(200); // the first click settles while the second one's POST is still running
    expect(sent.filter((p) => p.source !== "sync")).toEqual([]);
    b.end({ status: 500 });
    await flush(150);
    const steps = sent.filter((p) => p.source !== "sync");
    expect(steps).toMatchObject([{ label: 'click button "Order"', source: "POST /api/orders" }]);
    expect(steps[0]?.action?.requests.map((r) => r.status)).toEqual([200, 500]);
  });

  it("doesn't hold other actions' checkpoints behind a long-running call", async () => {
    const t = make();
    t.userAction("click", 'button "Pick file"');
    t.beginRequest({ kind: "rpc", method: "host.openFileDialog" }); // the host waits for the user
    await flush(6000);
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    await save.ready;
    save.end({ status: 200 });
    await flush(150);
    expect(sent.map((p) => p.label)).toEqual(["outside actions", "outside actions", 'click button "Save"']);
  });

  it("takes an action's checkpoint before the next one's sync once its writes are done", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    await save.ready;
    save.end({ status: 200 });
    const reload = t.beginRequest({ kind: "http", method: "GET", url: "/api/list" }); // still running
    await flush(400);
    t.userAction("click", 'button "Delete"');
    const del = t.beginRequest({ kind: "http", method: "POST", url: "/api/delete" });
    await del.ready;
    expect(sent.map((p) => p.label)).toEqual(["outside actions", 'click button "Save"']);
    reload.end({ status: 200 });
    del.end({ status: 200 });
    await flush(150);
    expect(sent.map((p) => p.label).slice(2)).toEqual(['click button "Delete"']);
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

  describe("with a recorder slower than the user", () => {
    // every checkpoint takes 1s (a large SQL Server database)
    const slow = (opts: Partial<ConstructorParameters<typeof Tracker>[0]> = {}) => {
      sent = [];
      return new Tracker({
        page: () => "/",
        send: async (p) => {
          await new Promise((r) => setTimeout(r, 1000));
          sent.push(p);
        },
        ...opts,
      });
    };
    const steps = () => sent.filter((p) => p.source !== "sync").map((p) => p.label);

    it("keeps a click apart from the previous one that only seemed to overlap it because it waited for its sync", async () => {
      const t = slow();
      t.userAction("click", 'button "Register"');
      const a = t.beginRequest({ kind: "http", method: "POST", url: "/api/customers" });
      await flush(1000); // its sync
      await flush(100);
      t.userAction("click", 'button "Order"'); // 1.1s after the first click: in the app, Register was done long ago
      const b = t.beginRequest({ kind: "http", method: "POST", url: "/api/orders" });
      await flush(50);
      a.end({ status: 201 });
      await flush(0);
      expect(b.waiting).toBe(true);
      let ready = false;
      void b.ready.then(() => (ready = true));
      await flush(999);
      expect(ready).toBe(false); // Register's checkpoint is taken first; it also serves as Order's sync
      await flush(1);
      expect(ready).toBe(true);
      expect(sent.map((p) => p.label)).toEqual(["outside actions", 'click button "Register"']);
      b.end({ status: 201 });
      await flush(150 + 1000);
      expect(steps()).toEqual(['click button "Register"', 'click button "Order"']);
    });

    it("still puts two clicks in one step when their requests overlap with the same delay", async () => {
      const t = slow();
      t.userAction("click", 'button "Order"');
      const a = t.beginRequest({ kind: "http", method: "POST", url: "/api/orders" }); // takes 2s
      await flush(1100);
      t.userAction("click", 'button "Order"');
      const b = t.beginRequest({ kind: "http", method: "POST", url: "/api/orders" });
      let ready = false;
      void b.ready.then(() => (ready = true));
      await flush(999);
      expect(ready).toBe(false);
      await flush(1);
      expect(ready).toBe(true); // as long as a waited; a is still running then
      await flush(900);
      a.end({ status: 201 });
      await flush(100);
      b.end({ status: 201 });
      await flush(150 + 1000);
      expect(steps()).toEqual(['click button "Order"']);
      expect(sent.at(-1)?.action?.requests).toHaveLength(2);
    });

    it("keeps a click's changes out of an action that only read and settles while the click waits for its sync", async () => {
      const t = slow();
      t.userAction("change", 'input "note"');
      const poll = t.beginRequest({ kind: "http", method: "GET", url: "/api/notifications" }); // waits for its sync
      t.userAction("click", 'button "Save"');
      const save = t.beginRequest({ kind: "http", method: "PUT", url: "/api/orders/1" }); // its sync is next in line
      await flush(1000);
      poll.end({ status: 200 });
      await flush(150); // the change settles; a checkpoint queued now would be taken after the PUT
      await flush(850);
      await save.ready;
      save.end({ status: 200 });
      await flush(150 + 1000);
      expect(steps()).toEqual(['click button "Save"']);
      expect(sent.at(-1)?.action?.requests.map((r) => r.method)).toEqual(["GET", "PUT"]);
    });

    it("waits for every checkpoint queued since the click, not only the previous action's", async () => {
      const t = slow();
      t.userAction("click", 'button "Search"');
      const search = t.beginRequest({ kind: "http", method: "GET", url: "/api/search" }); // slow
      await flush(200);
      t.userAction("click", 'button "Save"');
      const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
      await flush(1800);
      save.end({ status: 200 });
      await flush(100);
      t.userAction("click", 'button "Delete"'); // Save is settling: its checkpoint is taken now
      await flush(100);
      search.end({ status: 200 }); // the search's checkpoint is queued behind Save's
      await flush(250);
      const del = t.beginRequest({ kind: "http", method: "POST", url: "/api/delete" }); // after an untracked await
      let ready: string[] | undefined;
      void del.ready.then(() => (ready = sent.map((p) => p.label)));
      await flush(5000);
      expect(ready).toContain('click button "Search"');
    });

    it("ends the wait for the spacing on time even when the clock is a little behind the timers", async () => {
      let lag = 0;
      const t = slow({ now: () => Date.now() - lag });
      t.userAction("click", 'button "A"');
      const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
      await flush(1100);
      t.userAction("click", 'button "B"');
      const b = t.beginRequest({ kind: "http", method: "POST", url: "/b" });
      let ready = false;
      void b.ready.then(() => (ready = true));
      await flush(10);
      lag = 1;
      await flush(1000); // A waited 1s for its sync, and is still running: B goes out now
      expect(ready).toBe(true);
      a.end();
      b.end();
    });

    it("drops a sync it couldn't wait for, instead of taking it after the action's changes", async () => {
      // an action's checkpoint takes 3s, a sync 1s
      const t = slow({
        syncTimeoutMs: 1500,
        send: async (p) => {
          await new Promise((r) => setTimeout(r, p.source === "sync" ? 1000 : 3000));
          sent.push(p);
        },
      });
      t.userAction("click", 'button "A"');
      const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
      await flush(1000);
      a.end();
      await flush(150); // A's checkpoint: being taken until 4150
      await flush(100);
      t.userAction("click", 'button "B"'); // gets a sync of its own, queued behind A's checkpoint
      const b = t.beginRequest({ kind: "http", method: "POST", url: "/b" });
      await flush(1500); // B's request goes out without it at 2750
      b.end();
      await flush(150 + 5000);
      expect(sent.map((p) => p.label)).toEqual(["outside actions", 'click button "A"', 'click button "B"']);
    });
  });

  it("still takes a step's checkpoint when writes keep overlapping each other (a heartbeat message)", async () => {
    const t = make();
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    await save.ready;
    save.end({ status: 200 });
    // a one-way message every 400ms, each one open for oneWayMs (500ms)
    const beat = setInterval(() => {
      const h = t.beginRequest({ kind: "rpc", method: "heartbeat" });
      setTimeout(() => h.end(), 500);
    }, 400);
    try {
      await flush(70_000);
      expect(sent.find((p) => p.label === 'click button "Save"')).toBeTruthy();
    } finally {
      clearInterval(beat);
    }
  });

  it("takes the checkpoint of a click done writing before the next click's requests, also without syncs", async () => {
    const t = make({ syncBefore: false });
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    save.end({ status: 200 });
    t.beginRequest({ kind: "http", method: "GET", url: "/api/events" }); // stays open
    await flush(400);
    t.userAction("click", 'button "Delete"');
    const del = t.beginRequest({ kind: "http", method: "POST", url: "/api/delete" });
    del.end({ status: 200 });
    await flush(150);
    expect(sent.map((p) => p.label)).toEqual(['click button "Save"', 'click button "Delete"']);
  });

  it("names the step after the later click when it overlaps a call that ran for long", async () => {
    const t = make();
    t.userAction("click", 'button "Generate"');
    const gen = t.beginRequest({ kind: "rpc", method: "host.generate" });
    await flush(6000);
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" });
    await save.ready;
    gen.end(); // while Save's POST runs: the two can't be told apart
    await flush(150);
    save.end({ status: 200 });
    await flush(150);
    expect(sent.filter((p) => p.source !== "sync")).toMatchObject([{ label: 'click button "Save"' }]);
  });

  it("takes a fresh sync for a click whose request comes after a long confirm()", async () => {
    let clock = 0;
    const started: string[] = [];
    const t = new Tracker({
      page: () => "/",
      now: () => Date.now() + clock,
      send: async (p) => {
        started.push(p.label);
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    t.userAction("change", 'input "qty"');
    const a = t.beginRequest({ kind: "http", method: "PUT", url: "/api/orders/1" });
    await flush(200);
    a.end({ status: 200 });
    await flush(100); // still settling
    t.userAction("click", 'button "Delete"'); // the change's checkpoint goes out now
    for (let i = 0; i < 5; i++) await Promise.resolve();
    clock += 10_000; // confirm() open for 10s: other users may change data meanwhile
    const b = t.beginRequest({ kind: "http", method: "DELETE", url: "/api/orders/1" });
    await flush(1000);
    expect(started).toEqual(["outside actions", 'change input "qty"', "outside actions"]);
    b.end();
  });

  it("keeps two clicks whose writes overlapped in one step when a third click starts", async () => {
    const t = make();
    t.userAction("click", 'button "Save A"');
    const a = t.beginRequest({ kind: "http", method: "POST", url: "/a" });
    const slowA = t.beginRequest({ kind: "http", method: "GET", url: "/slow-a" });
    await flush(300);
    t.userAction("click", 'button "Save B"'); // while A's POST runs
    const b = t.beginRequest({ kind: "http", method: "POST", url: "/b" });
    await flush(500);
    b.end({ status: 200 });
    const list = t.beginRequest({ kind: "http", method: "GET", url: "/list" });
    await flush(200);
    a.end({ status: 200 }); // both POSTs are done; their GETs still run
    await flush(100);
    t.userAction("click", 'button "Open"');
    t.beginRequest({ kind: "http", method: "GET", url: "/detail" }).end({ status: 200 });
    await flush(0);
    slowA.end({ status: 200 });
    list.end({ status: 200 });
    await flush(1000);
    const steps = sent.filter((p) => p.source !== "sync" && !p.dropIfEmpty);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action?.requests.map((r) => r.url)).toEqual(["/a", "/slow-a", "/b", "/list"]);
  });

  it("names a merged step after the click, not after a request with no click", async () => {
    const t = make();
    t.userAction("click", 'button "Generate"');
    const gen = t.beginRequest({ kind: "rpc", method: "host.generateReport" });
    await flush(1000);
    t.userAction("click", 'tab "Preview"'); // sends nothing
    await flush(2000);
    const progress = t.beginRequest({ kind: "rpc", method: "host.getProgress" }); // no click
    await flush(4000);
    gen.end(); // a long call: it ends while the progress call is still open
    await flush(200);
    progress.end();
    await flush(500);
    expect(sent.filter((p) => p.source !== "sync")).toMatchObject([{ label: 'click button "Generate"', dropIfEmpty: false }]);
  });

  it("keeps the next click's changes out of a long call that ends while they wait for their sync", async () => {
    sent = [];
    const t = new Tracker({
      page: () => "/",
      send: async (p) => {
        await new Promise((r) => setTimeout(r, 1000));
        sent.push(p);
      },
    });
    t.userAction("click", 'button "Generate"');
    const gen = t.beginRequest({ kind: "rpc", method: "host.generate" });
    await flush(7000);
    t.userAction("click", 'button "Save"');
    const save = t.beginRequest({ kind: "http", method: "POST", url: "/api/save" }); // waits for its sync
    await flush(300);
    gen.end(); // a checkpoint queued now would be taken after Save's POST
    await flush(1000);
    save.end({ status: 200 });
    await flush(5000);
    expect(sent.filter((p) => p.source !== "sync")).toMatchObject([{ label: 'click button "Save"' }]);
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
