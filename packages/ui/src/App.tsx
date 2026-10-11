import { useEffect, useMemo, useState } from "react";
import { StepDetail } from "./StepDetail";
import type { Session, Step } from "./types";

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
  const [selected, setSelected] = useState<number>();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);

  useEffect(() => {
    let es: EventSource | undefined;
    let cancelled = false;
    fetch("api/session")
      .then((r) => r.json() as Promise<LiveSession>)
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setSelected(s.steps.at(-1)?.id);
        if (!s.live) return;
        es = new EventSource("api/events");
        es.addEventListener("step", (e) => {
          const step = JSON.parse((e as MessageEvent<string>).data) as Step;
          setSession((prev) => (prev && !prev.steps.some((x) => x.id === step.id) ? { ...prev, steps: [...prev.steps, step] } : prev));
          setSelected(step.id);
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
    } catch (err) {
      setError((err as Error).message);
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
        <section>{current ? <StepDetail step={current} /> : <div className="empty">Select a step</div>}</section>
      </main>
    </div>
  );
}
