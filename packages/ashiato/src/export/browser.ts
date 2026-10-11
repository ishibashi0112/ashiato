import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Drives a locally installed Chrome or Edge (headless, over the DevTools pipe) to print the evidence
 * as PDF and take screenshots of screen replays. The browser gets a throwaway profile and no network
 * except localhost, so nothing leaves the machine.
 */

/** Chrome / Edge / Chromium installed on this machine: `ASHIATO_BROWSER`, then the usual places. */
export function findBrowser(explicit = process.env.ASHIATO_BROWSER): string | undefined {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Browser not found: ${explicit}`);
    return explicit;
  }
  const env = process.env;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    // Edge first: every Windows machine running WebView2 apps has it
    for (const r of roots) candidates.push(join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
    for (const r of roots) candidates.push(join(r, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (process.platform === "darwin") {
    for (const app of ["Google Chrome", "Microsoft Edge", "Chromium"]) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      if (env.HOME) candidates.push(join(env.HOME, `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
    for (const name of names) for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(dir, name));
  }
  return candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile());
}

export const NO_BROWSER = "No Chrome or Edge was found. Set ASHIATO_BROWSER to the browser's executable.";

/** Flags shared by every launch: a clean, quiet browser that can only reach localhost. */
function baseArgs(profile: string): string[] {
  return [
    "--headless",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--no-pings",
    "--mute-audio",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    // no network: no proxy, and every host name fails to resolve except localhost
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    // as Playwright does: Linux distributions (and root, in containers) often can't run the sandbox
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ];
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** A headless browser and one page, spoken to over the DevTools protocol pipe. */
export class Browser {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(msg: { method: string; sessionId?: string; params: Record<string, unknown> }) => void>();
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private exited?: Error;
  private sessionId?: string;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly profile: string,
  ) {
    const output = proc.stdio[4] as Readable | null;
    output?.on("data", (chunk: Buffer) => this.receive(chunk));
    output?.on("error", () => undefined);
    (proc.stdio[3] as Writable | null)?.on("error", () => undefined);
    proc.stderr?.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    proc.on("exit", (code) => {
      this.exited = new Error(`The browser exited (code ${code}).${this.stderr ? ` ${lastLines(this.stderr)}` : ""}`);
      for (const p of this.pending.values()) clearTimeout(p.timer), p.reject(this.exited);
      this.pending.clear();
    });
  }

  /** Starts the browser and opens a blank page. */
  static async launch(executable: string, startTimeoutMs = 20_000): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), "ashiato-browser-"));
    const proc = spawn(executable, [...baseArgs(profile), "--remote-debugging-pipe", "about:blank"], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const browser = new Browser(proc, profile);
    try {
      await new Promise<void>((resolve, reject) => {
        proc.once("error", (e) => reject(new Error(`Could not start the browser ${executable}: ${e.message}`)));
        proc.once("spawn", resolve);
      });
      await browser.send("Browser.getVersion", {}, startTimeoutMs).catch((e: Error) => {
        // still running but silent: the pipe is ignored (remote debugging turned off by a policy)
        if (browser.exited) throw browser.exited;
        throw new BrowserUnavailable(`The browser did not answer over its DevTools pipe (${e.message}). Remote debugging may be turned off by a policy.`);
      });
      const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      const { sessionId } = (await browser.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      browser.sessionId = sessionId;
      await browser.page("Page.enable");
      await browser.page("Runtime.enable");
      return browser;
    } catch (e) {
      // it didn't start properly: no need to ask it to close
      await browser.close(false);
      throw e;
    }
  }

  /** Sends a command to the browser. */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      (this.proc.stdio[3] as Writable).write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Sends a command to the page. */
  page(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.send(method, params, timeoutMs, this.sessionId);
  }

  /** Loads a URL in the page and waits for its load event. */
  async goto(url: string, timeoutMs = 120_000): Promise<void> {
    const loaded = this.waitFor("Page.loadEventFired", timeoutMs);
    const nav = (await this.page("Page.navigate", { url }, timeoutMs)) as { errorText?: string };
    if (nav.errorText) throw new Error(`Could not open ${url}: ${nav.errorText}`);
    await loaded;
  }

  /** Runs a JavaScript expression in the page (awaiting a promise) and returns its JSON value. */
  async evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    const r = (await this.page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs)) as {
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** A JPEG of the top left `width` x `height` pixels of the page. */
  async screenshot(width: number, height: number, quality = 80): Promise<Buffer> {
    await this.page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const { data } = (await this.page("Page.captureScreenshot", { format: "jpeg", quality, clip: { x: 0, y: 0, width, height, scale: 1 } })) as { data: string };
    return Buffer.from(data, "base64");
  }

  /** Prints the loaded page as PDF, with page numbers in the footer. */
  async pdf(footer: string): Promise<Buffer> {
    const { stream } = (await this.page(
      "Page.printToPDF",
      {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate:
          `<div style="font-size:7pt;width:100%;padding:0 10mm;color:#78716c;display:flex;justify-content:space-between">` +
          `<span>${footer.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
        transferMode: "ReturnAsStream",
      },
      300_000,
    )) as { stream: string };
    const parts: Buffer[] = [];
    for (;;) {
      const chunk = (await this.page("IO.read", { handle: stream, size: 1 << 20 })) as { data: string; base64Encoded?: boolean; eof: boolean };
      parts.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
      if (chunk.eof) break;
    }
    await this.page("IO.close", { handle: stream }).catch(() => undefined);
    return Buffer.concat(parts);
  }

  async close(graceful = true): Promise<void> {
    // pid is undefined when the executable could not be started at all
    if (!this.exited && this.proc.pid !== undefined) {
      const exited = new Promise((r) => this.proc.once("exit", r));
      if (graceful) await this.send("Browser.close", {}, 3000).catch(() => undefined);
      if (!this.exited) {
        if (!graceful) this.proc.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      }
      if (!this.exited) this.proc.kill("SIGKILL");
    }
    removeProfile(this.profile);
  }

  private waitFor(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`${method} did not arrive within ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (msg: { method: string; sessionId?: string }) => {
        if (msg.method !== method || msg.sessionId !== this.sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
    });
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let end = this.buffer.indexOf(0); end >= 0; end = this.buffer.indexOf(0)) {
      const text = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      let msg: { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
      try {
        msg = JSON.parse(text);
      } catch {
        continue;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const l of [...this.listeners]) l({ method: msg.method, sessionId: msg.sessionId, params: msg.params ?? {} });
      }
    }
  }
}

/** The browser started but can't be driven (remote debugging turned off by a policy). */
export class BrowserUnavailable extends Error {}

/**
 * Prints an HTML file to PDF with the browser's own `--print-to-pdf` switch, which needs no
 * DevTools connection. Used when the DevTools pipe is not available: no page numbers.
 */
export async function printWithSwitch(executable: string, htmlUrl: string, timeoutMs = 300_000): Promise<Buffer> {
  const profile = mkdtempSync(join(tmpdir(), "ashiato-browser-"));
  const out = join(profile, "evidence.pdf");
  try {
    const proc = spawn(executable, [...baseArgs(profile), `--print-to-pdf=${out}`, "--no-pdf-header-footer", "--print-to-pdf-no-header", htmlUrl], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Printing to PDF timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      proc.once("error", (e) => (clearTimeout(timer), reject(e)));
      proc.once("exit", () => (clearTimeout(timer), resolve()));
    });
    if (!existsSync(out)) throw new Error(`The browser did not write a PDF.${stderr ? ` ${lastLines(stderr)}` : ""}`);
    return readFileSync(out);
  } finally {
    removeProfile(profile);
  }
}

/** The browser may hold files in its profile for a moment after exiting (Windows). */
function removeProfile(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // a leftover temp folder is not worth failing the export for
  }
}

const lastLines = (s: string) => s.trim().split("\n").slice(-3).join(" ").slice(0, 600);
