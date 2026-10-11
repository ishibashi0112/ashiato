import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { CheckpointOptions } from "../core/recorder.js";
import type { ActionInfo, Session, Step } from "../core/types.js";

export interface ServerOptions {
  port: number;
  host?: string;
  /** Directory with the built UI (index.html + assets). */
  uiDir?: string;
  getSession: () => Session;
  /** Omit for read-only viewing of a saved session. */
  checkpoint?: (label: string, source: string, options: CheckpointOptions) => Promise<Step | null>;
  /** Subscribe to new steps; returns an unsubscribe function. */
  onStep?: (listener: (step: Step) => void) => () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * Local-only HTTP server: the timeline UI plus a tiny API that the UI (and later the
 * browser/Vite integration) uses to create checkpoints.
 */
export function startServer(options: ServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res, options).catch((e: Error) => sendJson(res, 500, { error: e.message }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve(server));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, o: ServerOptions) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/session" && req.method === "GET") {
    return sendJson(res, 200, { ...o.getSession(), live: Boolean(o.checkpoint) });
  }

  if (url.pathname === "/api/checkpoint" && req.method === "POST") {
    if (!o.checkpoint) return sendJson(res, 405, { error: "This session is read-only" });
    const body = (await readJson(req)) as { label?: string; source?: string; action?: ActionInfo; dropIfEmpty?: boolean };
    const step = await o.checkpoint(body.label?.trim() || "checkpoint", body.source ?? "http", {
      action: body.action,
      dropIfEmpty: body.dropIfEmpty === true,
    });
    return sendJson(res, 200, step ?? { dropped: true });
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const off = o.onStep?.((step) => res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`));
    req.on("close", () => off?.());
    return;
  }

  if (req.method === "GET" && o.uiDir) return serveStatic(res, o.uiDir, url.pathname);
  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(res: ServerResponse, root: string, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(root, rel || "index.html");
  if (!file.startsWith(root) || !existsSync(file) || extname(file) === "") file = join(root, "index.html");
  if (!existsSync(file)) return sendJson(res, 404, { error: "UI is not built. Run `pnpm build`." });
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
