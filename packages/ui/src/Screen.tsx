import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Replayer, type eventWithTime } from "rrweb";
import "rrweb/dist/style.css";
import type { Step, VideoInfo } from "./types";

/** What each browser tab's replay can show: its events from its first full snapshot on, sorted by time. */
export type ReplayTabs = Map<string, eventWithTime[]>;

/** Seconds of context shown before an action, and after its checkpoint. */
const BEFORE_MS = 1000;
const AFTER_MS = 800;

/** rrweb event types. */
const META = 4;
const FULL_SNAPSHOT = 2;

/** The replay read so far. Kept between reads, so each read fetches only what the page sent since. */
export interface ReplayState {
  session?: string;
  /** Bytes of the replay file read so far (whole lines only). */
  offset: number;
  /** Every event of each tab, sorted by time. */
  all: Map<string, eventWithTime[]>;
  /** A tab's array is replaced only when the tab got new events, so its replay keeps playing otherwise. */
  tabs: ReplayTabs;
}

export const emptyReplay = (session?: string): ReplayState => ({ session, offset: 0, all: new Map(), tabs: new Map() });

/**
 * Reads the screen replay events (one JSON batch per line) added since `prev`, grouped by browser tab.
 * Returns `prev` itself when nothing was added.
 */
export async function loadReplay(prev: ReplayState, session: string): Promise<ReplayState> {
  const from = prev.session === session ? prev.offset : 0;
  const res = await fetch("api/replay", { headers: from ? { range: `bytes=${from}-` } : {} });
  if (res.status === 416) {
    // nothing new, or the file is shorter than what was read (it's another one): read it again
    const size = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]);
    return size < from ? loadReplay(emptyReplay(), session) : prev;
  }
  if (!res.ok) return prev;
  // a whole file (not just the requested part) replaces what was read before
  const base = res.status === 206 ? prev : emptyReplay(session);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // whole lines only: the last one may still be being written
  const end = bytes.lastIndexOf(10) + 1;
  if (end === 0 && base === prev) return prev;
  const added = new Map<string, eventWithTime[]>();
  for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
    if (!line.trim()) continue;
    try {
      const batch = JSON.parse(line) as { tab?: unknown; events?: unknown };
      if (typeof batch.tab !== "string" || !Array.isArray(batch.events)) continue;
      const list = added.get(batch.tab) ?? [];
      for (const e of batch.events) if (isEvent(e)) list.push(e);
      added.set(batch.tab, list);
    } catch {
      // a line cut short when the recorder stopped: skip it
    }
  }
  const all = new Map(base.all);
  const tabs = new Map(base.tabs);
  for (const [tab, events] of added) {
    const list = (all.get(tab) ?? []).concat(events);
    // batches arrive in order, except the last one of a page, sent while it goes away
    if (list.some((e, i) => i > 0 && e.timestamp < list[i - 1]!.timestamp)) list.sort((a, b) => a.timestamp - b.timestamp);
    all.set(tab, list);
    const playable = fromFirstSnapshot(list);
    if (playable.length >= 2) tabs.set(tab, playable);
  }
  return { session, offset: (base === prev ? from : 0) + end, all, tabs };
}

function isEvent(e: unknown): e is eventWithTime {
  if (typeof e !== "object" || e === null) return false;
  const { type, timestamp } = e as { type?: unknown; timestamp?: unknown };
  return typeof type === "number" && typeof timestamp === "number" && Number.isFinite(timestamp);
}

/**
 * Replay needs a full snapshot of the page to start from. A page that was already open when the
 * recorder started sends only changes until it is asked for one: those changes can't be shown.
 */
function fromFirstSnapshot(events: eventWithTime[]): eventWithTime[] {
  const snapshot = events.findIndex((e) => e.type === FULL_SNAPSHOT);
  if (snapshot < 0) return [];
  let start = snapshot;
  // the meta event just before it carries the page size
  while (start > 0 && events[start - 1]!.type === META) start--;
  return start === 0 ? events : events.slice(start);
}

/** The time span shown for a step: from its user action (or the checkpoint itself) to the checkpoint. */
export function spanOf(step: Step): { start: number; end: number } {
  const end = Date.parse(step.at);
  const start = step.action ? Date.parse(step.action.startedAt) : end;
  return { start: Math.min(start, end), end };
}

function tabFor(step: Step, tabs: ReplayTabs, end: number): string | undefined {
  const own = step.action?.tab;
  if (own && tabs.has(own)) return own;
  // no action (manual or outside-actions step): the tab that was active last before the checkpoint
  let best: string | undefined;
  let bestTs = -Infinity;
  for (const [tab, events] of tabs) {
    const ts = lastBefore(events, end)?.timestamp ?? -Infinity;
    if (ts > bestTs) [best, bestTs] = [tab, ts];
  }
  return best;
}

/** The last event at or before `t` (events are sorted by time). */
function lastBefore(events: eventWithTime[], t: number): eventWithTime | undefined {
  let [lo, hi] = [0, events.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.timestamp <= t) lo = mid + 1;
    else hi = mid;
  }
  return events[lo - 1];
}

/** The newest recording covering the span: an older one never stopped would otherwise hide it. */
function videoFor(videos: VideoInfo[], start: number, end: number): VideoInfo | undefined {
  let found: VideoInfo | undefined;
  for (const v of videos) {
    if (Date.parse(v.startedAt) <= end && (!v.endedAt || Date.parse(v.endedAt) >= start)) found = v;
  }
  return found;
}

export function ScreenPanel(props: { step: Step; replay: ReplayTabs; videos: VideoInfo[] }) {
  return (
    <ScreenBoundary step={props.step.id}>
      <Screen {...props} />
    </ScreenBoundary>
  );
}

/** A replay that can't be shown (rrweb choking on odd events) must not take the whole timeline down. */
class ScreenBoundary extends Component<{ step: number; children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  componentDidUpdate(prev: { step: number }) {
    // another step selected: try again
    if (prev.step !== this.props.step && this.state.error) this.setState({ error: undefined });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card screen">
          <h3>Screen</h3>
          <p className="meta">The screen can't be shown: {this.state.error}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function Screen({ step, replay, videos }: { step: Step; replay: ReplayTabs; videos: VideoInfo[] }) {
  const { start, end } = spanOf(step);
  const tab = tabFor(step, replay, end);
  const events = tab ? replay.get(tab) : undefined;
  // from the tab's first full snapshot, which must come before the checkpoint
  const hasReplay = Boolean(events && events[0]!.timestamp <= end && events.find((e) => e.type === FULL_SNAPSHOT)!.timestamp <= end);
  const video = videoFor(videos, start, end);
  const [view, setView] = useState<"replay" | "video">("replay");
  const shown = view === "video" && video ? "video" : hasReplay ? "replay" : video ? "video" : undefined;
  if (!shown) return null;

  return (
    <div className="card screen">
      <h3>
        Screen
        {hasReplay && video && (
          <span className="views">
            <button type="button" className={shown === "replay" ? "on" : ""} onClick={() => setView("replay")}>
              Replay
            </button>
            <button type="button" className={shown === "video" ? "on" : ""} onClick={() => setView("video")}>
              Video
            </button>
          </span>
        )}
      </h3>
      {shown === "replay" ? <ReplayView events={events!} start={start} end={end} /> : <VideoView video={video!} start={start} end={end} />}
    </div>
  );
}

interface Player {
  replayer: Replayer;
  /** Events given to the replayer so far: the array's first and last of them, and how many. */
  first: eventWithTime;
  last: eventWithTime;
  fed: number;
}

function ReplayView({ events, start, end }: { events: eventWithTime[]; start: number; end: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<Player>(undefined);
  /** The start the replayer was last paused at. */
  const pausedAt = useRef<number>(undefined);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [frameWidth, setFrameWidth] = useState(0);
  const [error, setError] = useState<string>();
  const first = events[0]!.timestamp;
  const offset = (t: number) => Math.max(0, t - first);

  const destroy = () => {
    clearTimeout(stopTimer.current);
    player.current?.replayer.destroy();
    player.current = undefined;
    holder.current?.replaceChildren();
  };
  useEffect(() => destroy, []);

  // New events of the tab arrive while it is shown (each step fetches them): they are added to the
  // replayer, so a replay that is playing goes on. Only a reordered history starts it over.
  useEffect(() => {
    const p = player.current;
    try {
      if (p && events[0] === p.first && events[p.fed - 1] === p.last) {
        for (const e of events.slice(p.fed)) p.replayer.addEvent(e);
        [p.fed, p.last] = [events.length, events.at(-1)!];
        return;
      }
      destroy();
      const replayer = new Replayer(events, { root: holder.current!, showWarning: false, mouseTail: false, triggerFocus: false, skipInactive: false });
      replayer.on("resize", (d) => setSize(d as { width: number; height: number }));
      player.current = { replayer, first: events[0]!, last: events.at(-1)!, fed: events.length };
      replayer.pause(offset(start));
      pausedAt.current = start;
      setError(undefined);
    } catch (e) {
      destroy();
      setError((e as Error).message);
    }
  }, [events]);

  useEffect(() => {
    if (!player.current || pausedAt.current === start) return;
    clearTimeout(stopTimer.current);
    try {
      player.current.replayer.pause(offset(start));
      pausedAt.current = start;
    } catch (e) {
      setError((e as Error).message);
    }
  }, [start]);

  useLayoutEffect(() => {
    const el = frame.current!;
    const ro = new ResizeObserver(() => setFrameWidth(el.clientWidth));
    ro.observe(el);
    setFrameWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = size && frameWidth ? Math.min(1, frameWidth / size.width) : 1;
  useEffect(() => {
    const wrapper = player.current?.replayer.wrapper;
    if (wrapper) {
      wrapper.style.transform = `scale(${scale})`;
      wrapper.style.transformOrigin = "0 0";
    }
  }, [scale, size]);

  const play = () => {
    const r = player.current?.replayer;
    if (!r) return;
    clearTimeout(stopTimer.current);
    const from = start - BEFORE_MS;
    try {
      r.play(offset(from));
    } catch (e) {
      return setError((e as Error).message);
    }
    pausedAt.current = undefined;
    stopTimer.current = setTimeout(() => {
      try {
        r.pause();
      } catch {
        // destroyed meanwhile
      }
    }, end + AFTER_MS - Math.max(from, first));
  };

  return (
    <div className="screen-body">
      <div className="replay-frame" ref={frame} style={{ height: size && !error ? size.height * scale : 240 }}>
        {error && <p className="meta">This replay can't be shown: {error}</p>}
        <div ref={holder} />
      </div>
      <div className="screen-controls">
        <button type="button" onClick={play} disabled={Boolean(error)}>
          ▶ Play this action
        </button>
        <span className="meta">DOM replay of the page, from just before the action to its checkpoint</span>
      </div>
    </div>
  );
}

function VideoView({ video, start, end }: { video: VideoInfo; start: number; end: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const videoStart = Date.parse(video.startedAt);
  const at = useCallback((t: number) => Math.max(0, (t - videoStart) / 1000), [videoStart]);
  const until = useRef(Infinity);

  const seek = useCallback(
    (t: number) => {
      const v = ref.current;
      if (!v) return;
      until.current = Infinity;
      v.pause();
      v.currentTime = at(t);
    },
    [at],
  );

  useEffect(() => {
    const v = ref.current!;
    if (v.readyState >= 1) seek(start);
    else v.addEventListener("loadedmetadata", () => seek(start), { once: true });
  }, [video.id, start, seek]);

  const play = () => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = at(start - BEFORE_MS);
    until.current = at(end + AFTER_MS);
    void v.play();
  };

  return (
    <div className="screen-body">
      <video
        ref={ref}
        src={`api/video/${video.id}`}
        controls
        muted
        preload="auto"
        onTimeUpdate={(e) => {
          if (e.currentTarget.currentTime >= until.current) {
            e.currentTarget.pause();
            until.current = Infinity;
          }
        }}
      />
      <div className="screen-controls">
        <button type="button" onClick={play}>
          ▶ Play this action
        </button>
        <span className="meta">
          Screen recording {video.id} · started {new Date(video.startedAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

const MIME_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

/**
 * Records the screen (any window: a browser, a WebView2 app...) with getDisplayMedia and uploads it
 * to the recorder in one-second chunks, so recordings survive a crash of the tab.
 */
export function useScreenRecorder(onVideo: (video: VideoInfo) => void) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string>();
  const recorder = useRef<MediaRecorder>(undefined);

  const start = async () => {
    setError(undefined);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") setError((e as Error).message);
      return;
    }
    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 });
    const post = (url: string, body: BodyInit, json = true) =>
      fetch(url, { method: "POST", body, headers: json ? { "content-type": "application/json" } : {} }).then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
        return r;
      });

    let started!: Promise<VideoInfo>;
    let chain: Promise<unknown> = Promise.resolve();
    const fail = (e: Error) => {
      setError(`Screen recording failed: ${e.message}`);
      if (rec.state !== "inactive") rec.stop();
    };
    rec.onstart = () => {
      started = post("api/video", JSON.stringify({ mimeType: rec.mimeType || "video/webm", startedAt: new Date().toISOString() })).then(
        (r) => r.json() as Promise<VideoInfo>,
      );
      chain = started.catch(fail);
    };
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      chain = chain.then(() => started.then((v) => post(`api/video/${v.id}/chunk`, e.data, false))).catch(fail);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      recorder.current = undefined;
      chain = chain
        .then(() => started.then((v) => post(`api/video/${v.id}/stop`, JSON.stringify({ endedAt: new Date().toISOString() }))))
        .then((r) => (r as Response).json() as Promise<VideoInfo>)
        .then(onVideo)
        .catch(fail);
    };
    // the user can also stop from the browser's "Stop sharing" bar
    stream.getVideoTracks()[0]?.addEventListener("ended", () => rec.state !== "inactive" && rec.stop());
    rec.start(1000);
    recorder.current = rec;
    setRecording(true);
  };

  const stop = () => {
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
  };

  return { recording, error, start, stop };
}
