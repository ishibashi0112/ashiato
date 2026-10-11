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

  const send = async (payload: CheckpointPayload) => {
    try {
      const res = await originalFetch(`${recorder}/api/checkpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn(`[ashiato] recorder not reachable at ${recorder} (${String(e)}). Start it with \`npx ashiato record --db ...\`.`);
      }
    }
  };

  const ignoreList = [recorder, "/@vite/", "/@fs/", "/@id/", "/node_modules/", "/__vite", ...(config.ignore ?? [])];
  const ignore = (url: string) => ignoreList.some((s) => url.includes(s));

  const tab = tabId(win);
  const tracker = new Tracker({ send, tab, settleMs: config.settleMs, oneWayMs: config.oneWayMs, syncBefore: config.syncBefore });
  hookFetch(win, tracker, ignore);
  hookXhr(win, tracker, ignore);
  hookUserActions(win.document, tracker);
  // WebView2 injects chrome.webview before page scripts run; check again on load just in case.
  if (!hookWebView(win, tracker, jsonRpc)) {
    win.addEventListener("DOMContentLoaded", () => hookWebView(win, tracker, jsonRpc), { once: true });
  }

  if (config.replay !== false) {
    const url = `${recorder}/api/replay`;
    // text/plain keeps these simple requests (no CORS preflight); batches go out one at a time, in order
    let queue = Promise.resolve();
    const post = (body: string, final: boolean) => {
      // keepalive requests and beacons are limited to 64KB
      const small = new Blob([body]).size < 60_000;
      if (final && small && navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) return;
      queue = queue
        .then(() => originalFetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive: small }))
        .then(() => undefined, () => undefined);
    };
    startReplay(win, tab, post, typeof config.replay === "object" ? config.replay : {});
  }
}

install(window);
