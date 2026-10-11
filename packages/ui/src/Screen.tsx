import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Replayer, type eventWithTime } from "rrweb";
import "rrweb/dist/style.css";
import type { Step, VideoInfo } from "./types";

export type ReplayTabs = Map<string, eventWithTime[]>;

/** Seconds of context shown before an action, and after its checkpoint. */
const BEFORE_MS = 1000;
const AFTER_MS = 800;

/** Loads the screen replay events (one JSON batch per line), grouped by browser tab and sorted by time. */
export async function loadReplay(): Promise<ReplayTabs> {
  const res = await fetch("api/replay");
  if (!res.ok) return new Map();
  const tabs: ReplayTabs = new Map();
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const batch = JSON.parse(line) as { tab: string; events: eventWithTime[] };
      const list = tabs.get(batch.tab) ?? [];
      list.push(...batch.events);
      tabs.set(batch.tab, list);
    } catch {
      // a line cut short when the recorder stopped: skip it
    }
  }
  for (const list of tabs.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return tabs;
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

function lastBefore(events: eventWithTime[], t: number): eventWithTime | undefined {
  let found: eventWithTime | undefined;
  for (const e of events) {
    if (e.timestamp > t) break;
    found = e;
  }
  return found;
}

function videoFor(videos: VideoInfo[], start: number, end: number): VideoInfo | undefined {
  return videos.find((v) => Date.parse(v.startedAt) <= end && (!v.endedAt || Date.parse(v.endedAt) >= start));
}

export function ScreenPanel({ step, replay, videos }: { step: Step; replay: ReplayTabs; videos: VideoInfo[] }) {
  const { start, end } = spanOf(step);
  const tab = tabFor(step, replay, end);
  const events = tab ? replay.get(tab) : undefined;
  const hasReplay = Boolean(events && events.length >= 2 && events[0]!.timestamp <= end);
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

function ReplayView({ events, start, end }: { events: eventWithTime[]; start: number; end: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer>(undefined);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [frameWidth, setFrameWidth] = useState(0);
  const first = events[0]!.timestamp;
  const offset = (t: number) => Math.max(0, t - first);

  useEffect(() => {
    const root = holder.current!;
    const r = new Replayer(events, { root, showWarning: false, mouseTail: false, triggerFocus: false, skipInactive: false });
    r.on("resize", (d) => setSize(d as { width: number; height: number }));
    replayer.current = r;
    return () => {
      clearTimeout(stopTimer.current);
      r.destroy();
      root.replaceChildren();
    };
  }, [events]);

  useEffect(() => {
    clearTimeout(stopTimer.current);
    replayer.current?.pause(offset(start));
  }, [events, start]);

  useLayoutEffect(() => {
    const el = frame.current!;
    const ro = new ResizeObserver(() => setFrameWidth(el.clientWidth));
    ro.observe(el);
    setFrameWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = size && frameWidth ? Math.min(1, frameWidth / size.width) : 1;
  useEffect(() => {
    const wrapper = replayer.current?.wrapper;
    if (wrapper) {
      wrapper.style.transform = `scale(${scale})`;
      wrapper.style.transformOrigin = "0 0";
    }
  }, [scale, size]);

  const play = () => {
    const r = replayer.current;
    if (!r) return;
    clearTimeout(stopTimer.current);
    const from = start - BEFORE_MS;
    r.play(offset(from));
    stopTimer.current = setTimeout(() => r.pause(), end + AFTER_MS - Math.max(from, first));
  };

  return (
    <div className="screen-body">
      <div className="replay-frame" ref={frame} style={{ height: size ? size.height * scale : 240 }}>
        <div ref={holder} />
      </div>
      <div className="screen-controls">
        <button type="button" onClick={play}>
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
