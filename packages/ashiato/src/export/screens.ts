import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MediaStore } from "../core/media.js";
import type { Session, Step, VideoInfo } from "../core/types.js";
import type { Browser } from "./browser.js";
import type { Screenshot } from "./evidence.js";

/** rrweb event types. */
const FULL_SNAPSHOT = 2;
const META = 4;

interface ReplayEvent {
  type: number;
  timestamp: number;
}

type Size = { width: number; height: number };

/** A moment of a step to take a screenshot of. */
interface Moment {
  step: number;
  moment: Screenshot["moment"];
  t: number;
}

/** The screen replay events of each browser tab, sorted by time. */
export async function readReplay(path: string): Promise<Map<string, ReplayEvent[]>> {
  const tabs = new Map<string, ReplayEvent[]>();
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const batch = JSON.parse(line) as { tab?: unknown; events?: unknown };
      if (typeof batch.tab !== "string" || !Array.isArray(batch.events)) continue;
      const list = tabs.get(batch.tab) ?? [];
      for (const e of batch.events as ReplayEvent[]) {
        if (typeof e === "object" && e !== null && typeof e.type === "number" && Number.isFinite(e.timestamp)) list.push(e);
      }
      tabs.set(batch.tab, list);
    } catch {
      // a line cut short when the recorder stopped
    }
  }
  // batches arrive in order, except the last one of a page, sent while it goes away
  for (const list of tabs.values()) if (list.some((e, i) => i > 0 && e.timestamp < list[i - 1]!.timestamp)) list.sort((a, b) => a.timestamp - b.timestamp);
  return tabs;
}

/** The moments of a step worth a screenshot: just before its user action, and at its checkpoint. */
export function momentsOf(step: Step): Moment[] {
  // changes made while no action was running: the screen says nothing about them
  if (step.source === "sync") return [];
  const at = Date.parse(step.at);
  const moments: Moment[] = [];
  const started = step.action && step.action.type !== "request" ? Date.parse(step.action.startedAt) : NaN;
  if (Number.isFinite(started) && started < at) moments.push({ step: step.id, moment: "before", t: started - 1 });
  moments.push({ step: step.id, moment: "after", t: at });
  return moments;
}

/** Index of the last event at or before `t` (events sorted by time), or -1. */
function lastAtOrBefore(events: ReplayEvent[], t: number): number {
  let [lo, hi] = [0, events.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.timestamp <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Where the replay that can show `t` starts: the last full snapshot before it (with its meta event), or -1. */
function segmentStart(events: ReplayEvent[], t: number): number {
  let i = lastAtOrBefore(events, t);
  while (i >= 0 && events[i]!.type !== FULL_SNAPSHOT) i--;
  if (i < 0) return -1;
  while (i > 0 && events[i - 1]!.type === META) i--;
  return i;
}

/** The step's own tab, or the tab that was active last before `t` (manual checkpoints). */
function tabFor(step: Step, tabs: Map<string, ReplayEvent[]>, t: number): string | undefined {
  const own = step.action?.tab;
  if (own && tabs.has(own)) return own;
  let best: string | undefined;
  let bestTs = -Infinity;
  for (const [tab, events] of tabs) {
    const i = lastAtOrBefore(events, t);
    if (i >= 0 && events[i]!.timestamp > bestTs) [best, bestTs] = [tab, events[i]!.timestamp];
  }
  return best;
}

/** The newest screen recording that was running at `t`. */
function videoAt(videos: VideoInfo[], t: number): VideoInfo | undefined {
  let found: VideoInfo | undefined;
  for (const v of videos) if (Date.parse(v.startedAt) <= t && (!v.endedAt || Date.parse(v.endedAt) >= t)) found = v;
  return found;
}

/** The screenshot page's script, built next to the CLI. */
export function captureScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = [join(here, "capture.global.js"), join(here, "../../dist/capture.global.js")].find((f) => existsSync(f));
  return file ? readFileSync(file, "utf8") : undefined;
}

/**
 * Screenshots of the steps' screens, from the screen replay when it covers the moment, otherwise from
 * a screen recording. A step whose screen was not recorded gets none.
 */
export async function captureScreens(
  browser: Browser,
  session: Session,
  steps: Step[],
  media: MediaStore,
  pageUrl: string,
  onProgress: (done: number, total: number) => void = () => undefined,
): Promise<{ screens: Map<number, Screenshot[]>; failed: number }> {
  const replayFile = media.replayPath();
  const tabs = replayFile ? await readReplay(replayFile) : new Map<string, ReplayEvent[]>();
  const videos = session.videos ?? [];

  // which replay segment or video shows each moment
  const segments = new Map<string, { tab: string; start: number; moments: Moment[] }>();
  const byVideo = new Map<number, Moment[]>();
  for (const step of steps) {
    for (const m of momentsOf(step)) {
      const tab = tabFor(step, tabs, m.t);
      const events = tab ? tabs.get(tab)! : undefined;
      const start = events ? segmentStart(events, m.t) : -1;
      if (tab && start >= 0) {
        const key = `${tab}:${start}`;
        const seg = segments.get(key) ?? { tab, start, moments: [] };
        seg.moments.push(m);
        segments.set(key, seg);
        continue;
      }
      const video = videoAt(videos, m.t);
      if (video && media.videoFile(video.id)) byVideo.set(video.id, [...(byVideo.get(video.id) ?? []), m]);
    }
  }

  const total = [...segments.values()].reduce((n, s) => n + s.moments.length, 0) + [...byVideo.values()].reduce((n, l) => n + l.length, 0);
  const screens = new Map<number, Screenshot[]>();
  if (total === 0) return { screens, failed: 0 };
  let done = 0;
  let failed = 0;
  const add = async (m: Moment, source: Screenshot["source"], size: Size) => {
    const image = await browser.screenshot(size.width, size.height);
    const list = screens.get(m.step) ?? [];
    list.push({ moment: m.moment, at: new Date(m.t).toISOString(), source, image, ...size });
    screens.set(m.step, list);
    onProgress(++done, total);
  };

  // a replay rrweb can't show, or a recording the browser can't play, costs only its own screenshots
  const each = async (moments: Moment[], load: () => Promise<unknown>, shoot: (m: Moment) => Promise<void>) => {
    try {
      await load();
    } catch {
      failed += moments.length;
      return;
    }
    for (const m of moments) await shoot(m).catch(() => void failed++);
  };

  await browser.goto(pageUrl);
  for (const seg of segments.values()) {
    const events = tabs.get(seg.tab)!;
    const moments = seg.moments.sort((a, b) => a.t - b.t);
    const slice = events.slice(seg.start, lastAtOrBefore(events, moments.at(-1)!.t) + 1);
    await each(
      moments,
      () => browser.evaluate(`__ashiatoCapture.replay(${JSON.stringify(slice)})`, 120_000),
      async (m) => add(m, "replay", await browser.evaluate<Size>(`__ashiatoCapture.seek(${m.t - slice[0]!.timestamp})`)),
    );
  }
  for (const [id, moments] of byVideo) {
    const video = videos.find((v) => v.id === id)!;
    const url = pathToFileURL(media.videoFile(id)!.path).href;
    await each(
      moments.sort((a, b) => a.t - b.t),
      () => browser.evaluate(`__ashiatoCapture.video(${JSON.stringify(url)})`),
      async (m) => add(m, "video", await browser.evaluate<Size>(`__ashiatoCapture.seekVideo(${Math.max(0, (m.t - Date.parse(video.startedAt)) / 1000)})`)),
    );
  }
  // before, then after
  for (const list of screens.values()) list.sort((a, b) => (a.moment === b.moment ? 0 : a.moment === "before" ? -1 : 1));
  return { screens, failed };
}
