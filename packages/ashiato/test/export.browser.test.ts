/**
 * PDF export with a real Chromium (the one playwright-core uses), as Chrome / Edge would print it.
 * The screenshots of replays and recordings are covered by the browser test of the Vite plugin.
 */
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Browser, BrowserUnavailable, findBrowser, printWithSwitch } from "../src/export/browser.js";
import { exportEvidence } from "../src/export/index.js";
import { sampleSession } from "./fixtures/session.js";

const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
const browserPath = chromium?.executablePath();
const canRun = Boolean(browserPath && existsSync(browserPath));
if (process.env.ASHIATO_REQUIRE_E2E && !canRun) throw new Error(`PDF export test cannot run: chromium=${browserPath ?? "missing"}`);

const pages = (pdf: Buffer) => Number(/\/Type\s*\/Pages[^>]*?\/Count (\d+)/.exec(pdf.toString("latin1"))?.[1] ?? /\/Count (\d+)/.exec(pdf.toString("latin1"))?.[1]);

describe.skipIf(!canRun)("PDF export", () => {
  it("prints a summary page and a page per step", async () => {
    const { files, notes } = await exportEvidence(sampleSession(), { formats: ["pdf"], lang: "ja", browser: browserPath });
    expect(notes).toEqual([]);
    expect(files.pdf!.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pages(files.pdf!)).toBe(6);
  }, 60_000);

  it("prints without the DevTools pipe when a policy turns remote debugging off", async () => {
    // a browser that ignores --remote-debugging-pipe: it starts but never answers on the pipe
    const dir = mkdtempSync(join(tmpdir(), "ashiato-pdf-"));
    const silent = join(dir, "silent-browser.sh");
    writeFileSync(silent, `#!/bin/sh\ncase "$*" in *--remote-debugging-pipe*) exec sleep 30;; esac\nexec "${browserPath}" "$@"\n`);
    chmodSync(silent, 0o755);
    await expect(Browser.launch(silent, 1000)).rejects.toBeInstanceOf(BrowserUnavailable);

    const html = join(dir, "page.html");
    writeFileSync(html, "<!doctype html><meta charset=utf-8><style>@page { size: A4 landscape }</style><h1>証跡</h1>");
    const pdf = await printWithSwitch(silent, pathToFileURL(html).href);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pages(pdf)).toBe(1);
  }, 60_000);

  it("reports a browser that exits instead of starting", async () => {
    // node rejects the browser's command line flags and exits
    await expect(Browser.launch(process.execPath)).rejects.toThrow(/The browser exited/);
  });

  it("finds the browser it is pointed to, and says when it isn't there", () => {
    expect(findBrowser(browserPath)).toBe(browserPath);
    expect(() => findBrowser("/no/such/chrome")).toThrow("Browser not found: /no/such/chrome");
  });
});
