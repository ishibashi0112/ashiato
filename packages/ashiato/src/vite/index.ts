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
  /** URL substrings never tracked. */
  ignore?: string[];
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
    ignore: options.ignore,
  };
  let code: string | undefined;

  return {
    name: "ashiato",
    apply: "serve",
    transformIndexHtml() {
      if (!enabled) return;
      code ??= clientCode();
      // Inline and first in <head>: a classic script runs before the app's modules,
      // so fetch / XHR / postMessage are wrapped before the app touches them.
      const children = `window.__ASHIATO__=${JSON.stringify(config)};\n${code}`.replace(/<\/script/gi, "<\\/script");
      return [{ tag: "script", attrs: { "data-ashiato": "" }, children, injectTo: "head-prepend" }];
    },
  };
}

export { ashiato };
