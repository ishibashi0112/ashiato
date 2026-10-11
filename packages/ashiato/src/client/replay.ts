import { record } from "rrweb";

export interface ReplayOptions {
  /** Mask the value of every input (passwords are always masked). Default false. */
  maskAllInputs?: boolean;
}

/**
 * Sends a JSON body to the recorder. `final` is set while the page is going away. Resolves to the
 * recorder's reply, or undefined when there is none (not reachable, or sent as a beacon).
 */
type Post = (body: string, final: boolean) => Promise<{ snapshot?: boolean } | undefined>;

const FLUSH_MS = 1000;
const FLUSH_EVENTS = 500;
/** An idle page still checks in this often, so a recorder started meanwhile gets its full snapshot before the next action. */
const HEARTBEAT_MS = 5000;
/** Full snapshots the recorder asks for are taken at most this often at first, then less and less often while it keeps asking. */
const SNAPSHOT_GAP_MS = 10_000;
const MAX_SNAPSHOT_GAP_MS = 10 * 60_000;

/**
 * Records the page as rrweb DOM events (not pixels) and sends them to the recorder in batches,
 * so the timeline can replay what the screen looked like around each action.
 */
export function startReplay(win: Window, tab: string, post: Post, options: ReplayOptions = {}): void {
  let buffer: unknown[] = [];
  // the recorder (re)started after this page loaded has none of its full snapshots: it asks for one.
  // Batches sent before the snapshot was taken still get that answer, so they don't count.
  let sent = 0;
  let snapshotBatch = -1;
  let nextSnapshot = 0;
  let gap = SNAPSHOT_GAP_MS;
  const onReply = (batch: number, reply: { snapshot?: boolean } | undefined) => {
    if (!reply) return;
    if (!reply.snapshot) return void (gap = SNAPSHOT_GAP_MS);
    if (batch < snapshotBatch || Date.now() < nextSnapshot) return;
    // goes into the next batch
    snapshotBatch = sent;
    nextSnapshot = Date.now() + gap;
    gap = Math.min(gap * 2, MAX_SNAPSHOT_GAP_MS);
    record.takeFullSnapshot();
  };
  let lastPost = 0;
  const flush = (final = false) => {
    if (buffer.length === 0 && (final || Date.now() - lastPost < HEARTBEAT_MS)) return;
    const body = JSON.stringify({ tab, events: buffer });
    buffer = [];
    lastPost = Date.now();
    const batch = sent++;
    void post(body, final).then((reply) => onReply(batch, reply), () => undefined);
  };
  record({
    emit(event) {
      buffer.push(event);
      if (buffer.length >= FLUSH_EVENTS) flush();
    },
    maskAllInputs: options.maskAllInputs ?? false,
    // a fresh full snapshot now and then keeps seeking in long single-page sessions fast
    checkoutEveryNms: 5 * 60_000,
    // fewer mouse-move and scroll events; clicks and inputs are always recorded
    sampling: { mousemove: 50, scroll: 150, input: "last" },
    errorHandler: () => true,
  });
  win.setInterval(() => flush(), FLUSH_MS);
  win.addEventListener("pagehide", () => flush(true));
  win.document.addEventListener("visibilitychange", () => {
    if (win.document.visibilityState === "hidden") flush(true);
  });
}

const TAB_KEY = "__ashiato_tab";

/**
 * A per-tab id that survives reloads of the same tab, so its replay continues across page loads.
 * A frame `nested` in a page that runs this script too is part of that page's replay: it shares
 * the page's id (same origin, same sessionStorage) and only reads it.
 */
export function tabId(win: Window, nested = false): string {
  const make = () => Math.random().toString(36).slice(2, 10);
  try {
    const storage = win.sessionStorage;
    const read = (): { id?: string; alive?: boolean } => {
      try {
        const value = JSON.parse(storage.getItem(TAB_KEY) ?? "{}") as unknown;
        return typeof value === "object" && value ? value : {};
      } catch {
        return {};
      }
    };
    const saved = read();
    if (nested) return saved.id ?? make();
    // A popup (window.open) or a duplicated tab starts with a copy of this tab's sessionStorage. The
    // copy says the page that wrote it is still open, which is never so after a reload: take a new id.
    const id = saved.id && !saved.alive ? saved.id : make();
    const mark = (alive: boolean) => storage.setItem(TAB_KEY, JSON.stringify({ id, alive }));
    mark(true);
    win.addEventListener("pagehide", () => mark(false));
    // back to this page from the back/forward cache
    win.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && mark(true));
    return id;
  } catch {
    return make();
  }
}
