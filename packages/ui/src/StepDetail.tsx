import type { JsonValue, Row, Step, TableDiff } from "./types";

const tableName = (t: TableDiff) => (t.table.schema ? `${t.table.schema}.${t.table.name}` : t.table.name);
const show = (v: JsonValue | undefined) => (v === null || v === undefined ? <i className="null">NULL</i> : String(v));

function columnsOf(rows: Row[]): string[] {
  const cols: string[] = [];
  for (const r of rows) for (const c of Object.keys(r)) if (!cols.includes(c)) cols.push(c);
  return cols;
}

export function StepDetail({ step }: { step: Step }) {
  return (
    <div className="detail">
      <h2>
        #{step.id} {step.label}
      </h2>
      <p className="meta">
        {new Date(step.at).toLocaleString()} · read in {step.durationMs}ms{step.source ? ` · ${step.source}` : ""}
      </p>
      {step.diff.tables.length === 0 && <p className="hint">No rows changed in the watched tables.</p>}
      {step.diff.tables.map((t) => (
        <TableCard key={tableName(t)} t={t} />
      ))}
    </div>
  );
}

function TableCard({ t }: { t: TableDiff }) {
  const cols = columnsOf([...t.inserted, ...t.deleted, ...t.updated.map((u) => u.after)]);
  const isKey = (c: string) => t.key.includes(c);
  return (
    <div className="card">
      <h3>
        {tableName(t)}
        <span className="counts">
          {t.inserted.length > 0 && <b className="ins">+{t.inserted.length}</b>}
          {t.updated.length > 0 && <b className="upd">~{t.updated.length}</b>}
          {t.deleted.length > 0 && <b className="del">-{t.deleted.length}</b>}
        </span>
        {t.key.length === 0 && <span className="warn">no primary key: updates appear as delete + insert</span>}
      </h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th></th>
              {cols.map((c) => (
                <th key={c} className={isKey(c) ? "key" : ""}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.inserted.map((r, i) => (
              <tr key={`i${i}`} className="ins-row">
                <td className="kind">+</td>
                {cols.map((c) => (
                  <td key={c}>{show(r[c])}</td>
                ))}
              </tr>
            ))}
            {t.updated.map((u, i) => (
              <tr key={`u${i}`} className="upd-row">
                <td className="kind">~</td>
                {cols.map((c) =>
                  u.changed.includes(c) ? (
                    <td key={c} className="changed">
                      <span className="before">{show(u.before[c])}</span>
                      <span className="arrow">→</span>
                      <span className="after">{show(u.after[c])}</span>
                    </td>
                  ) : (
                    <td key={c} className="same">
                      {show(u.after[c])}
                    </td>
                  ),
                )}
              </tr>
            ))}
            {t.deleted.map((r, i) => (
              <tr key={`d${i}`} className="del-row">
                <td className="kind">-</td>
                {cols.map((c) => (
                  <td key={c}>{show(r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
