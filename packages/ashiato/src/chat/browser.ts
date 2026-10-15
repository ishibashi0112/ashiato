import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { findBrowser } from "../export/browser.js";

/**
 * The browser `ashiato pack` and `verify --auto` drive, through Playwright (an optional peer
 * dependency: `npm install -D @playwright/test`). Playwright's own Chromium when it is installed,
 * else the Chrome or Edge on this machine (every Windows has Edge), so nothing has to be downloaded.
 * Or, with `cdp`, a browser already running: the WebView2 in a desktop app started with
 * `--remote-debugging-port`.
 */
export interface BrowserOptions {
  /** Chrome / Edge to start (or ASHIATO_BROWSER). */
  browser?: string;
  /** Show the browser. */
  headed?: boolean;
  /** Connect to a running browser or WebView2 over the DevTools protocol instead (`http://127.0.0.1:9222`). */
  cdp?: string;
  /** The app's URL: relative paths are opened from here. */
  app?: string;
  /** A login saved with `--login` (Playwright's storage state). */
  storageState?: string;
}

interface Playwright {
  chromium: {
    launch(options: { headless?: boolean; executablePath?: string }): Promise<Browser>;
    connectOverCDP(url: string): Promise<Browser>;
    executablePath(): string;
  };
}

/** Playwright, from @playwright/test (a peer dependency) or playwright / playwright-core. */
export async function loadPlaywright(what: string): Promise<Playwright> {
  const errors: string[] = [];
  for (const pkg of ["@playwright/test", "playwright", "playwright-core"]) {
    try {
      const mod = (await import(pkg)) as Partial<Playwright> & { default?: Partial<Playwright> };
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium } as Playwright;
    } catch (e) {
      errors.push(`${pkg}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`${what} needs Playwright. Install it with: npm install -D @playwright/test\n(${errors.join("; ")})`);
}

/** A page to drive, and how to let it go. */
export interface Driven {
  page: Page;
  context: BrowserContext;
  /** Closes what was started here (a browser connected to over `cdp` is left running). */
  close(): Promise<void>;
}

export async function openBrowser(what: string, options: BrowserOptions): Promise<Driven> {
  const pw = await loadPlaywright(what);
  if (options.cdp) {
    const browser = await pw.chromium.connectOverCDP(options.cdp).catch((e: Error) => {
      throw new Error(`Could not connect to ${options.cdp}: ${e.message.split("\n")[0]}. Start the browser or the desktop app with --remote-debugging-port (WebView2: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222).`);
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages().find((p) => !p.url().startsWith("devtools:")) ?? (await context.newPage());
    // leave the app's own browser running: only this connection ends
    return { page, context, close: async () => void (await browser.close().catch(() => undefined)) };
  }
  const browser = await pw.chromium.launch({ headless: !options.headed, executablePath: executable(pw, options.browser) });
  const context = await browser.newContext({
    ...(options.app ? { baseURL: options.app } : {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  const page = await context.newPage();
  return { page, context, close: () => browser.close() };
}

/** `--browser` / ASHIATO_BROWSER, else Playwright's Chromium if installed, else Chrome / Edge on this machine. */
function executable(pw: Playwright, explicit = process.env.ASHIATO_BROWSER): string | undefined {
  if (explicit) return findBrowser(explicit);
  let own: string | undefined;
  try {
    own = pw.chromium.executablePath();
  } catch {
    // not installed
  }
  if (own && existsSync(own)) return undefined;
  const found = findBrowser("");
  if (!found) throw new Error("No browser found: install Playwright's Chromium (npx playwright install chromium), or set ASHIATO_BROWSER to Chrome or Edge.");
  return found;
}

/** Where a login is kept unless `--storage-state` says otherwise. */
export const DEFAULT_LOGIN = ".ashiato/login.json";

/**
 * Opens the app in a browser for the person to log in, and saves the login (cookies and storage) for
 * later runs. `waitForPerson` resolves once they say they're done.
 */
export async function saveLogin(options: BrowserOptions & { app: string; file: string; waitForPerson: () => Promise<unknown> }): Promise<void> {
  const driven = await openBrowser("--login", { ...options, headed: true, storageState: undefined });
  try {
    await driven.page.goto(options.app);
    await options.waitForPerson();
    const file = resolve(options.file);
    mkdirSync(dirname(file), { recursive: true });
    await driven.context.storageState({ path: file });
  } finally {
    await driven.close();
  }
}

/** A path of the app, or a URL, as a URL. */
export function appUrl(target: string, app: string | undefined, current: string): string {
  try {
    return new URL(target, app ?? (current.startsWith("http") ? current : undefined)).href;
  } catch {
    throw new Error(`"${target}" is not a URL: give the app's URL with --app to open paths of it`);
  }
}
