import { record } from "rrweb";

export interface ReplayOptions {
  /** Mask the value of every input (passwords are always masked). Default false. */
  maskAllInputs?: boolean;
}

/** Sends a JSON body to the recorder. `final` is set while the page is going away. */
type Post = (body: string, final: boolean) => void;

const FLUSH_MS = 1000;
const FLUSH_EVENTS = 500;

/**
 * Records the page as rrweb DOM events (not pixels) and sends them to the recorder in batches,
 * so the timeline can replay what the screen looked like around each action.
 */
export function startReplay(win: Window, tab: string, post: Post, options: ReplayOptions = {}): void {
  let buffer: unknown[] = [];
  const flush = (final = false) => {
    if (buffer.length === 0) return;
    const body = JSON.stringify({ tab, events: buffer });
    buffer = [];
    post(body, final);
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

/** A per-tab id that survives reloads of the same tab, so its replay continues across page loads. */
export function tabId(win: Window): string {
  const make = () => Math.random().toString(36).slice(2, 10);
  try {
    const existing = win.sessionStorage.getItem("__ashiato_tab");
    if (existing) return existing;
    const id = make();
    win.sessionStorage.setItem("__ashiato_tab", id);
    return id;
  } catch {
    return make();
  }
}
