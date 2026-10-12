import { basename } from "node:path";
import { generateTest } from "../codegen/index.js";
import { MediaStore } from "../core/media.js";
import { loadSession } from "../core/store.js";
import type { Session, Step } from "../core/types.js";
import { exportEvidence, type ExportFormat } from "../export/index.js";
import type { Lang } from "../export/text.js";
import type { Recording } from "../cli/recording.js";

export interface EvidenceOptions {
  lang?: Lang;
  changedOnly?: boolean;
  browser?: string;
}

/** A session to read: being recorded here, recorded by `ashiato record` (over its HTTP API), or saved. */
export interface SessionSource {
  /** What to call the session in messages. */
  readonly name: string;
  /** The session file, when known here. */
  readonly file?: string;
  session(): Promise<Session>;
  /** A checkpoint now; null when it changed nothing and was dropped. */
  checkpoint(label: string, source: string): Promise<Step | null>;
  test(name?: string): Promise<string>;
  evidence(format: ExportFormat, options: EvidenceOptions): Promise<{ data: Buffer; notes: string[] }>;
}

export function recordingSource(recording: Recording): SessionSource {
  return {
    name: `the recording ${basename(recording.file)}`,
    file: recording.file,
    session: async () => recording.session,
    checkpoint: (label, source) => recording.recorder.checkpoint(label, source),
    test: (name) => generateTest(recording.session, { media: recording.media, sessionFile: basename(recording.file), name }),
    evidence: (format, o) => evidenceOf(recording.session, recording.media, recording.file, format, o),
  };
}

export function fileSource(file: string): SessionSource {
  const session = loadSession(file);
  const media = new MediaStore(file, session, undefined, true);
  return {
    name: file,
    file,
    session: async () => session,
    checkpoint: () => Promise.reject(new Error(`${file} is a saved session: checkpoints are taken while recording`)),
    test: (name) => generateTest(session, { media, sessionFile: basename(file), name }),
    evidence: (format, o) => evidenceOf(session, media, file, format, o),
  };
}

/** A recorder running in another process (`ashiato record`), at http://127.0.0.1:<port>. */
export function recorderSource(url: string): SessionSource {
  const base = url.replace(/\/+$/, "");
  const call = async (path: string, init?: RequestInit) => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, init);
    } catch (e) {
      throw new Error(`No ashiato recorder at ${base} (${(e as Error).cause ?? (e as Error).message}). Start one with: ashiato record --db <url>`);
    }
    if (!res.ok) throw new Error(`${base}${path}: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText}`);
    return res;
  };
  return {
    name: `the recorder at ${base}`,
    session: async () => (await (await call("/api/session")).json()) as Session,
    async checkpoint(label, source) {
      const res = await call("/api/checkpoint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, source }) });
      const body = (await res.json()) as Step | { dropped: true };
      return "dropped" in body ? null : body;
    },
    test: async (name) => (await call(`/api/export?format=playwright${name ? `&name=${encodeURIComponent(name)}` : ""}`)).text(),
    async evidence(format, o) {
      const params = new URLSearchParams({ format, ...(o.lang ? { lang: o.lang } : {}), ...(o.changedOnly ? { changedOnly: "1" } : {}) });
      const res = await call(`/api/export?${params}`);
      const notes = res.headers.get("x-ashiato-notes");
      return { data: Buffer.from(await res.arrayBuffer()), notes: notes ? decodeURIComponent(notes).split("\n") : [] };
    },
  };
}

async function evidenceOf(session: Session, media: MediaStore, file: string, format: ExportFormat, o: EvidenceOptions) {
  const { files, notes } = await exportEvidence(session, { formats: [format], lang: o.lang, changedOnly: o.changedOnly, browser: o.browser, media, sessionFile: file });
  return { data: files[format]!, notes };
}
