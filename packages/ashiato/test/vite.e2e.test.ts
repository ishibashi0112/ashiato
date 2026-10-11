/**
 * Real browser + real Vite dev server + real recorder: clicks in the page must turn into
 * checkpoints that contain exactly the rows each click changed.
 * Needs the built client (`pnpm build`) and a Chromium for playwright-core.
 */
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { connect } from "../src/adapters/index.js";
import { MediaStore } from "../src/core/media.js";
import { Recorder } from "../src/core/recorder.js";
import type { Step } from "../src/core/types.js";
import { startServer } from "../src/server/server.js";
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
  const closers: (() => Promise<unknown>)[] = [];
  const app = createAppDb();

  beforeAll(async () => {
    const adapter = await connect(`sqlite:${app.file}`);
    recorder = new Recorder(adapter);
    const session = await recorder.start();
    const media = new MediaStore(join(mkdtempSync(join(tmpdir(), "ashiato-e2e-")), "session.json"), session);
    const rec = await startServer({
      port: 0,
      uiDir,
      getSession: () => session,
      checkpoint: (l, s, o) => recorder.checkpoint(l, s, o),
      onStep: (listener) => {
        recorder.on("step", listener);
        return () => recorder.off("step", listener);
      },
      media,
    });
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
});
