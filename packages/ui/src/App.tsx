import { useEffect, useMemo, useRef, useState } from "react";
import { loadReplay, useScreenRecorder, type ReplayTabs } from "./Screen";
import { StepDetail } from "./StepDetail";
import type { Session, Step, VideoInfo } from "./types";

type LiveSession = Session & { live?: boolean };

export function count(step: Step) {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  for (const t of step.diff.tables) {
    inserted += t.inserted.length;
    updated += t.updated.length;
    deleted += t.deleted.length;
  }
  return { inserted, updated, deleted };
}

const time = (iso: string) => new Date(iso).toLocaleTimeString();

export function App() {
  const [session, setSession] = useState<LiveSession>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState<number>();
  /** The newest step id: new steps are followed only while the user is looking at the newest one. */
  const latest = useRef<number | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [replay, setReplay] = useState<ReplayTabs>(new Map());
  const [replayVersion, setReplayVersion] = useState(0);
  const screen = useScreenRecorder((video: VideoInfo) =>
    setSession((prev) => prev && { ...prev, videos: [...(prev.videos ?? []).filter((v) => v.id !== video.id), video] }),
  );

  useEffect(() => {
    let cancelled = false;
    loadReplay()
      .then((tabs) => !cancelled && setReplay(tabs))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [replayVersion]);

  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;
    let sessionId: string | undefined;
    const follow = (id: number | undefined) => {
      // read now: React runs the updater later, after latest.current has moved on
      const wasLatest = latest.current;
      latest.current = id;
      setSelected((prev) => (prev === undefined || prev === wasLatest ? id : prev));
    };
    // (re)loads the whole session: at start, and whenever the event stream (re)connects, so steps
    // taken in between aren't missed and a restarted recorder's new session replaces the old one
    const load = () =>
      fetch("api/session")
        .then((r) => r.json() as Promise<LiveSession>)
        .then((s) => {
          if (cancelled) return s;
          if (sessionId !== undefined && sessionId !== s.id) latest.current = undefined;
          if (sessionId !== s.id) setSelected(undefined);
          sessionId = s.id;
          setSession(s);
          follow(s.steps.at(-1)?.id);
          return s;
        });
    load()
      .then((s) => {
        if (cancelled || !s.live) return;
        es = new EventSource("api/events");
        let opened = false;
        es.addEventListener("open", () => {
          if (opened) void load().then(() => setReplayVersion((v) => v + 1)).catch(() => undefined);
          opened = true;
        });
        es.addEventListener("step", (e) => {
          const step = JSON.parse((e as MessageEvent<string>).data) as Step;
          setSession((prev) => (prev && !prev.steps.some((x) => x.id === step.id) ? { ...prev, steps: [...prev.steps, step] } : prev));
          follow(step.id);
          // the page sends its replay events every second: fetch them once this action's have arrived
          setTimeout(() => setReplayVersion((v) => v + 1), 1500);
        });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  const steps = useMemo(
    () => (session?.steps ?? []).filter((s) => !hideEmpty || s.diff.tables.length > 0),
    [session, hideEmpty],
  );
  const current = session?.steps.find((s) => s.id === selected);

  async function checkpoint(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("api/checkpoint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label || undefined, source: "ui" }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      setLabel("");
      setNotice(undefined);
    } catch (err) {
      // keep the timeline on screen: the recorder may just have failed one read
      setNotice(`Checkpoint failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="empty">Error: {error}</div>;
  if (!session) return <div className="empty">Loading…</div>;

  return (
    <div className="app">
      <header>
        <h1>ashiato</h1>
        <span className="meta">
          {session.dialect} · {session.tables.length} tables · started {new Date(session.startedAt).toLocaleString()}
        </span>
        {session.live && <span className="live">● recording</span>}
        {session.live && (
          <button type="button" className={screen.recording ? "rec on" : "rec"} onClick={screen.recording ? screen.stop : screen.start}>
            {screen.recording ? "■ Stop recording" : "● Record screen"}
          </button>
        )}
        {screen.error && <span className="del small">{screen.error}</span>}
        {notice && <span className="del small">{notice}</span>}
        {session.live && (
          <form onSubmit={checkpoint} className="checkpoint">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. click Save)" />
            <button disabled={busy}>{busy ? "Reading…" : "Checkpoint"}</button>
          </form>
        )}
      </header>
      <main>
        <aside>
          <label className="toggle">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide steps without changes
          </label>
          {steps.length === 0 && (
            <p className="hint">
              {session.live ? "Use the app, then take a checkpoint here or press Enter in the terminal." : "No steps."}
            </p>
          )}
          <ol>
            {steps.map((s) => {
              const c = count(s);
              return (
                <li
                  key={s.id}
                  className={[s.id === selected ? "active" : "", s.source === "sync" ? "outside" : ""].join(" ")}
                  onClick={() => setSelected(s.id)}
                >
                  <div className="row">
                    <span className="step-label">
                      #{s.id} {s.label}
                    </span>
                    <span className="at">{time(s.at)}</span>
                  </div>
                  <div className="row small">
                    <span className="counts">
                      <b className="ins">+{c.inserted}</b> <b className="upd">~{c.updated}</b> <b className="del">-{c.deleted}</b>
                    </span>
                    {s.source && s.source !== "manual" && <span className="source">{s.source}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </aside>
        <section>
          {current ? (
            <StepDetail step={current} replay={replay} videos={session.videos ?? []} />
          ) : (
            <div className="empty">Select a step</div>
          )}
        </section>
      </main>
    </div>
  );
}
