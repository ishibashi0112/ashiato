import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbAdapter } from "../adapters/types.js";
import { MediaStore } from "../core/media.js";
import { Recorder, type RecorderOptions } from "../core/recorder.js";
import { saveSession, sessionPath } from "../core/store.js";
import type { Session, Step } from "../core/types.js";
import { startServer } from "../server/server.js";

export interface RecordingOptions extends RecorderOptions {
  /** Where sessions are saved (default .ashiato/sessions). */
  out?: string;
  /** Port of the timeline and of the API the Vite plugin calls; false for none. */
  port?: number | false;
  /** Chrome / Edge for PDF exports from the timeline. */
  browser?: string;
  /** A step was saved, or saving it failed. */
  onStep?: (step: Step, saveError?: Error) => void;
}

/** A recording in progress: the session is saved after every step. */
export interface Recording {
  recorder: Recorder;
  session: Session;
  file: string;
  media: MediaStore;
  /** The timeline, when it runs. */
  url?: string;
  /** Saves the session and stops the timeline (the database connection stays open). */
  stop(): Promise<void>;
}

/** Takes the baseline snapshot and starts saving steps, and the timeline server unless `port` is false. */
export async function startRecording(db: DbAdapter, options: RecordingOptions = {}): Promise<Recording> {
  const recorder = new Recorder(db, options);
  const session = await recorder.start();
  const file = sessionPath(resolve(options.out ?? ".ashiato/sessions"), session);
  saveSession(file, session);
  recorder.on("step", (step: Step) => {
    let error: Error | undefined;
    try {
      saveSession(file, session);
    } catch (e) {
      error = new Error(`Could not save ${file}: ${(e as Error).message}`);
    }
    options.onStep?.(step, error);
  });
  const media = new MediaStore(file, session, () => saveSession(file, session));
  let server: Server | undefined;
  if (options.port !== false) {
    server = await listen(options.port ?? 4100, {
      uiDir: uiDir(),
      getSession: () => session,
      checkpoint: (label, source, o) => recorder.checkpoint(label, source, o),
      onStep: (listener) => {
        recorder.on("step", listener);
        return () => recorder.off("step", listener);
      },
      media,
      sessionFile: file,
      browser: options.browser,
    });
  }
  const port = server && (server.address() as { port: number }).port;
  return {
    recorder,
    session,
    file,
    media,
    url: port ? `http://127.0.0.1:${port}` : undefined,
    async stop() {
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server!.close(r));
      }
      saveSession(file, session);
    },
  };
}

/** Starts the timeline server, with a clear message when the port is taken. */
export async function listen(port: number, options: Omit<Parameters<typeof startServer>[0], "port">) {
  try {
    return await startServer({ port, ...options });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`Port ${port} is already in use (is another ashiato running?). Choose another one with --port <n>.`);
    }
    throw e;
  }
}

export function uiDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "ui"), join(here, "../ui"), join(here, "../../dist/ui")]) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return undefined;
}
