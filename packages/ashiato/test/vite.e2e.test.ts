/**
 * Real browser + real Vite dev server + real recorder: clicks in the page must turn into
 * checkpoints that contain exactly the rows each click changed.
 * Needs the built client (`pnpm build`) and a Chromium for playwright-core.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { connect } from "../src/adapters/index.js";
import { MediaStore } from "../src/core/media.js";
import { exportEvidence } from "../src/export/index.js";
import { Recorder } from "../src/core/recorder.js";
import type { Step } from "../src/core/types.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import ashiato from "../src/vite/index.js";
import { createAppDb } from "./helpers.js";

const clientBuilt = existsSync(fileURLToPath(new URL("../dist/client.global.js", import.meta.url)));
const uiDir = fileURLToPath(new URL("../dist/ui", import.meta.url));
const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
const browserPath = chromium?.executablePath();
const canRun = clientBuilt && existsSync(join(uiDir, "index.html")) && browserPath && existsSync(browserPath);
if (process.env.ASHIATO_REQUIRE_E2E && !canRun) {
  throw new Error(`Browser test cannot run: client built=${clientBuilt}, chromium=${browserPath ?? "missing"}`);
}

describe.skipIf(!canRun)("Vite plugin in a real browser", () => {
  let browser: Browser;
  let page: Page;
  let vite: ViteDevServer;
  let recorder: Recorder;
  let recorderUrl: string;
  let serverOptions: ServerOptions;
  let sessionFile: string;
  const closers: (() => Promise<unknown>)[] = [];
  const app = createAppDb();

  beforeAll(async () => {
    const adapter = await connect(`sqlite:${app.file}`);
    recorder = new Recorder(adapter);
    const session = await recorder.start();
    sessionFile = join(mkdtempSync(join(tmpdir(), "ashiato-e2e-")), "session.json");
    const media = new MediaStore(sessionFile, session);
    serverOptions = {
      port: 0,
      uiDir,
      getSession: () => session,
      checkpoint: (l, s, o) => recorder.checkpoint(l, s, o),
      onStep: (listener) => {
        recorder.on("step", listener);
        return () => recorder.off("step", listener);
      },
      media,
      browser: browserPath,
    };
    const rec = await startServer(serverOptions);
    recorderUrl = `http://127.0.0.1:${(rec.address() as AddressInfo).port}`;
    closers.push(() => adapter.close(), () => new Promise((r) => rec.close(r)));

    vite = await createServer({
      root: fileURLToPath(new URL("./fixtures/app", import.meta.url)),
      logLevel: "silent",
      // the app allows only its own scripts: the client and its config must not need an inline script
      server: { port: 0, host: "127.0.0.1", headers: { "Content-Security-Policy": "script-src 'self'" } },
      plugins: [
        ashiato({ recorder: recorderUrl, settleMs: 50 }),
        {
          name: "fixture-api",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              const send = (body: unknown) => {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(body));
              };
              if (req.url === "/api/orders" && req.method === "POST") {
                app.db.exec("INSERT INTO orders (id, customer_id, qty, updated_at) VALUES (1, 7, 10, 'now'); UPDATE stock SET qty = qty - 10 WHERE item_id = 3");
                return send({ id: 1 });
              }
              if (req.url === "/api/orders" && req.method === "GET") return send(app.db.prepare("SELECT * FROM orders").all());
              if (req.url === "/api/orders/1" && req.method === "DELETE") {
                app.db.exec("DELETE FROM orders WHERE id = 1");
                return send({ ok: true });
              }
              if (req.url === "/api/rpc" && req.method === "POST") {
                app.db.exec("INSERT INTO orders (id, customer_id, qty, updated_at) VALUES (2, 8, 1, 'now')");
                return send({ ok: true });
              }
              if (req.url === "/api/items" && req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => (body += chunk));
                req.on("end", () => {
                  const { id } = JSON.parse(body) as { id: number };
                  app.db.prepare("INSERT OR IGNORE INTO orders (id, customer_id, qty, updated_at) VALUES (?, 9, 1, 'now')").run(id);
                  send({ id });
                });
                return;
              }
              if (req.url === "/api/slow") return void setTimeout(() => send({ ok: true }), 2000);
              next();
            });
          },
        },
      ],
    });
    await vite.listen();
    closers.push(() => vite.close());

    browser = await chromium!.launch();
    closers.push(() => browser.close());
    page = await browser.newPage();
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as unknown as { cspViolations: string[] }).cspViolations = violations;
      document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    // A stand-in for WebView2's chrome.webview: forwards JSON-RPC calls to the fixture backend.
    // Runs before the page (and before ashiato's script), like the real one.
    await page.addInitScript(() => {
      const listeners: ((e: { data: unknown }) => void)[] = [];
      const fetch0 = window.fetch.bind(window);
      (window as unknown as { chrome: unknown }).chrome = {
        webview: {
          addEventListener: (_: string, l: (e: { data: unknown }) => void) => listeners.push(l),
          postMessage: async (m: { id: number }) => {
            await fetch0("/api/rpc", { method: "POST" });
            for (const l of listeners) l({ data: { jsonrpc: "2.0", id: m.id, result: { ok: true } } });
          },
        },
      };
    });
    await page.goto(vite.resolvedUrls!.local[0]!);
  }, 60_000);

  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => undefined);
  });

  const stepNamed = async (label: string): Promise<Step> => {
    await expect.poll(() => recorder.session.steps.some((s) => s.label === label), { timeout: 10_000 }).toBe(true);
    return recorder.session.steps.find((s) => s.label === label)!;
  };
  const table = (step: Step, name: string) => step.diff.tables.find((t) => t.table.name === name);

  it("injects the client into the page, within the page's Content-Security-Policy", async () => {
    expect(await page.evaluate(() => (window as unknown as { __ashiatoInstalled?: boolean }).__ashiatoInstalled)).toBe(true);
    expect(await page.evaluate(() => window.__ASHIATO__?.recorder)).toBe(recorderUrl);
    expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  });

  it("turns a click and its requests into one checkpoint", async () => {
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const step = await stepNamed('click button "保存"');
    expect(step.source).toBe("POST /api/orders, GET /api/orders");
    expect(step.action?.requests.map((r) => r.status)).toEqual([200, 200]);
    expect(table(step, "orders")?.inserted).toHaveLength(1);
    expect(table(step, "stock")?.updated[0]?.after.qty).toBe(40);
  });

  it("separates changes made outside any action from the next action", async () => {
    app.db.exec("UPDATE stock SET qty = 99 WHERE item_id = 4");
    await page.getByRole("button", { name: "削除" }).click();
    const step = await stepNamed('click button "削除"');
    expect(step.diff.tables.map((t) => t.table.name)).toEqual(["orders"]);
    expect(table(step, "orders")?.deleted).toHaveLength(1);
    const outside = recorder.session.steps.find((s) => s.label === "outside actions");
    expect(table(outside!, "stock")?.updated[0]?.after.qty).toBe(99);
  });

  it("does not checkpoint clicks that send no request", async () => {
    const before = recorder.session.steps.length;
    await page.getByRole("button", { name: "詳細タブ" }).click();
    await page.waitForTimeout(500);
    expect(recorder.session.steps.length).toBe(before);
  });

  it("pairs WebView2 postMessage calls with their replies", async () => {
    await page.getByRole("button", { name: "WebView保存" }).click();
    const step = await stepNamed('click button "WebView保存"');
    expect(step.source).toBe("orders.save");
    expect(step.action?.requests[0]).toMatchObject({ kind: "rpc", method: "orders.save" });
    expect(table(step, "orders")?.inserted[0]?.id).toBe(2);
  });

  it("sends each request with its own arguments while it waits for the sync checkpoint", async () => {
    await page.getByRole("button", { name: "まとめて保存" }).click();
    const step = await stepNamed('click button "まとめて保存"');
    expect(step.action?.requests.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(table(step, "orders")?.inserted.map((r) => r.id).sort()).toEqual([11, 12, 13]);
  });

  it("ends an XHR request cancelled by re-opening it, instead of waiting for the 30s cap", async () => {
    await page.getByRole("button", { name: "XHR中止" }).click();
    const step = await stepNamed('click button "XHR中止"');
    expect(step.action?.requests).toMatchObject([{ method: "POST", url: "/api/slow", error: "aborted" }]);
  });

  const replayEvents = async () => {
    const text = await (await fetch(`${recorderUrl}/api/replay`)).text();
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { tab: string; events: { type: number; timestamp: number; data: { source?: number; type?: number } }[] });
  };

  it("records the page for screen replay, in the same tab as the actions", async () => {
    const step = await stepNamed('click button "保存"');
    expect(step.action?.tab).toMatch(/^\w+$/);
    await expect.poll(async () => (await replayEvents()).filter((b) => b.tab === step.action!.tab).length, { timeout: 5000 }).toBeGreaterThan(0);
    const events = (await replayEvents()).filter((b) => b.tab === step.action!.tab).flatMap((b) => b.events);
    // a full DOM snapshot, and the click itself (incremental snapshot, mouse interaction, click)
    expect(events.some((e) => e.type === 2)).toBe(true);
    const clickAt = Date.parse(step.action!.startedAt);
    expect(events.some((e) => e.type === 3 && e.data.source === 2 && e.data.type === 2 && Math.abs(e.timestamp - clickAt) < 1000)).toBe(true);
  });

  it("replays a step in the timeline UI", async () => {
    const ui = await browser.newPage();
    const errors: string[] = [];
    ui.on("pageerror", (e) => errors.push(e.message));
    await ui.goto(recorderUrl);
    const step = await stepNamed('click button "保存"');
    await ui.locator("aside li", { hasText: `#${step.id} click button "保存"` }).click();
    const replay = ui.frameLocator(".replay-frame iframe");
    await expect.poll(() => replay.getByText("WebView保存").count(), { timeout: 10_000 }).toBe(1);
    await ui.getByRole("button", { name: "▶ Play this action" }).click();
    await ui.waitForTimeout(500);
    expect(errors).toEqual([]);
    await ui.close();
  });

  it("records the screen from the timeline UI and shows it for steps taken meanwhile", async () => {
    const ui = await browser.newPage();
    const errors: string[] = [];
    ui.on("pageerror", (e) => errors.push(e.message));
    // headless Chromium has no screen to share: hand out an animated canvas instead
    await ui.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 180 });
        const ctx = canvas.getContext("2d")!;
        let n = 0;
        setInterval(() => {
          ctx.fillStyle = `hsl(${(n += 10) % 360} 80% 50%)`;
          ctx.fillRect(0, 0, 320, 180);
        }, 50);
        return canvas.captureStream(15);
      };
    });
    await ui.goto(recorderUrl);
    await ui.getByRole("button", { name: "● Record screen" }).click();
    await ui.waitForTimeout(1500);
    const before = recorder.session.steps.length;
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => recorder.session.steps.slice(before).some((s) => s.label === 'click button "保存"'), { timeout: 10_000 }).toBe(true);
    await ui.waitForTimeout(1500);
    await ui.getByRole("button", { name: "■ Stop recording" }).click();
    await expect.poll(() => recorder.session.videos?.[0]?.endedAt, { timeout: 10_000 }).toBeTruthy();

    const step = recorder.session.steps.slice(before).find((s) => s.label === 'click button "保存"')!;
    await ui.locator("aside li", { hasText: `#${step.id} click button "保存"` }).click();
    await ui.getByRole("button", { name: "Video" }).click();
    const video = ui.locator(".screen video");
    // the player must be able to seek to the step inside the recording
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const seeked = await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<number>((resolve) => {
          v.addEventListener("seeked", () => resolve(v.currentTime), { once: true });
          v.currentTime = 2;
        }),
    );
    expect(seeked).toBeGreaterThan(1.5);
    expect(errors).toEqual([]);
    await ui.close();
  });

  const tabOf = (p: Page | import("playwright-core").Frame) => p.evaluate(() => (JSON.parse(sessionStorage.getItem("__ashiato_tab")!) as { id: string }).id);

  it("gives a popup its own tab, keeps a tab's id across reloads, and records frames as part of their page", async () => {
    const tab = await tabOf(page);
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate(() => void window.open(location.href))]);
    await popup.waitForFunction(() => window.__ashiatoInstalled === true);
    expect(await tabOf(popup)).not.toBe(tab);
    await popup.close();

    await page.evaluate(() => {
      const frame = Object.assign(document.createElement("iframe"), { src: `${location.href}?frame` });
      document.body.append(frame);
    });
    const framed = () => page.frames().find((f) => f.url().includes("?frame"));
    await expect.poll(() => Boolean(framed())).toBe(true);
    const frame = framed()!;
    await frame.waitForFunction(() => window.__ashiatoInstalled === true);
    expect(await tabOf(frame)).toBe(tab);
    await page.waitForTimeout(1500);
    // the frame's own replay would start with a meta event carrying its URL
    const metas = (await replayEvents()).flatMap((b) => b.events).filter((e) => e.type === 4);
    expect(metas.map((e) => (e.data as { href?: string }).href).filter((href) => href?.includes("?frame"))).toEqual([]);
    await page.evaluate(() => document.querySelector("iframe")?.remove());

    await page.reload();
    await page.waitForFunction(() => window.__ashiatoInstalled === true);
    expect(await tabOf(page)).toBe(tab);
  }, 30_000);

  it("asks a page that was already open for a full snapshot when the recorder restarts", async () => {
    const tab = await tabOf(page);
    // the page's own snapshot, taken when it loaded, went to the recorder before the restart
    const sent = async () => (await replayEvents()).filter((b) => b.tab === tab).flatMap((b) => b.events).some((e) => e.type === 2);
    await expect.poll(sent, { timeout: 5000 }).toBe(true);
    const before = serverOptions.media!;
    const restarted = new MediaStore(join(mkdtempSync(join(tmpdir(), "ashiato-e2e-")), "session.json"), recorder.session);
    serverOptions.media = restarted;
    try {
      // the page is idle: it still checks in, and the reply asks for a snapshot
      const snapshots = () => {
        const file = restarted.replayPath();
        if (!file) return 0;
        const batches = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tab: string; events: { type: number }[] });
        return batches.filter((b) => b.tab === tab).flatMap((b) => b.events).filter((e) => e.type === 2).length;
      };
      await expect.poll(snapshots, { timeout: 10_000 }).toBe(1);
      // one is enough: the batches already on their way when it was taken get the same answer
      await page.waitForTimeout(2500);
      expect(snapshots()).toBe(1);
    } finally {
      serverOptions.media = before;
    }
  }, 30_000);
  /** The HTML of one step's section of an evidence page. */
  const sectionOf = (html: string, id: number) => {
    const start = html.indexOf(`<section class="step" id="step-${id}">`);
    return html.slice(start, html.indexOf("</section>", start));
  };
  const images = (section: string) => [...section.matchAll(/<img src="data:image\/jpeg;base64,([^"]+)"/g)].map((m) => Buffer.from(m[1]!, "base64"));

  it("exports evidence with screenshots of the screen replay, in Excel, PDF and HTML", async () => {
    const { files, notes } = await exportEvidence(recorder.session, {
      formats: ["xlsx", "pdf", "html"],
      lang: "en",
      media: serverOptions.media,
      browser: browserPath,
    });
    expect(notes).toEqual([]);
    const html = files.html!.toString("utf8");
    const step = await stepNamed('click button "保存"');
    const section = sectionOf(html, step.id);
    // just before the click, and at the checkpoint
    expect(section).toContain("Screen just before the action (screen replay");
    expect(section).toContain("Screen at the checkpoint (screen replay");
    const [before, after] = images(section);
    expect(before!.length).toBeGreaterThan(2000);
    expect(after!.length).toBeGreaterThan(2000);
    expect(before!.equals(after!)).toBe(false);
    // changes no action made have no screen to show
    const outside = recorder.session.steps.find((s) => s.source === "sync")!;
    expect(images(sectionOf(html, outside.id))).toEqual([]);

    expect(files.pdf!.subarray(0, 5).toString()).toBe("%PDF-");
    const xlsx = files.xlsx!;
    expect(xlsx.includes(Buffer.from("xl/media/image1.jpeg"))).toBe(true);
    expect(xlsx.includes(Buffer.from("xl/drawings/drawing1.xml"))).toBe(true);
  }, 60_000);

  it("takes the screenshots from the screen recording when there is no replay", async () => {
    const session = { ...recorder.session, replay: undefined };
    const media = new MediaStore(sessionFile, session, undefined, true);
    expect(media.replayPath()).toBeUndefined();
    const { files, notes } = await exportEvidence(session, { formats: ["html"], lang: "en", media, browser: browserPath });
    expect(notes).toEqual([]);
    const html = files.html!.toString("utf8");
    const video = recorder.session.videos![0]!;
    const during = session.steps.filter((s) => s.source !== "sync" && Date.parse(s.at) > Date.parse(video.startedAt) && Date.parse(s.at) < Date.parse(video.endedAt!));
    expect(during.length).toBeGreaterThan(0);
    for (const step of during) {
      const section = sectionOf(html, step.id);
      expect(section).toContain("Screen at the checkpoint (screen recording");
      expect(images(section).length).toBeGreaterThan(0);
    }
    // steps before the recording started have nothing to show
    const earlier = session.steps.filter((s) => Date.parse(s.at) < Date.parse(video.startedAt) - 1000);
    for (const step of earlier) expect(images(sectionOf(html, step.id))).toEqual([]);
  }, 60_000);
  it("downloads the evidence from the timeline", async () => {
    const ui = await browser.newPage();
    await ui.goto(recorderUrl);
    for (const [button, ext] of [["⤓ Excel", "xlsx"], ["⤓ PDF", "pdf"]] as const) {
      const [download] = await Promise.all([ui.waitForEvent("download", { timeout: 30_000 }), ui.getByRole("button", { name: button }).click()]);
      expect(download.suggestedFilename()).toMatch(new RegExp(`^ashiato-.+\\.${ext}$`));
      const file = await download.path();
      expect(readFileSync(file).subarray(0, 2).toString()).toBe(ext === "xlsx" ? "PK" : "%P");
    }
    expect(await ui.locator("header .del").count()).toBe(0);
    await ui.close();
  }, 60_000);
});
