import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MediaStore } from "../core/media.js";
import type { Session } from "../core/types.js";
import { Browser, BrowserUnavailable, findBrowser, NO_BROWSER, printWithSwitch } from "./browser.js";
import { evidenceWorkbook } from "./excel.js";
import type { Evidence, Screenshot } from "./evidence.js";
import { evidenceHtml } from "./html.js";
import { captureScreens, captureScript, momentsOf } from "./screens.js";
import { langOf, localTime, TEXT, type Lang } from "./text.js";

export type ExportFormat = "xlsx" | "pdf" | "html";
export const EXPORT_FORMATS: ExportFormat[] = ["xlsx", "pdf", "html"];

export interface ExportOptions {
  formats: ExportFormat[];
  /** Language of the document. Default: Japanese on a Japanese machine, English otherwise. */
  lang?: Lang;
  /** Leave out steps that changed no rows. */
  changedOnly?: boolean;
  /** Screenshots of each step from the screen replay or recordings (needs Chrome or Edge). Default true. */
  screens?: boolean;
  /** Chrome / Edge executable. Default: `ASHIATO_BROWSER`, then the usual install locations. */
  browser?: string;
  /** The session's replay and recordings, for screenshots. */
  media?: MediaStore;
  /** Shown in the document. */
  sessionFile?: string;
  log?: (message: string) => void;
}

export interface ExportResult {
  files: Partial<Record<ExportFormat, Buffer>>;
  /** Things the user should know: screenshots that couldn't be taken, a PDF printed without page numbers. */
  notes: string[];
}

/**
 * Evidence of a session's steps as an Excel workbook, a PDF and / or an HTML page. Everything happens
 * on this machine: the PDF and the screenshots are made by a local Chrome / Edge with no network.
 */
export async function exportEvidence(session: Session, options: ExportOptions): Promise<ExportResult> {
  const lang = options.lang ?? langOf();
  const t = TEXT[lang];
  const log = options.log ?? (() => undefined);
  const formats = [...new Set(options.formats)];
  if (formats.length === 0) throw new Error("No export format given");
  // a live session gets new steps while the export runs: take the ones there are now
  const snapshot: Session = { ...session, steps: [...session.steps], videos: session.videos?.map((v) => ({ ...v })) };
  // as the timeline's "Hide steps without changes": tables that came or went are a change too
  const steps = options.changedOnly ? snapshot.steps.filter((s) => s.diff.tables.length > 0 || s.addedTables || s.removedTables) : snapshot.steps;

  const wantScreens =
    options.screens !== false &&
    options.media !== undefined &&
    (options.media.replayPath() !== undefined || (snapshot.videos ?? []).length > 0) &&
    steps.some((s) => momentsOf(s).length > 0);
  const notes: string[] = [];
  let screens = new Map<number, Screenshot[]>();
  let screensNote: string | undefined;

  const temp = mkdtempSync(join(tmpdir(), "ashiato-export-"));
  let browser: Browser | undefined;
  let executable: string | undefined;
  let pipeless = false;
  try {
    if (formats.includes("pdf") || wantScreens) {
      try {
        executable = findBrowser(options.browser);
        if (!executable) throw new Error(`${NO_BROWSER} Excel and HTML exports work without one.`);
        browser = await Browser.launch(executable);
      } catch (e) {
        // the PDF can still be printed without the DevTools pipe; screenshots are a bonus Excel and HTML do without
        if (e instanceof BrowserUnavailable) pipeless = true;
        else if (formats.includes("pdf")) throw e;
        if (wantScreens) screensNote = t.screensMissing((e as Error).message);
      }
    }

    if (wantScreens && browser) {
      const script = captureScript();
      if (!script) {
        screensNote = t.screensMissing("the screenshot script (capture.global.js) is missing; run the build");
      } else {
        const page = join(temp, "capture.html");
        writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
        log("Taking screenshots of the screen replay / recordings…");
        try {
          const result = await captureScreens(browser, snapshot, steps, options.media!, pathToFileURL(page).href, (done, total) => {
            if (done === total || done % 10 === 0) log(`  ${done} / ${total}`);
          });
          screens = result.screens;
          if (result.failed) screensNote = t.screensFailed(result.failed);
        } catch (e) {
          screensNote = t.screensMissing((e as Error).message);
        }
      }
    }
    if (screensNote) notes.push(screensNote);

    const evidence: Evidence = {
      session: snapshot,
      steps,
      lang,
      screens,
      screensNote,
      sessionFile: options.sessionFile,
      exportedAt: new Date().toISOString(),
    };
    const files: ExportResult["files"] = {};
    if (formats.includes("xlsx")) files.xlsx = await evidenceWorkbook(evidence);
    const html = formats.includes("html") || formats.includes("pdf") ? evidenceHtml(evidence) : undefined;
    if (formats.includes("html")) files.html = Buffer.from(html!, "utf8");
    if (formats.includes("pdf")) {
      const file = join(temp, "evidence.html");
      writeFileSync(file, html!);
      const url = pathToFileURL(file).href;
      log("Printing the PDF…");
      if (browser) {
        await browser.page("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
        await browser.goto(url);
        files.pdf = await browser.pdf(`${t.title} · ${localTime(snapshot.startedAt)}`);
      } else if (pipeless && executable) {
        files.pdf = await printWithSwitch(executable, url);
        notes.push(t.noPageNumbers);
      }
    }
    return { files, notes };
  } finally {
    await browser?.close();
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // the browser may still hold a file for a moment (Windows)
    }
  }
}
