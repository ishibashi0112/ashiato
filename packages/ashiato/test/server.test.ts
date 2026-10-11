import { mkdtempSync, readdirSync } from "node:fs";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "../src/adapters/index.js";
import { MediaStore } from "../src/core/media.js";
import { Recorder } from "../src/core/recorder.js";
import { startServer } from "../src/server/server.js";
import type { Session, Step } from "../src/core/types.js";
import { createAppDb } from "./helpers.js";

const cleanups: (() => Promise<unknown>)[] = [];

/** A request with full control over Host / Origin headers (fetch doesn't allow setting them). */
const rawRequest =
  (port: number) =>
  (path: string, headers: Record<string, string>, method = "GET", body?: string | Buffer) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      });
      req.on("error", reject);
      req.end(body ?? (method === "POST" ? "{}" : undefined));
    });
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
    const raw = rawRequest(port);
    db.exec("UPDATE stock SET qty = 1 WHERE item_id = 3");
    const cross = await raw("/api/checkpoint", { origin: "http://localhost:5173", "content-type": "application/json" }, "POST");
    expect(cross.headers["access-control-allow-origin"]).toBe("*");
    expect(JSON.parse(cross.body)).toEqual({ id: 1, changes: { inserted: 0, updated: 1, deleted: 0 } });

    const session = await raw("/api/session", { origin: "http://evil.example" });
    expect(session.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await raw("/api/session", { host: "evil.example:80" })).status).toBe(403);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
  });

  it("stores screen replay events from the app and screen recordings from the UI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashiato-srv-"));
    const session: Session = { version: 1, id: "x", startedAt: "t", dialect: "sqlite", tables: [], steps: [] };
    const media = new MediaStore(join(dir, "s.json"), session);
    const server = await startServer({ port: 0, getSession: () => session, checkpoint: async () => null, media });
    cleanups.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    const raw = rawRequest(port);
    const app = { origin: "http://localhost:5173", "content-type": "text/plain" };

    // the app's page (another origin) sends replay events but can't read them back
    const batch = JSON.stringify({ tab: "t1", events: [{ type: 4, timestamp: 1 }] });
    const posted = await raw("/api/replay", app, "POST", batch);
    expect(posted.headers["access-control-allow-origin"]).toBe("*");
    // no full snapshot from this tab yet: the page is asked for one
    expect([posted.status, JSON.parse(posted.body)]).toEqual([200, { snapshot: true }]);
    expect((await raw("/api/replay", app, "POST", "not json")).status).toBe(400);
    expect((await raw("/api/replay", app, "POST", JSON.stringify({ tab: "t1", events: [{ type: 2 }] }))).status).toBe(400);
    const read = await raw("/api/replay", { origin: "http://evil.example" });
    expect(read.headers["access-control-allow-origin"]).toBeUndefined();
    expect(JSON.parse(read.body.trim())).toEqual(JSON.parse(batch));

    // the timeline reads only what was added since its last read
    const second = JSON.stringify({ tab: "t1", events: [{ type: 2, timestamp: 2 }] });
    expect(JSON.parse((await raw("/api/replay", app, "POST", second)).body)).toEqual({ snapshot: false });
    const size = Buffer.byteLength(batch) + 1;
    const rest = await raw("/api/replay", { range: `bytes=${size}-` });
    expect([rest.status, rest.body]).toEqual([206, `${second}\n`]);
    const none = await raw("/api/replay", { range: `bytes=${size + rest.body.length}-` });
    expect([none.status, none.headers["content-range"]]).toEqual([416, `bytes */${size + rest.body.length}`]);

    // pages of other origins can post here, so bodies are kept small (video chunks are same-origin only)
    expect((await raw("/api/checkpoint", app, "POST", "x".repeat(2 * 1024 * 1024))).status).toBe(413);

    // recordings: only the UI's own origin may write
    const startBody = JSON.stringify({ mimeType: "video/webm", startedAt: "2026-10-11T00:00:00.000Z" });
    expect((await raw("/api/video", app, "POST", startBody)).status).toBe(403);
    const base = `http://127.0.0.1:${port}`;
    const started = (await (await fetch(`${base}/api/video`, { method: "POST", body: startBody })).json()) as { id: number };
    await fetch(`${base}/api/video/${started.id}/chunk`, { method: "POST", body: Buffer.from("0123456789") });
    const stopped = await fetch(`${base}/api/video/${started.id}/stop`, { method: "POST", body: JSON.stringify({ endedAt: "2026-10-11T00:00:05.000Z" }) });
    expect(((await stopped.json()) as { endedAt: string }).endedAt).toBe("2026-10-11T00:00:05.000Z");
    expect((await fetch(`${base}/api/video/${started.id}/chunk`, { method: "POST", body: "x" })).status).toBe(400);

    // the <video> element seeks with Range requests
    const whole = await fetch(`${base}/api/video/1`);
    expect([whole.status, await whole.text()]).toEqual([200, "0123456789"]);
    const part = await fetch(`${base}/api/video/1`, { headers: { range: "bytes=2-4" } });
    expect([part.status, part.headers.get("content-range"), await part.text()]).toEqual([206, "bytes 2-4/10", "234"]);
    const tail = await fetch(`${base}/api/video/1`, { headers: { range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");
    expect((await fetch(`${base}/api/video/1`, { headers: { range: "bytes=20-" } })).status).toBe(416);
    expect((await fetch(`${base}/api/video/9`)).status).toBe(404);
  });

  it("sends no more than the size it announced while the file grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashiato-srv-"));
    const session: Session = { version: 1, id: "x", startedAt: "t", dialect: "sqlite", tables: [], steps: [] };
    const media = new MediaStore(join(dir, "s.json"), session);
    const video = media.startVideo("video/webm", "2026-10-11T00:00:00.000Z");
    media.appendVideo(video.id, Buffer.alloc(8 * 1024 * 1024, 1));
    const server = await startServer({ port: 0, getSession: () => session, media });
    cleanups.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(async () => agent.destroy());
    // the recording goes on while the whole file is downloaded
    const length = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: `/api/video/${video.id}`, agent }, (res) => {
        let size = 0;
        res.once("data", () => media.appendVideo(video.id, Buffer.alloc(1024 * 1024, 2)));
        res.on("data", (c: Buffer) => (size += c.length));
        res.on("end", () => resolve(size));
      });
      req.on("error", reject);
      req.end();
    });
    expect(length).toBe(8 * 1024 * 1024);
    // the next request on the same connection reads a clean response
    const next = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/session", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end();
    });
    expect(next).toBe(200);
  });

  it.skipIf(process.platform !== "linux")("closes files when the browser stops reading them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ashiato-srv-"));
    const session: Session = { version: 1, id: "x", startedAt: "t", dialect: "sqlite", tables: [], steps: [] };
    const media = new MediaStore(join(dir, "s.json"), session);
    const video = media.startVideo("video/webm", "2026-10-11T00:00:00.000Z");
    media.appendVideo(video.id, Buffer.alloc(8 * 1024 * 1024));
    const server = await startServer({ port: 0, getSession: () => session, media });
    cleanups.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    const openFiles = () => readdirSync("/proc/self/fd").length;
    const before = openFiles();
    // a <video> seeking: it drops each response after its first bytes
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: `/api/video/${video.id}`, headers: { range: "bytes=0-" } }, (res) =>
          res.once("data", () => {
            req.destroy();
            resolve();
          }),
        );
        req.on("error", reject);
        req.end();
      });
    }
    await expect.poll(openFiles, { timeout: 5000 }).toBeLessThanOrEqual(before + 2);
  });
});
