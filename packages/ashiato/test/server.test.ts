import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import { Recorder } from "../src/core/recorder.js";
import { startServer } from "../src/server/server.js";
import type { Step } from "../src/core/types.js";
import { createAppDb } from "./helpers.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("server", () => {
  it("creates checkpoints over HTTP and streams them to listeners", async () => {
    const { file, db } = createAppDb();
    const adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter);
    const session = await recorder.start();
    const server = await startServer({
      port: 0,
      getSession: () => session,
      checkpoint: (label, source, options) => recorder.checkpoint(label, source, options),
      onStep: (l) => {
        recorder.on("step", l);
        return () => recorder.off("step", l);
      },
    });
    cleanups.push(() => adapter.close(), () => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const events = await fetch(`${base}/api/events`);
    const reader = events.body!.getReader();

    db.exec("UPDATE stock SET qty = 49 WHERE item_id = 3");
    const res = await fetch(`${base}/api/checkpoint`, { method: "POST", body: JSON.stringify({ label: "save", source: "orders.save" }) });
    const step = (await res.json()) as Step;
    expect(step.label).toBe("save");
    expect(step.source).toBe("orders.save");
    expect(step.diff.tables[0]?.updated[0]?.after.qty).toBe(49);

    let text = "";
    while (!text.includes("event: step")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"label":"save"');
    await reader.cancel();

    const s = (await (await fetch(`${base}/api/session`)).json()) as { steps: Step[]; live: boolean };
    expect(s.live).toBe(true);
    expect(s.steps).toHaveLength(1);
  });

  it("serves saved sessions read-only", async () => {
    const server = await startServer({
      port: 0,
      getSession: () => ({ version: 1, id: "x", startedAt: "t", dialect: "sqlite", tables: [], steps: [] }),
    });
    cleanups.push(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/checkpoint`, { method: "POST" })).status).toBe(405);
  });

  it("gives other origins no row data and rejects foreign Host headers", async () => {
    const { file, db } = createAppDb();
    const adapter = await connect(`sqlite:${file}`);
    const recorder = new Recorder(adapter);
    await recorder.start();
    const server = await startServer({
      port: 0,
      getSession: () => recorder.session,
      checkpoint: (label, source, options) => recorder.checkpoint(label, source, options),
    });
    cleanups.push(() => adapter.close(), () => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const raw = (path: string, headers: Record<string, string>, method = "GET") =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end(method === "POST" ? "{}" : undefined);
      });

    db.exec("UPDATE stock SET qty = 1 WHERE item_id = 3");
    const cross = await raw("/api/checkpoint", { origin: "http://localhost:5173", "content-type": "application/json" }, "POST");
    expect(cross.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.parse(cross.body)).toEqual({ id: 1, changes: { inserted: 0, updated: 1, deleted: 0 } });

    const session = await raw("/api/session", { origin: "http://evil.example" });
    expect(session.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await raw("/api/session", { host: "evil.example:80" })).status).toBe(403);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
  });
});
