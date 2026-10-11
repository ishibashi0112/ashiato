/**
 * Browser-side script injected by the Vite plugin (dev server only). It must run before the app's
 * own code so that fetch / XHR / postMessage are wrapped before anything uses them.
 */
import { hookFetch, hookUserActions, hookWebView, hookXhr, jsonRpc } from "./hooks.js";
import { Tracker, type CheckpointPayload } from "./tracker.js";

interface ClientConfig {
  recorder: string;
  settleMs?: number;
  oneWayMs?: number;
  syncBefore?: boolean;
  /** URL substrings that are never tracked (in addition to the recorder and Vite's own requests). */
  ignore?: string[];
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

  const tracker = new Tracker({ send, settleMs: config.settleMs, oneWayMs: config.oneWayMs, syncBefore: config.syncBefore });
  hookFetch(win, tracker, ignore);
  hookXhr(win, tracker, ignore);
  hookUserActions(win.document, tracker);
  // WebView2 injects chrome.webview before page scripts run; check again on load just in case.
  if (!hookWebView(win, tracker, jsonRpc)) {
    win.addEventListener("DOMContentLoaded", () => hookWebView(win, tracker, jsonRpc), { once: true });
  }
}

install(window);
