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
  /** Upper bound for how long a request waits for the sync checkpoint. Default 5000ms. */
  syncTimeoutMs?: number;
  /** A request still open after this long is ended as "no reply", so its action gets its checkpoint. Default 30000ms. */
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

interface Action {
  info: ActionInfo;
  label: string;
  /** Start times of the requests still running. */
  inflight: Set<{ since: number }>;
  started: number;
  sync?: Gate;
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

/** Requests running longer than this (long-polling) don't hold back other actions' sync checkpoints. */
const LONG_REQUEST_MS = 5000;

const labelOf = (type: string, target: string | undefined) => (target ? `${type} ${target}` : type);

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
  /** Set during the task that handled a user event: its requests belong to it even after a long confirm(). */
  private inUserTask = false;
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
      return;
    }
    // The previous action is only waiting for its settle time: take its checkpoint now, so this
    // action's requests (and its sync) come after it instead of landing in it.
    if (cur && !cur.done && cur.inflight.size === 0 && cur.settleTimer !== undefined) {
      this.o.clearTimer(cur.settleTimer);
      this.finish(cur);
    }
    this.current = this.newAction(type, target, false);
  }

  beginRequest(req: RequestInfo): RequestHandle {
    let action = this.current;
    const stale =
      action && action.info.requests.length === 0 && !this.inUserTask && this.o.now() - action.started > this.o.attachMs;
    if (!action || action.done || stale) {
      action = this.current = this.newAction("request", undefined, true);
    }
    if (action.settleTimer !== undefined) {
      this.o.clearTimer(action.settleTimer);
      action.settleTimer = undefined;
    }
    const entry: RequestInfo = { ...req };
    action.info.requests.push(entry);
    const open = { since: this.o.now() };
    action.inflight.add(open);
    action.sync ??= this.syncFor(action);
    const a = action;
    const gate = action.sync;
    // the duration counts from when the request is actually sent, not from when it waited for the sync
    let started = this.o.now();
    void gate.promise.then(() => (started = this.o.now()));
    let ended = false;
    const end = (result: { status?: number; error?: string } = {}) => {
      if (ended) return;
      ended = true;
      this.o.clearTimer(cap);
      Object.assign(entry, result, { durationMs: this.o.now() - started });
      a.inflight.delete(open);
      if (a.inflight.size === 0) a.settleTimer = this.o.setTimer(() => this.finish(a), this.o.settleMs);
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
    for (const a of this.active) {
      if (a.done || a.inflight.size > 0 || a.settleTimer === undefined) continue;
      this.o.clearTimer(a.settleTimer);
      out.push(this.complete(a));
    }
    return out;
  }

  private newAction(type: string, target: string | undefined, synthetic: boolean): Action {
    const started = this.o.now();
    const info: ActionInfo = { type, target, page: this.o.page(), tab: this.o.tab, startedAt: new Date(started).toISOString(), requests: [] };
    return { info, label: synthetic ? "request" : labelOf(type, target), inflight: new Set(), started, done: false, synthetic };
  }

  /** An action still in progress, apart from requests that have been open for a long time (long-polling). */
  private busy(a: Action): boolean {
    if (a.done) return false;
    if (a.inflight.size === 0) return true; // settling
    const now = this.o.now();
    return [...a.inflight].some((r) => now - r.since < LONG_REQUEST_MS);
  }

  /** Checkpoint before the action's first request, unless another action is still in flight. */
  private syncFor(action: Action): Gate {
    const othersBusy = [...this.active].some((a) => a !== action && this.busy(a));
    this.active.add(action);
    if (!this.o.syncBefore || othersBusy) return this.gate;
    const sync = this.send({ label: "outside actions", source: "sync", dropIfEmpty: true });
    const timeout = new Promise<void>((r) => this.o.setTimer(r, this.o.syncTimeoutMs));
    const gate: Gate = { promise: Promise.race([sync, timeout]), open: false };
    void gate.promise.then(() => (gate.open = true));
    return (this.gate = gate);
  }

  private send(payload: CheckpointPayload): Promise<void> {
    const sent = this.sending.then(() => this.o.send(payload)).catch(() => undefined);
    this.sending = sent;
    return sent;
  }

  private finish(action: Action): void {
    if (action.done || action.inflight.size > 0) return;
    void this.send(this.complete(action));
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
    const readOnly = action.info.requests.every((r) => r.kind === "http" && (r.method === "GET" || r.method === "HEAD"));
    return { label: action.label, source: summarize(action.info.requests), action: action.info, dropIfEmpty: action.synthetic || readOnly };
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
