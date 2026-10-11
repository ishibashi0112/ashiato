import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export interface AshiatoViteOptions {
  /** URL of the running `ashiato record` server. Default http://127.0.0.1:4100 (or ASHIATO_RECORDER_URL). */
  recorder?: string;
  /** Quiet time after an action's last request before its checkpoint. Default 150ms. */
  settleMs?: number;
  /** Wait after a postMessage that gets no reply. Default 500ms. */
  oneWayMs?: number;
  /** Checkpoint before each action's first request so outside changes aren't attributed to it. Default true. */
  syncBefore?: boolean;
  /** URL substrings never tracked (e.g. a long-polling endpoint). */
  ignore?: string[];
  /** Events this close together, before any request, count as one action. Default 300ms. */
  mergeMs?: number;
  /** A request starting this long after a click without other requests no longer belongs to it. Default 1000ms. */
  attachMs?: number;
  /** Longest wait for the checkpoint taken before an action's first request. Default 5000ms. */
  syncTimeoutMs?: number;
  /** A request still open after this long is recorded as "no reply" so its action gets a checkpoint. Default 30000ms. */
  maxRequestMs?: number;
  /**
   * Record the page (DOM, not pixels) so the timeline can replay the screen around each action.
   * Passwords are always masked; `{ maskAllInputs: true }` masks every input. Default true.
   */
  replay?: boolean | { maskAllInputs?: boolean };
  /** Set to false to turn the plugin off (also: ASHIATO=0). */
  enabled?: boolean;
}

function clientCode(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of [join(here, "client.global.js"), join(here, "../../dist/client.global.js")]) {
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new Error("ashiato: client script not found. Run `pnpm build` in the ashiato package.");
}

const CLIENT_PATH = "@ashiato/client.js";

/**
 * Vite plugin (dev server only): records each user action in the browser together with the
 * requests it triggered, and asks the ashiato recorder for a checkpoint when they finish.
 */
export default function ashiato(options: AshiatoViteOptions = {}): Plugin {
  const enabled = options.enabled ?? process.env.ASHIATO !== "0";
  const config = {
    recorder: options.recorder ?? process.env.ASHIATO_RECORDER_URL ?? "http://127.0.0.1:4100",
    settleMs: options.settleMs,
    oneWayMs: options.oneWayMs,
    syncBefore: options.syncBefore,
    mergeMs: options.mergeMs,
    attachMs: options.attachMs,
    syncTimeoutMs: options.syncTimeoutMs,
    maxRequestMs: options.maxRequestMs,
    ignore: options.ignore,
    replay: options.replay,
  };
  let code: string | undefined;
  let base = "/";

  return {
    name: "ashiato",
    apply: "serve",
    configResolved(resolved) {
      base = resolved.base.endsWith("/") ? resolved.base : `${resolved.base}/`;
    },
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== `${base}${CLIENT_PATH}`) return next();
        code ??= clientCode();
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(code);
      });
    },
    transformIndexHtml() {
      if (!enabled) return;
      code ??= clientCode(); // fail early and clearly if the package wasn't built
      // First in <head>, as classic (blocking) scripts: they run before the app's modules, so
      // fetch / XHR / postMessage are wrapped before the app touches them. The script itself is
      // served from the dev server (CSP 'self'), keeping <meta charset> within the first bytes.
      const json = JSON.stringify(config).replace(/</g, "\\u003c");
      return [
        { tag: "script", attrs: { "data-ashiato": "" }, children: `window.__ASHIATO__=${json};`, injectTo: "head-prepend" },
        { tag: "script", attrs: { src: `${base}${CLIENT_PATH}`, "data-ashiato": "" }, injectTo: "head-prepend" },
      ];
    },
  };
}

export { ashiato };
