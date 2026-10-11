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
  /** Clicks and keys this close together count as one action (e.g. click on a submit button + submit). Default 300ms. */
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
  now?: () => number;
  page?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Action {
  info: ActionInfo;
  label: string;
  pending: number;
  started: number;
  sync?: Promise<void>;
  settleTimer?: unknown;
  done: boolean;
  /** Synthetic actions (requests with no user action) are dropped when nothing changed. */
  synthetic: boolean;
}

export interface RequestHandle {
  /** Resolves when the request may be sent (after the sync checkpoint). */
  ready: Promise<void>;
  end(result?: { status?: number; error?: string }): void;
}

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
  private gate: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<TrackerOptions, "send">> & Pick<TrackerOptions, "send">;

  constructor(options: TrackerOptions) {
    this.o = {
      settleMs: 150,
      oneWayMs: 500,
      mergeMs: 300,
      attachMs: 1000,
      syncBefore: true,
      syncTimeoutMs: 5000,
      now: () => Date.now(),
      page: () => (typeof location === "undefined" ? "" : location.pathname + location.search),
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
    if (cur && !cur.done && !cur.synthetic && now - cur.started < this.o.mergeMs) {
      // e.g. click on <button type=submit> followed by the form's submit event: keep the first, more specific label
      return;
    }
    this.current = this.newAction(type, target, false);
  }

  beginRequest(req: RequestInfo): RequestHandle {
    let action = this.current;
    const stale = action && action.info.requests.length === 0 && this.o.now() - action.started > this.o.attachMs;
    if (!action || action.done || stale) {
      action = this.current = this.newAction("request", undefined, true);
    }
    if (action.settleTimer !== undefined) {
      this.o.clearTimer(action.settleTimer);
      action.settleTimer = undefined;
    }
    const started = this.o.now();
    const entry: RequestInfo = { ...req };
    action.info.requests.push(entry);
    action.pending++;
    action.sync ??= this.syncFor(action);
    const a = action;
    const ready = action.sync;
    let ended = false;
    return {
      ready,
      end: (result = {}) => {
        if (ended) return;
        ended = true;
        Object.assign(entry, result, { durationMs: this.o.now() - started });
        a.pending--;
        if (a.pending === 0) a.settleTimer = this.o.setTimer(() => this.finish(a), this.o.settleMs);
      },
    };
  }

  private newAction(type: string, target: string | undefined, synthetic: boolean): Action {
    const started = this.o.now();
    const info: ActionInfo = { type, target, page: this.o.page(), startedAt: new Date(started).toISOString(), requests: [] };
    const label = synthetic ? "request" : target ? `${type} ${target}` : type;
    return { info, label, pending: 0, started, done: false, synthetic };
  }

  /** Checkpoint before the action's first request, unless another action is still in flight. */
  private syncFor(action: Action): Promise<void> {
    const othersBusy = [...this.active].some((a) => a !== action && !a.done);
    this.active.add(action);
    if (!this.o.syncBefore || othersBusy) return this.gate;
    const sync = this.send({ label: "outside actions", source: "sync", dropIfEmpty: true });
    const timeout = new Promise<void>((r) => this.o.setTimer(r, this.o.syncTimeoutMs));
    return (this.gate = Promise.race([sync, timeout]));
  }

  private send(payload: CheckpointPayload): Promise<void> {
    const sent = this.sending.then(() => this.o.send(payload)).catch(() => undefined);
    this.sending = sent;
    return sent;
  }

  private finish(action: Action): void {
    if (action.done || action.pending > 0) return;
    action.done = true;
    action.settleTimer = undefined;
    this.active.delete(action);
    if (action.synthetic && action.info.requests.length === 1) {
      const r = action.info.requests[0]!;
      action.label = r.kind === "http" ? `${r.method} ${r.url ?? ""}`.trim() : r.method;
    }
    const source = summarize(action.info.requests);
    void this.send({ label: action.label, source, action: action.info, dropIfEmpty: action.synthetic });
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
