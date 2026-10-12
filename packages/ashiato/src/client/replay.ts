import { record } from "rrweb";
import { CHANGE_EVENT, DIALOG_EVENT, KEY_EVENT, RESNAPSHOT_EVENT } from "./events.js";

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
    // as a checkout: the same page, not a page load
    record.takeFullSnapshot(true);
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
    emit(event, isCheckout) {
      // a snapshot taken again of the same page: say so before it (its meta event comes first)
      if (isCheckout && event.type === META) buffer.push({ type: CUSTOM, timestamp: event.timestamp, data: { tag: RESNAPSHOT_EVENT, payload: {} } });
      buffer.push(event);
      if (buffer.length >= FLUSH_EVENTS) flush();
    },
    maskAllInputs: options.maskAllInputs ?? false,
    // a fresh full snapshot now and then keeps seeking in long single-page sessions fast
    checkoutEveryNms: 5 * 60_000,
    // fewer mouse-move and scroll events; clicks and inputs are always recorded, inputs as they are
    // typed (a test generated from the replay types them where the user did, as in a search box)
    sampling: { mousemove: 50, scroll: 150 },
    errorHandler: () => true,
    // tests generated from the replay leave out values the app set itself
    userTriggeredOnInput: true,
  });
  recordForTests(win, options.maskAllInputs ?? false);
  win.setInterval(() => flush(), FLUSH_MS);
  win.addEventListener("pagehide", () => flush(true));
  win.document.addEventListener("visibilitychange", () => {
    if (win.document.visibilityState === "hidden") flush(true);
  });
}

const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "hidden"]);
/** Inputs a test tool fills by setting the value from a script (Playwright's fill() on a date field), as a component may too. */
const SET_BY_SCRIPT = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);
const META = 4;
const CUSTOM = 5;

/**
 * Records the answers to alert / confirm / prompt (a test has to give the same ones), Enter
 * presses (they submit forms) and options picked by a script, as custom replay events.
 */
function recordForTests(win: Window, mask: boolean): void {
  const add = (tag: string, payload: unknown) => {
    try {
      record.addCustomEvent(tag, payload);
    } catch {
      // not recording
    }
  };
  for (const type of ["alert", "confirm", "prompt"] as const) {
    const original = win[type] as (...args: unknown[]) => unknown;
    if (typeof original !== "function") continue;
    win[type] = function (this: unknown, ...args: unknown[]) {
      const answer = original.apply(this, args);
      const masked = mask && typeof answer === "string" ? "*".repeat(answer.length) : answer;
      add(DIALOG_EVENT, { type, message: String(args[0] ?? ""), ...(type === "alert" ? {} : { answer: masked }) });
      return answer;
    } as never;
  }
  win.document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.isComposing || !e.isTrusted) return;
      const target = e.target as HTMLInputElement | null;
      // not in the replay (rrweb's block class)
      if (!target || target.closest?.(".rr-block")) return;
      // the field's value: rrweb gets it from the change event that comes after the key, and masks it as rrweb does
      // (a password field shown as text by a "show password" button is still one), or leaves it out (ignore class)
      const field = target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && !NOT_TEXT.has(target.type));
      const secret = mask || target.type === "password" || target.hasAttribute("data-rr-is-password");
      const value = field && !target.classList.contains("rr-ignore") ? (secret ? "*".repeat(target.value.length) : target.value) : undefined;
      add(KEY_EVENT, { key: "Enter", id: record.mirror.getId(target as Node), ...(value !== undefined ? { value } : {}) });
    },
    true,
  );
  win.document.addEventListener(
    "change",
    (e) => {
      const target = e.target as HTMLInputElement | null;
      if (e.isTrusted || !target) return;
      if (target.tagName === "SELECT" || (target.tagName === "INPUT" && SET_BY_SCRIPT.has(target.type))) add(CHANGE_EVENT, { id: record.mirror.getId(target) });
    },
    true,
  );
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
