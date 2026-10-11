import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Session, VideoInfo } from "./types.js";

const TAB = /^[\w-]{1,64}$/;

/**
 * Screen replay events and screen recordings of a session. They are kept in files next to the
 * session file (`<session>.replay.ndjson`, `<session>.video-<n>.webm`) so the session JSON stays small.
 */
export class MediaStore {
  private readonly dir: string;
  private readonly base: string;

  constructor(
    sessionFile: string,
    private readonly session: Session,
    /** Called when the session's media metadata changed (so it can be saved). */
    private readonly onChange: () => void = () => undefined,
    readonly readOnly = false,
  ) {
    this.dir = dirname(sessionFile);
    this.base = basename(sessionFile, ".json");
  }

  /** Appends a batch of rrweb events recorded in one browser tab. */
  appendReplay(tab: string, events: unknown[]): void {
    this.writable();
    if (!TAB.test(tab)) throw new Error("invalid tab id");
    if (!Array.isArray(events)) throw new Error("events must be an array");
    if (events.length === 0) return;
    if (!this.session.replay) {
      this.session.replay = { file: `${this.base}.replay.ndjson` };
      this.onChange();
    }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, this.session.replay.file), `${JSON.stringify({ tab, events })}\n`);
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
    return existsSync(path) ? path : undefined;
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
