/**
 * Real browser + real Vite dev server + real recorder: clicks in the page must turn into
 * checkpoints that contain exactly the rows each click changed.
 * Needs the built client (`pnpm build`) and a Chromium for playwright-core.
 */
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { connect } from "../src/adapters/index.js";
import { Recorder } from "../src/core/recorder.js";
import type { Step } from "../src/core/types.js";
import { startServer } from "../src/server/server.js";
import ashiato from "../src/vite/index.js";
import { createAppDb } from "./helpers.js";

const clientBuilt = existsSync(fileURLToPath(new URL("../dist/client.global.js", import.meta.url)));
const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
const browserPath = chromium?.executablePath();
const canRun = clientBuilt && browserPath && existsSync(browserPath);
if (process.env.ASHIATO_REQUIRE_E2E && !canRun) {
  throw new Error(`Browser test cannot run: client built=${clientBuilt}, chromium=${browserPath ?? "missing"}`);
}

describe.skipIf(!canRun)("Vite plugin in a real browser", () => {
  let browser: Browser;
  let page: Page;
  let vite: ViteDevServer;
  let recorder: Recorder;
  const closers: (() => Promise<unknown>)[] = [];
  const app = createAppDb();

  beforeAll(async () => {
    const adapter = await connect(`sqlite:${app.file}`);
    recorder = new Recorder(adapter);
    const session = await recorder.start();
    const rec = await startServer({
      port: 0,
      getSession: () => session,
      checkpoint: (l, s, o) => recorder.checkpoint(l, s, o),
    });
    closers.push(() => adapter.close(), () => new Promise((r) => rec.close(r)));

    vite = await createServer({
      root: fileURLToPath(new URL("./fixtures/app", import.meta.url)),
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1" },
      plugins: [
        ashiato({ recorder: `http://127.0.0.1:${(rec.address() as AddressInfo).port}`, settleMs: 50 }),
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

  it("injects the client into the page", async () => {
    expect(await page.evaluate(() => (window as unknown as { __ashiatoInstalled?: boolean }).__ashiatoInstalled)).toBe(true);
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
});
