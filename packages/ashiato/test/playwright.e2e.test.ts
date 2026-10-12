/**
 * The `ashiato/playwright` fixtures in the real Playwright test runner, against a page that writes
 * to a database. Needs the built package (`pnpm build`) and a Chromium for Playwright.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppDb } from "./helpers.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(pkg, "dist/playwright.cjs");
const cli = join(pkg, "node_modules/@playwright/test/cli.js");
const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
const browserPath = chromium?.executablePath();
const canRun = existsSync(fixtures) && existsSync(cli) && browserPath && existsSync(browserPath);
if (process.env.ASHIATO_REQUIRE_E2E && !canRun) {
  throw new Error(`Playwright test cannot run: built=${existsSync(fixtures)}, chromium=${browserPath ?? "missing"}`);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>orders</title>
<button id="save">Save</button> <button id="nothing">Do nothing</button> <p id="done"></p>
<script>
  document.getElementById("save").onclick = async () => {
    await fetch("/api/orders", { method: "POST" });
    document.getElementById("done").textContent = "saved";
  };
</script>`;

interface JsonReport {
  suites: { specs: { title: string; tests: { results: { status: string; errors: { message?: string; location?: { line: number } }[]; steps?: { title: string }[] }[] }[] }[] }[];
}

/** Runs the Playwright test runner on one spec file, with the JSON reporter. */
function runPlaywright(dir: string): Promise<JsonReport> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, "test", "--config", join(dir, "playwright.config.cjs"), "--reporter=json"],
      { cwd: dir, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: join(dir, "report.json"), ASHIATO_DB_URL: "" }, timeout: 90_000 },
      (error, _stdout, stderr) => {
        if (!existsSync(join(dir, "report.json"))) return reject(new Error(`playwright test failed to run: ${error?.message}\n${stderr}`));
        resolve(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as JsonReport);
      },
    );
  });
}

describe.skipIf(!canRun)("expectDbChanges in the Playwright test runner", () => {
  let server: Server;
  let url: string;
  const app = createAppDb();

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/orders") {
        // the app answers first and writes a moment later: the fixture has to wait for it
        res.end("{}");
        setTimeout(() => app.db.exec("INSERT INTO orders (customer_id, qty) VALUES (7, 10); UPDATE stock SET qty = qty - 10 WHERE item_id = 3"), 200);
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("passes when the action changed the expected rows, and fails at the test's line otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashiato-pw-"));
    writeFileSync(
      join(dir, "playwright.config.cjs"),
      `module.exports = { testDir: ".", workers: 1, use: { baseURL: ${JSON.stringify(url)}, launchOptions: { executablePath: ${JSON.stringify(browserPath)} } } };`,
    );
    writeFileSync(
      join(dir, "orders.spec.ts"),
      `import { test, expect } from ${JSON.stringify(fixtures)};

test.use({ ashiato: { db: ${JSON.stringify(`sqlite:${app.file}`)}, settleMs: 100 } });

test("save", async ({ page, expectDbChanges }) => {
  await page.goto("/");
  const changes = await expectDbChanges(() => page.getByRole("button", { name: "Save" }).click(), {
    orders: { inserted: [{ id: expect.any(Number), customer_id: 7, qty: 10 }] },
    stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
  });
  expect(changes.orders.inserted[0].id).toBe(1);
  await expectDbChanges(() => page.getByRole("button", { name: "Do nothing" }).click(), {});
});

test("wrong expectation", async ({ page, expectDbChanges }) => {
  await page.goto("/");
  await expectDbChanges(() => page.getByRole("button", { name: "Save" }).click(), {
    orders: { inserted: [{ qty: 99 }] },
  }, { timeout: 1000 });
});
`,
    );
    const report = await runPlaywright(dir);
    const specs = report.suites.flatMap((s) => s.specs);
    const result = (title: string) => specs.find((s) => s.title === title)!.tests[0]!.results[0]!;

    expect(result("save").status).toBe("passed");
    const failed = result("wrong expectation");
    expect(failed.status).toBe("failed");
    const message = failed.errors[0]?.message ?? "";
    expect(message).toContain("Database changes don't match (waited 1s after the action)");
    expect(message).toContain("qty: expected 99, got 10");
    expect(message).toContain("stock changed (1 updated), but the expectation doesn't list it");
    // boxed step: the error points at the test's own expectDbChanges call
    expect(failed.errors[0]?.location?.line).toBe(17);
    expect(JSON.stringify(failed.steps ?? [])).toContain("expect database changes: orders +1");
  }, 120_000);
});
