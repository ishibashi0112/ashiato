import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { countChanges } from "../core/diff.js";
import type { MediaStore } from "../core/media.js";
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
  /** Screen replay events and screen recordings. */
  media?: MediaStore;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Largest request body accepted (a screen recording chunk is far smaller). */
const MAX_BODY = 64 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Local-only HTTP server: the timeline UI plus a tiny API that the UI and the Vite plugin's
 * browser script use to create checkpoints and store screen replays / recordings.
 */
export function startServer(options: ServerOptions): Promise<Server> {
  const server = createServer((req, res) => {
    handle(req, res, options).catch((e: Error) => {
      if (res.headersSent) return void res.end();
      sendJson(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve(server));
  });
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

async function handle(req: IncomingMessage, res: ServerResponse, o: ServerOptions) {
  // DNS rebinding: a page on evil.example resolving to 127.0.0.1 would otherwise be same-origin.
  const host = req.headers.host ?? "";
  if (!LOOPBACK.test(host) && host.split(":")[0] !== o.host) return sendJson(res, 403, { error: "Forbidden host" });

  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  const crossOrigin = origin !== undefined && origin !== `http://${host}`;

  // Only the endpoints the app's page calls are open to other origins (the app runs on its own dev server).
  // Their cross-origin replies carry no recorded data, so other web pages open in the browser can't read it.
  if ((url.pathname === "/api/checkpoint" || url.pathname === "/api/replay") && req.method !== "GET") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
  }

  if (url.pathname === "/api/session" && req.method === "GET") {
    return sendJson(res, 200, { ...o.getSession(), live: Boolean(o.checkpoint) });
  }

  if (url.pathname === "/api/checkpoint" && req.method === "POST") {
    if (!o.checkpoint) return sendJson(res, 405, { error: "This session is read-only" });
    const body = (await readJson(req)) as { label?: unknown; source?: unknown; action?: ActionInfo; dropIfEmpty?: boolean };
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const step = await o.checkpoint(label || "checkpoint", typeof body.source === "string" ? body.source : "http", {
      action: body.action,
      dropIfEmpty: body.dropIfEmpty === true,
    });
    if (!step) return sendJson(res, 200, { dropped: true });
    return sendJson(res, 200, crossOrigin ? { id: step.id, changes: countChanges(step.diff) } : step);
  }

  if (url.pathname === "/api/replay") {
    const media = o.media;
    if (req.method === "POST") {
      if (!media || media.readOnly) return sendJson(res, 405, { error: "This session is read-only" });
      const body = (await readJson(req)) as { tab?: unknown; events?: unknown };
      try {
        media.appendReplay(String(body.tab), body.events as unknown[]);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return void res.writeHead(204).end();
    }
    if (req.method === "GET") {
      // one JSON object per line: { tab, events }. No CORS header: other origins can't read it.
      const file = media?.replayPath();
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
      return file ? void createReadStream(file).pipe(res) : void res.end();
    }
  }

  const video = /^\/api\/video(?:\/(\d+)(?:\/(chunk|stop))?)?$/.exec(url.pathname);
  if (video) return handleVideo(req, res, o, crossOrigin, video[1] ? Number(video[1]) : undefined, video[2]);

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

/** Screen recordings are made from the timeline UI itself, so writes are same-origin only. */
async function handleVideo(
  req: IncomingMessage,
  res: ServerResponse,
  o: ServerOptions,
  crossOrigin: boolean,
  id: number | undefined,
  action: string | undefined,
) {
  const media = o.media;
  if (req.method === "GET" && id !== undefined && !action) {
    const file = media?.videoFile(id);
    if (!file) return sendJson(res, 404, { error: "Not found" });
    return serveRange(req, res, file);
  }
  if (req.method !== "POST") return sendJson(res, 404, { error: "Not found" });
  if (crossOrigin) return sendJson(res, 403, { error: "Forbidden origin" });
  if (!media || media.readOnly) return sendJson(res, 405, { error: "This session is read-only" });
  try {
    if (id === undefined) {
      const body = (await readJson(req)) as { mimeType?: string; startedAt?: string };
      return sendJson(res, 200, media.startVideo(String(body.mimeType), String(body.startedAt)));
    }
    if (action === "chunk") {
      media.appendVideo(id, await readBody(req));
      return void res.writeHead(204).end();
    }
    if (action === "stop") {
      const body = (await readJson(req)) as { endedAt?: string };
      return sendJson(res, 200, media.stopVideo(id, String(body.endedAt)));
    }
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message);
  }
  sendJson(res, 404, { error: "Not found" });
}

/** Serves a file with HTTP Range support, which the browser's <video> needs to seek. */
function serveRange(req: IncomingMessage, res: ServerResponse, file: { path: string; size: number; mimeType: string }) {
  const headers = { "Content-Type": file.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!range || (!range[1] && !range[2]) || file.size === 0) {
    res.writeHead(200, { ...headers, "Content-Length": file.size });
    return void createReadStream(file.path).pipe(res);
  }
  // "bytes=500-" (from 500), "bytes=500-999", or "bytes=-500" (the last 500)
  let start = range[1] ? Number(range[1]) : file.size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
  start = Math.max(0, start);
  end = Math.min(end, file.size - 1);
  if (start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${file.size}` });
    return void res.end();
  }
  res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${file.size}` });
  createReadStream(file.path, { start, end }).pipe(res);
}

function serveStatic(res: ServerResponse, root: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Bad URL");
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, "");
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses a JSON body whatever its content-type (the browser script sends text/plain to skip the CORS preflight). */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = (await readBody(req)).toString("utf8");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object");
  return body;
}
