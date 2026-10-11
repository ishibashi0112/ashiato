import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Session, VideoInfo } from "./types.js";

const TAB = /^[\w-]{1,64}$/;

/** The replay file stops growing at this size, so a page that keeps sending can't fill the disk. */
export const MAX_REPLAY_BYTES = 1024 ** 3;

/** rrweb's event type of a full snapshot of the page: replay can only start from one. */
const FULL_SNAPSHOT = 2;

/** A video still open (no `endedAt`) whose file hasn't grown for this long was abandoned (its tab closed or crashed). */
const ABANDONED_MS = 10_000;

/**
 * Screen replay events and screen recordings of a session. They are kept in files next to the
 * session file (`<session>.replay.ndjson`, `<session>.video-<n>.webm`) so the session JSON stays small.
 */
export class MediaStore {
  private readonly dir: string;
  private readonly base: string;
  /** Tabs that sent a full snapshot to this session's replay file. */
  private readonly snapshots = new Set<string>();
  maxReplayBytes = MAX_REPLAY_BYTES;

  constructor(
    sessionFile: string,
    private readonly session: Session,
    /** Called when the session's media metadata changed (so it can be saved). */
    private readonly onChange: () => void = () => undefined,
    readonly readOnly = false,
  ) {
    this.dir = dirname(sessionFile);
    this.base = basename(sessionFile, ".json");
    // a recording whose stop never arrived ended when its file was last written
    for (const video of session.videos ?? []) if (!video.endedAt) video.endedAt = this.lastWrite(video) ?? video.startedAt;
  }

  /**
   * Appends a batch of rrweb events recorded in one browser tab. Returns whether the tab should
   * send a full snapshot: replay starts from one, and a page that was already open when the
   * recorder (re)started has only sent changes to the page so far.
   */
  appendReplay(tab: string, events: unknown[]): { snapshot: boolean } {
    this.writable();
    if (!TAB.test(tab)) throw new Error("invalid tab id");
    if (!Array.isArray(events)) throw new Error("events must be an array");
    if (!events.every(isEvent)) throw new Error("events must be rrweb events (objects with a numeric type and timestamp)");
    if (events.length > 0) {
      if (!this.session.replay) {
        this.session.replay = { file: `${this.base}.replay.ndjson` };
        this.onChange();
      }
      const line = `${JSON.stringify({ tab, events })}\n`;
      const path = join(this.dir, this.session.replay.file);
      const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      if (size + Buffer.byteLength(line) > this.maxReplayBytes) throw new Error(`the replay file reached its limit of ${this.maxReplayBytes} bytes`);
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(path, line);
      if (events.some((e) => e.type === FULL_SNAPSHOT)) this.snapshots.add(tab);
    }
    return { snapshot: !this.snapshots.has(tab) };
  }

  /** Absolute path of the replay file, if anything was recorded. */
  replayPath(): string | undefined {
    const file = this.session.replay?.file;
    return file ? this.existing(file) : undefined;
  }

  startVideo(mimeType: string, startedAt: string): VideoInfo {
    this.writable();
    if (!/^video\/(webm|mp4)\b/.test(mimeType)) throw new Error(`unsupported video type: ${mimeType}`);
    if (Number.isNaN(Date.parse(startedAt))) throw new Error("invalid startedAt");
    const videos = (this.session.videos ??= []);
    // a recording left open by a closed or crashed timeline tab would otherwise seem to go on forever
    const now = Date.now();
    for (const v of videos) {
      const last = v.endedAt ? undefined : this.lastWrite(v);
      if (last && now - Date.parse(last) > ABANDONED_MS) v.endedAt = last;
    }
    const id = (videos.at(-1)?.id ?? 0) + 1;
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const video: VideoInfo = { id, file: `${this.base}.video-${id}.${ext}`, mimeType, startedAt };
    videos.push(video);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, video.file), "");
    this.onChange();
    return video;
  }

  appendVideo(id: number, chunk: Buffer): void {
    this.writable();
    const video = this.video(id);
    if (video.endedAt) throw new Error(`video ${id} is already finished`);
    appendFileSync(join(this.dir, video.file), chunk);
  }

  stopVideo(id: number, endedAt: string): VideoInfo {
    this.writable();
    const video = this.video(id);
    video.endedAt ??= Number.isNaN(Date.parse(endedAt)) ? new Date().toISOString() : endedAt;
    this.onChange();
    return video;
  }

  /** The video's file, if it exists. */
  videoFile(id: number): { path: string; size: number; mimeType: string } | undefined {
    const video = this.session.videos?.find((v) => v.id === id);
    if (!video) return undefined;
    const path = this.existing(video.file);
    return path ? { path, size: statSync(path).size, mimeType: video.mimeType } : undefined;
  }

  /** Media files are always looked up next to the session file, whatever a (shared) session file says. */
  private existing(file: string): string | undefined {
    const path = join(this.dir, basename(file));
    return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;
  }

  /** When the video's file was last written, if it exists. */
  private lastWrite(video: VideoInfo): string | undefined {
    const path = this.existing(video.file);
    return path ? statSync(path).mtime.toISOString() : undefined;
  }

  private video(id: number): VideoInfo {
    const video = this.session.videos?.find((v) => v.id === id);
    if (!video) throw new Error(`no video ${id}`);
    return video;
  }

  private writable(): void {
    if (this.readOnly) throw new Error("This session is read-only");
  }
}

function isEvent(e: unknown): e is { type: number; timestamp: number } {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
  const { type, timestamp } = e as { type?: unknown; timestamp?: unknown };
  return typeof type === "number" && Number.isFinite(timestamp);
}
