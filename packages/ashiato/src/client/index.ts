/**
 * Browser-side script injected by the Vite plugin (dev server only). It must run before the app's
 * own code so that fetch / XHR / postMessage are wrapped before anything uses them.
 */
import { hookFetch, hookUserActions, hookWebView, hookXhr, jsonRpc } from "./hooks.js";
import { startReplay, tabId, type ReplayOptions } from "./replay.js";
import { Tracker, type CheckpointPayload } from "./tracker.js";

interface ClientConfig {
  recorder: string;
  settleMs?: number;
  oneWayMs?: number;
  syncBefore?: boolean;
  mergeMs?: number;
  attachMs?: number;
  syncTimeoutMs?: number;
  maxRequestMs?: number;
  /** URL substrings that are never tracked (in addition to the recorder and Vite's own requests). */
  ignore?: string[];
  /** Record the page for screen replay. Default true. */
  replay?: boolean | ReplayOptions;
}

declare global {
  interface Window {
    __ASHIATO__?: ClientConfig;
    __ashiatoInstalled?: boolean;
  }
}

function install(win: Window & typeof globalThis): void {
  const config = win.__ASHIATO__;
  if (!config || win.__ashiatoInstalled) return;
  win.__ashiatoInstalled = true;

  const recorder = config.recorder.replace(/\/$/, "");
  const originalFetch = win.fetch.bind(win);
  let warned = false;
  // when the recorder isn't running, stop calling it for a while instead of on every click
  let downUntil = 0;
  const RETRY_MS = 10_000;

  /** POSTs to the recorder as text/plain: a simple request, so no CORS preflight. */
  const post = async (path: string, body: string, keepalive = false) => {
    if (Date.now() < downUntil) return;
    try {
      const res = await originalFetch(`${recorder}${path}`, { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive });
      if (!res.ok) console.warn(`[ashiato] recorder answered HTTP ${res.status} for ${path}: ${await res.text()}`);
    } catch (e) {
      downUntil = Date.now() + RETRY_MS;
      if (!warned) {
        warned = true;
        console.warn(`[ashiato] recorder not reachable at ${recorder} (${String(e)}). Start it with \`npx ashiato record --db ...\`.`);
      }
    }
  };
  const send = (payload: CheckpointPayload) => post("/api/checkpoint", JSON.stringify(payload));

  const ignoreList = [recorder, "/@vite/", "/@fs/", "/@id/", "/@ashiato/", "/node_modules/", "/__vite", ...(config.ignore ?? [])];
  const ignore = (url: string) => ignoreList.some((s) => url.includes(s));

  const tab = tabId(win);
  const tracker = new Tracker({
    send,
    tab,
    settleMs: config.settleMs,
    oneWayMs: config.oneWayMs,
    syncBefore: config.syncBefore,
    mergeMs: config.mergeMs,
    attachMs: config.attachMs,
    syncTimeoutMs: config.syncTimeoutMs,
    maxRequestMs: config.maxRequestMs,
  });
  hookFetch(win, tracker, ignore);
  hookXhr(win, tracker, ignore);
  hookUserActions(win.document, tracker);
  // WebView2 injects chrome.webview before page scripts run; check again on load just in case.
  if (!hookWebView(win, tracker, jsonRpc)) {
    win.addEventListener("DOMContentLoaded", () => hookWebView(win, tracker, jsonRpc), { once: true });
  }

  // keepalive requests and beacons are limited to 64KB
  const small = (body: string) => new Blob([body]).size < 60_000;
  const beacon = (path: string, body: string) =>
    Date.now() >= downUntil && small(body) && navigator.sendBeacon?.(`${recorder}${path}`, new Blob([body], { type: "text/plain" }));

  // leaving the page (navigation after save, reload): actions only waiting for their settle time
  // would never get their checkpoint, and their changes would show up as "outside actions" later
  win.addEventListener("pagehide", () => {
    for (const payload of tracker.flushSettled()) beacon("/api/checkpoint", JSON.stringify(payload));
  });

  if (config.replay !== false) {
    // batches go out one at a time, in order
    let queue = Promise.resolve();
    const postReplay = (body: string, final: boolean) => {
      if (final && beacon("/api/replay", body)) return;
      queue = queue.then(() => post("/api/replay", body, small(body)));
    };
    startReplay(win, tab, postReplay, typeof config.replay === "object" ? config.replay : {});
  }
}

install(window);
