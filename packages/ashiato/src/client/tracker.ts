import type { ActionInfo, RequestInfo } from "../core/types.js";

export interface CheckpointPayload {
  label: string;
  source: string;
  action?: ActionInfo;
  dropIfEmpty?: boolean;
}

export interface TrackerOptions {
  /** Sends a checkpoint to the recorder. Must never be tracked itself. */
  send: (payload: CheckpointPayload) => Promise<void>;
  /** Quiet time after the last request of an action before its checkpoint is taken. Default 150ms. */
  settleMs?: number;
  /** How long to wait after a message that gets no reply (one-way postMessage). Default 500ms. */
  oneWayMs?: number;
  /** Events this close together, before any request, count as one action (click on a submit button + submit). Default 300ms. */
  mergeMs?: number;
  /** A request belongs to the last user action only if it starts within this time of it (or while the action's requests are still running). Default 1000ms. */
  attachMs?: number;
  /**
   * Take a checkpoint before an action's first request is sent, so changes made outside any
   * action (other users, batch jobs) don't get attributed to it. The request waits for it. Default true.
   */
  syncBefore?: boolean;
  /** Upper bound for how long a request waits for the sync checkpoint (and for an earlier action, see `after`). Default 5000ms. */
  syncTimeoutMs?: number;
  /**
   * A request still open after this long is ended as "no reply", so its action gets its checkpoint.
   * An action this old takes no new requests, so a fast poller can't keep it open. Default 30000ms.
   */
  maxRequestMs?: number;
  /** Browser tab id recorded with each action (matches the tab's screen replay). */
  tab?: string;
  now?: () => number;
  page?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A sync checkpoint that requests wait for. `open` once it is done (or timed out). */
interface Gate {
  promise: Promise<void>;
  open: boolean;
}

/** A checkpoint handed to the recorder (queued behind the ones before it). */
interface Sent {
  done: Promise<void>;
  /** The recorder has been asked (it was its turn). */
  started: boolean;
  answered: boolean;
  /** A sync whose request went out without it: skipped when its turn comes. */
  cancelled: boolean;
  sync: boolean;
}

interface Pending {
  since: number;
  /** When it was actually sent: the first requests of an action wait for its sync checkpoint. */
  sent?: number;
  /** It may write (see `mayWrite`). */
  writes: boolean;
}

interface Action {
  info: ActionInfo;
  label: string;
  /** Requests still running. */
  inflight: Set<Pending>;
  /** One of its requests may write. */
  writes: boolean;
  /** A request that may write has been sent: its changes can be in the database before its checkpoint. */
  wrote: boolean;
  /** A write of it ran for long (an RPC waiting on a dialog): a later action that overlaps it names the step. */
  slow: boolean;
  started: number;
  sync?: Gate;
  /** The previous action's checkpoint, taken as this one began: it serves as this one's sync. */
  before?: Sent;
  settleTimer?: unknown;
  done: boolean;
  /** Synthetic actions (requests with no user action) are dropped when nothing changed. */
  synthetic: boolean;
}

export interface RequestHandle {
  /** Resolves when the request may be sent (after the sync checkpoint). */
  ready: Promise<void>;
  /** True when the request has to wait for `ready`; false when it may be sent right away. */
  waiting: boolean;
  end(result?: { status?: number; error?: string }): void;
}

const OPEN: Gate = { promise: Promise.resolve(), open: true };

/** Requests running longer than this (long-polling) don't hold back other actions' sync checkpoints. */
const LONG_REQUEST_MS = 5000;

const labelOf = (type: string, target: string | undefined) => (target ? `${type} ${target}` : type);

/** Anything but an HTTP GET / HEAD may change data (RPC calls and messages included). */
const mayWrite = (r: RequestInfo) => !(r.kind === "http" && (r.method === "GET" || r.method === "HEAD"));

/**
 * Groups requests under the user action that caused them, and takes one checkpoint per action
 * once all of its requests have finished.
 */
export class Tracker {
  private current?: Action;
  private readonly active = new Set<Action>();
  /** Checkpoints are sent one at a time so the recorder sees them in the order they happened. */
  private sending: Promise<void> = Promise.resolve();
  /** The latest sync checkpoint; requests of later actions wait for it too, so they keep their order. */
  private gate: Gate = { promise: Promise.resolve(), open: true };
  /** The checkpoint handed over last. */
  private last?: Sent;
  /** Actions waiting to see whether the writes before them are still running (see `after`). */
  private readonly waiters = new Set<() => void>();
  /** Set during the task that handled a user event: its requests belong to it even after a long confirm(). */
  private inUserTask = false;
  /** A sync checkpoint timed out and hasn't been answered yet (the recorder hangs): later actions don't wait for one. */
  private syncStuck = false;
  private readonly o: Required<Omit<TrackerOptions, "send" | "tab">> & Pick<TrackerOptions, "send" | "tab">;

  constructor(options: TrackerOptions) {
    this.o = {
      settleMs: 150,
      oneWayMs: 500,
      mergeMs: 300,
      attachMs: 1000,
      syncBefore: true,
      syncTimeoutMs: 5000,
      maxRequestMs: 30_000,
      now: () => Date.now(),
      page: () => (typeof location === "undefined" ? "" : location.pathname + location.search + location.hash),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      // options passed through from config may be explicitly undefined: keep the defaults then
      ...(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as TrackerOptions),
    };
  }

  get oneWayMs(): number {
    return this.o.oneWayMs;
  }

  /** Called for clicks, submits, changes and Enter presses. */
  userAction(type: string, target: string | undefined): void {
    const now = this.o.now();
    const cur = this.current;
    this.inUserTask = true;
    this.o.setTimer(() => (this.inUserTask = false), 0);

    // One gesture fires several events before any request: click on a submit button + submit,
    // or the input's change (fired on blur) + the click on Save. Keep one action for them.
    if (cur && !cur.done && !cur.synthetic && cur.info.requests.length === 0 && now - cur.started < this.o.mergeMs) {
      if (cur.info.type === "change" && type !== "change") {
        // "change input" + "click Save": the click says what the user did
        cur.info.type = type;
        cur.info.target = target;
        cur.label = labelOf(type, target);
      }
      // the last of them is the one that sends the requests: a test generated from the recording does that one
      cur.info.lastAt = new Date(now).toISOString();
      return;
    }
    // The previous action is only waiting for its settle time: take its checkpoint now, so this
    // action's requests (and its sync) come after it instead of landing in it.
    let before: Sent | undefined;
    if (cur && !cur.done && cur.inflight.size === 0 && cur.settleTimer !== undefined) {
      this.o.clearTimer(cur.settleTimer);
      before = this.finish(cur);
    }
    this.current = this.newAction(type, target, false);
    this.current.before = before;
  }

  /** `onEnd` runs once the request has ended, whether by `end()` or by the maxRequestMs cap. */
  beginRequest(req: RequestInfo, onEnd?: () => void): RequestHandle {
    let action = this.current;
    const stale =
      action && action.info.requests.length === 0 && !this.inUserTask && this.o.now() - action.started > this.o.attachMs;
    // requests arriving less than settleMs apart (a fast poller) would never let the action settle
    const tooOld = action && !this.inUserTask && this.o.now() - action.started > this.o.maxRequestMs;
    if (!action || action.done || stale || tooOld) {
      action = this.current = this.newAction("request", undefined, true);
    }
    if (action.settleTimer !== undefined) {
      this.o.clearTimer(action.settleTimer);
      action.settleTimer = undefined;
    }
    const entry: RequestInfo = { ...req };
    action.info.requests.push(entry);
    const open: Pending = { since: this.o.now(), writes: mayWrite(req) };
    action.inflight.add(open);
    if (open.writes) action.writes = true;
    // requests with no user action that only read (polling, page loads) take no checkpoint: on a slow
    // database a poller would keep the recorder busy, and a GET's step would show other people's changes
    if (!action.synthetic || action.writes) action.sync ??= this.syncFor(action);
    const a = action;
    const gate = action.sync ?? OPEN;
    let ended = false;
    const send = () => {
      if (ended) return;
      open.sent = this.o.now();
      if (open.writes) a.wrote = true;
    };
    if (gate.open) send();
    else void gate.promise.then(send);
    const end = (result: { status?: number; error?: string } = {}) => {
      if (ended) return;
      ended = true;
      this.o.clearTimer(cap);
      // the duration counts from when the request is actually sent, not from when it waited for the sync
      Object.assign(entry, result, { durationMs: this.o.now() - (open.sent ?? open.since) });
      a.inflight.delete(open);
      if (open.writes && !this.running(open)) a.slow = true;
      if (a.inflight.size === 0) a.settleTimer = this.o.setTimer(() => this.finish(a), this.o.settleMs);
      if (open.writes) for (const wake of [...this.waiters]) wake();
      onEnd?.();
    };
    const cap = this.o.setTimer(() => end({ error: `no reply after ${Math.round(this.o.maxRequestMs / 1000)}s` }), this.o.maxRequestMs);
    return { ready: gate.promise, waiting: !gate.open, end };
  }

  /**
   * The page is going away: hand over the checkpoints of actions that only wait for their settle
   * time, so they can be sent with sendBeacon instead of being lost.
   */
  flushSettled(): CheckpointPayload[] {
    const out: CheckpointPayload[] = [];
    for (const a of [...this.active]) {
      if (a.done || a.inflight.size > 0 || a.settleTimer === undefined) continue;
      // as in `finish`: one handed over first would take the changes of another that wrote. Join an
      // action handed over later in this loop (settling), or, for one that only read, any that wrote.
      const other = [...this.active].find((b) => b !== a && this.unrecorded(b) && (!a.writes || b.inflight.size === 0));
      if (other) this.merge(a, other);
      else out.push(this.complete(a));
    }
    return out;
  }

  private newAction(type: string, target: string | undefined, synthetic: boolean): Action {
    const started = this.o.now();
    const info: ActionInfo = { type, target, page: this.o.page(), tab: this.o.tab, startedAt: new Date(started).toISOString(), requests: [] };
    return { info, label: synthetic ? "request" : labelOf(type, target), inflight: new Set(), writes: false, wrote: false, slow: false, started, done: false, synthetic };
  }

  /** A request that may write, waiting to be sent or running, apart from one open for a long time (long-polling). */
  private running(r: Pending): boolean {
    return r.writes && (r.sent === undefined || this.o.now() - r.sent < LONG_REQUEST_MS);
  }

  /** The action has a request running (or about to be sent) that may write. */
  private writing(a: Action): boolean {
    return !a.done && [...a.inflight].some((r) => this.running(r));
  }

  /**
   * The action may have written changes that no checkpoint has taken yet, and will take its own
   * soon: one held open by a long request (long-polling, an RPC waiting on a dialog) doesn't count.
   */
  private unrecorded(a: Action): boolean {
    return !a.done && a.wrote && [...a.inflight].every((r) => !r.writes || this.running(r));
  }

  /** A request of it that may write waits to be sent. */
  private held(a: Action): boolean {
    return !a.done && [...a.inflight].some((r) => r.writes && r.sent === undefined);
  }

  /** Its writes are over, but it is still reading or settling. */
  private doneWriting(a: Action): boolean {
    return !a.done && a.wrote && ![...a.inflight].some((r) => r.writes);
  }

  /**
   * Takes the checkpoint of the actions other than `except` that are done writing. More than one can
   * only be when their writes overlapped: their changes are all in the database, so they make one step.
   */
  private checkpointDone(except: Action): Sent | undefined {
    const done = [...this.active].filter((a) => a !== except && this.doneWriting(a));
    const into = done.pop();
    if (!into) return undefined;
    for (const a of done) this.merge(a, into);
    return this.checkpointNow(into);
  }

  /** Writes of actions other than `action` that have been sent and are still running. */
  private sentWrites(action: Action): Pending[] {
    return [...this.active].filter((a) => a !== action).flatMap((a) => [...a.inflight].filter((r) => r.sent !== undefined && this.running(r)));
  }

  /** How long the longest of these requests waited before it was sent. */
  private static held(writes: Pending[]): number {
    return Math.max(0, ...writes.map((r) => r.sent! - r.since));
  }

  /**
   * Checkpoint before the action's first request, so changes made before it (other users, batch
   * jobs) aren't counted as its own. While another action is still writing, see `after`. Requests
   * that only read (a poller) don't stand in the way.
   */
  private syncFor(action: Action): Gate {
    const others = [...this.active].filter((a) => a !== action);
    this.active.add(action);
    if (!this.o.syncBefore || this.syncStuck) {
      // no sync, but actions done writing still get their checkpoint before this one's requests
      if (!others.some((a) => this.writing(a))) this.checkpointDone(action);
      return this.gate;
    }
    const deadline = this.o.now() + this.o.syncTimeoutMs;
    let promise: Promise<void>;
    if (others.some((a) => this.writing(a))) {
      const writes = this.sentWrites(action);
      // sent without waiting and still running: the two overlap, as they do without ashiato (see `finish`)
      if (this.gate.open && writes.length > 0 && Tracker.held(writes) === 0) return this.gate;
      promise = this.after(action, deadline);
    } else {
      promise = this.sync(action, deadline);
    }
    const gate: Gate = { promise, open: false };
    void promise.then(() => (gate.open = true));
    return (this.gate = gate);
  }

  /**
   * Another action is writing. Its requests may have waited for its sync, while in the app they'd
   * have gone out at once: this action's requests wait as long, so the two keep their spacing (the
   * recorder being slower than the user mustn't put two clicks in one step). If the other one is
   * still writing then, they really overlap and become one step (see `finish`). Once it is done, its
   * checkpoint is taken first and this action gets its sync.
   */
  private after(action: Action, deadline: number): Promise<void> {
    const began = this.o.now();
    const prev = this.gate.promise;
    return new Promise<void>((resolve) => {
      let over = false;
      let due = Infinity;
      let wait: unknown;
      const go = (sync: boolean) => {
        if (over) return;
        over = true;
        this.waiters.delete(check);
        this.o.clearTimer(wait);
        this.o.clearTimer(cap);
        if (sync && !this.syncStuck) void this.sync(action, deadline).then(resolve);
        else resolve();
      };
      const check = () => {
        if (this.sentWrites(action).length === 0) go(true);
        else if (this.o.now() >= due) go(false);
      };
      const cap = this.o.setTimer(() => go(false), deadline - began);
      void prev.then(() => {
        if (over) return;
        // the writes that began before this action have been sent now
        due = began + Tracker.held(this.sentWrites(action));
        this.waiters.add(check);
        wait = this.o.setTimer(
          () => {
            due = -Infinity; // a clock a little behind the timer mustn't leave it waiting
            check();
          },
          Math.max(0, due - this.o.now()),
        );
        check();
      });
    });
  }

  /**
   * Takes the action's sync checkpoint; resolves when it is done, or at the deadline. A checkpoint
   * of another action taken as this one began serves as well.
   */
  private sync(action: Action, deadline: number): Promise<void> {
    // only for a request sent right after the click (not after a confirm(), where others may change data
    // meanwhile), and behind every checkpoint queued since
    let sent = action.before && !action.before.answered && this.o.now() - action.started <= this.o.mergeMs ? this.last : undefined;
    // actions done writing but still reading or settling: their checkpoint first, or their changes would land in this one's step
    sent = this.checkpointDone(action) ?? sent;
    // one not handed to the recorder yet reads the tables after this point too
    if (!sent && this.last && !this.last.started && !this.last.sync) sent = this.last;
    const s = sent ?? this.send({ label: "outside actions", source: "sync", dropIfEmpty: true });
    void s.done.then(() => (this.syncStuck = false));
    return new Promise<void>((resolve) => {
      void s.done.then(resolve);
      this.o.setTimer(
        () => {
          if (!s.answered) {
            // a recorder that accepts the request but never answers would make every action wait the full timeout
            this.syncStuck = true;
            // taken after this action's requests, a sync would show their changes as made outside any action
            if (s.sync && !s.started) s.cancelled = true;
          }
          resolve();
        },
        Math.max(0, deadline - this.o.now()),
      );
    });
  }

  private send(payload: CheckpointPayload): Sent {
    const sent: Sent = { done: Promise.resolve(), started: false, answered: false, cancelled: false, sync: payload.source === "sync" };
    sent.done = this.sending
      .then(() => {
        if (sent.cancelled) return;
        sent.started = true;
        return this.o.send(payload);
      })
      .catch(() => undefined)
      .then(() => void (sent.answered = true));
    this.sending = sent.done;
    return (this.last = sent);
  }

  private finish(action: Action): Sent | undefined {
    if (action.done || action.inflight.size > 0) return;
    if (!action.sync) return void (action.done = true); // only read, with no user action: no checkpoint
    // Another action has writes the database may already hold: a checkpoint now would take them into
    // this action's step (and a poll's GET would get a click's changes). The two become one step, taken
    // when that one is done. Also one whose writes wait for their sync: they go out before a checkpoint
    // queued now is taken.
    const other = [...this.active].find((a) => a !== action && (this.unrecorded(a) || this.held(a)));
    // one older than maxRequestMs takes its checkpoint anyway: writes that keep overlapping each
    // other (a heartbeat message) would otherwise put it off for good
    if (other && this.o.now() - action.started <= this.o.maxRequestMs) return void this.merge(action, other);
    return this.checkpointNow(action);
  }

  private checkpointNow(action: Action): Sent {
    if (action.settleTimer !== undefined) this.o.clearTimer(action.settleTimer);
    return this.send(this.complete(action));
  }

  /**
   * `from` is over; its requests join `into`, which takes one checkpoint for both. The step is named
   * after the action that wrote, the user's, the one not held open by a long write, or else the earlier one.
   */
  private merge(from: Action, into: Action): void {
    from.done = true;
    if (from.settleTimer !== undefined) this.o.clearTimer(from.settleTimer);
    from.settleTimer = undefined;
    this.active.delete(from);
    const rank = (a: Action) => (a.writes ? 0 : 4) + (a.synthetic ? 2 : 0) + (a.slow ? 1 : 0);
    const earlier = from.started <= into.started;
    const requests = earlier ? [...from.info.requests, ...into.info.requests] : [...into.info.requests, ...from.info.requests];
    if (rank(from) < rank(into) || (rank(from) === rank(into) && earlier)) {
      into.info = from.info;
      into.label = from.label;
      into.synthetic = from.synthetic;
    }
    into.info.requests = requests;
    into.started = Math.min(from.started, into.started);
    into.writes ||= from.writes;
    into.wrote ||= from.wrote;
    into.slow &&= from.slow;
  }

  private complete(action: Action): CheckpointPayload {
    action.done = true;
    action.settleTimer = undefined;
    this.active.delete(action);
    if (action.synthetic && action.info.requests.length === 1) {
      const r = action.info.requests[0]!;
      action.label = r.kind === "http" ? `${r.method} ${r.url ?? ""}`.trim() : r.method;
    }
    // actions that only read (a search, or a poll that started right after a click) are kept only if something changed
    return { label: action.label, source: summarize(action.info.requests), action: action.info, dropIfEmpty: action.synthetic || !action.writes };
  }
}

function summarize(requests: RequestInfo[]): string {
  const names = requests.map((r) => (r.kind === "http" ? `${r.method} ${pathOf(r.url)}` : r.method));
  const unique = [...new Set(names)];
  return unique.length <= 2 ? unique.join(", ") : `${unique.slice(0, 2).join(", ")} +${unique.length - 2}`;
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url, "http://x");
    return u.pathname;
  } catch {
    return url;
  }
}
