import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "../adapters/index.js";
import { tableId } from "../core/diff.js";
import { formatStep } from "../core/format.js";
import { MediaStore } from "../core/media.js";
import { Recorder } from "../core/recorder.js";
import { loadSession, saveSession, sessionPath } from "../core/store.js";
import type { Step, TableRef } from "../core/types.js";
import { startServer } from "../server/server.js";

const HELP = `ashiato — record what your app changes in the database

Usage:
  ashiato tables --db <url>
  ashiato record --db <url> [--tables a,b] [--ignore-columns updated_at] [--port 4100] [--no-ui]
  ashiato show <session.json> [--port 4100]

Options:
  --db <url>              Connection URL (or set ASHIATO_DB_URL). Read-only access is enough.
                          sqlite:./dev.db
                          mssql://user:pass@host:1433/db?instance=SQLEXPRESS
                          oracle://user:pass@host:1521/service?schema=OWNER
                          postgres://user:pass@host:5432/db
                          mysql://user:pass@host:3306/db
  --tables <list>         Comma-separated tables to watch (default: all, including ones created while recording)
  --ignore-columns <list> Columns ignored when detecting updates (e.g. updated_at)
  --max-rows <n>          Skip tables larger than this (default 100000)
  --full-read             Read every row at each checkpoint, not only the parts that changed
  --out <dir>             Where sessions are saved (default .ashiato/sessions)
  --port <n>              UI port (default 4100)
  --no-ui                 Terminal only

While recording, press Enter to take a checkpoint (type a label first if you like).
`;

const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** East Asian wide characters (CJK, kana, hangul, fullwidth forms) take two terminal columns. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const padColumns = (s: string, width: number) => s + " ".repeat(Math.max(0, width - [...s].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0)));

function uiDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "ui"), join(here, "../ui"), join(here, "../../dist/ui")]) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return undefined;
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      tables: { type: "string" },
      "ignore-columns": { type: "string" },
      "max-rows": { type: "string" },
      "full-read": { type: "boolean" },
      out: { type: "string" },
      port: { type: "string" },
      "no-ui": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) return void process.stdout.write(HELP);

  const port = Number(values.port ?? 4100);
  const dbUrl = values.db ?? process.env.ASHIATO_DB_URL;

  if (command === "show") {
    const file = rest[0];
    if (!file) throw new Error("Usage: ashiato show <session.json>");
    const session = loadSession(resolve(file));
    const media = new MediaStore(resolve(file), session, undefined, true);
    await listen(port, { uiDir: uiDir(), getSession: () => session, media });
    console.log(`Viewing ${file} at http://127.0.0.1:${port}  (Ctrl+C to quit)`);
    return;
  }

  if (!dbUrl) throw new Error("--db <url> (or ASHIATO_DB_URL) is required");
  const db = await connect(dbUrl);

  if (command === "tables") {
    for (const t of await db.listTables()) {
      const key = await db.primaryKey(t);
      const rows = await db.countRows(t);
      console.log(`${padColumns(tableId(t), 40)} ${String(rows).padStart(10)} rows  key: ${key.length ? key.join(", ") : "(none)"}`);
    }
    await db.close();
    return;
  }

  if (command !== "record") throw new Error(`Unknown command: ${command}\n\n${HELP}`);

  const recorder = new Recorder(db, {
    tables: list(values.tables),
    ignoreColumns: list(values["ignore-columns"]),
    maxRows: values["max-rows"] ? Number(values["max-rows"]) : undefined,
    incremental: !values["full-read"],
  });
  const session = await recorder.start();
  const file = sessionPath(resolve(values.out ?? ".ashiato/sessions"), session);
  saveSession(file, session);

  console.log(`Watching ${session.tables.length} table(s) on ${db.dialect}. Baseline snapshot taken.`);
  for (const s of recorder.skippedTables()) {
    console.log(`  skipped ${tableId(s.table)} (${s.error ? `could not be read: ${s.error}` : `${s.rowCount} rows > --max-rows`})`);
  }
  for (const f of recorder.fullReadTables()) {
    console.log(`  ${tableId(f.table)} is read in full at each checkpoint (${f.reason})`);
  }

  // tables that stay skipped (too large) are reported again only when the set or a reason changes
  // (row counts of a too-large table change all the time; only an error's text is worth repeating)
  const kind = (reason: string) => (reason.startsWith("could not be read") ? reason : /more than max rows/.test(reason) ? "too large" : "");
  const skippedText = (list: { table: TableRef; reason: string }[]) => JSON.stringify(list.map((s) => [tableId(s.table), kind(s.reason)]));
  let lastSkipped = skippedText(
    recorder.skippedTables().map((s) => ({ table: s.table, reason: s.error ? `could not be read: ${s.error}` : "more than max rows" })),
  );
  recorder.on("step", (step: Step) => {
    try {
      saveSession(file, session);
    } catch (e) {
      console.error(`Could not save ${file}: ${(e as Error).message}`);
    }
    const skipped = skippedText(step.skipped ?? []);
    console.log(formatStep(step, 5, skipped !== lastSkipped));
    lastSkipped = skipped;
  });

  if (!values["no-ui"]) {
    const media = new MediaStore(file, session, () => saveSession(file, session));
    await listen(port, {
      uiDir: uiDir(),
      getSession: () => session,
      checkpoint: (label, source, options) => recorder.checkpoint(label, source, options),
      onStep: (listener) => {
        recorder.on("step", listener);
        return () => recorder.off("step", listener);
      },
      media,
    }).catch(async (e: Error) => {
      await db.close().catch(() => undefined);
      throw e;
    });
    console.log(`Timeline: http://127.0.0.1:${port}`);
  }
  console.log("Press Enter for a checkpoint (optionally type a label first). Ctrl+C to stop.\n");

  const rl = createInterface({ input: process.stdin });
  let pressed = 0;
  rl.on("line", (line) => {
    // counted here, not from the step list: Enter pressed twice quickly would give the same label
    pressed++;
    recorder.checkpoint(line.trim() || `checkpoint ${pressed}`).catch((e: Error) => console.error(e.message));
  });

  const stop = async () => {
    rl.close();
    saveSession(file, session);
    console.log(`\nSaved ${session.steps.length} step(s) to ${file}`);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
}

/** Starts the timeline server, with a clear message when the port is taken. */
async function listen(port: number, options: Omit<Parameters<typeof startServer>[0], "port">) {
  try {
    return await startServer({ port, ...options });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`Port ${port} is already in use (is another ashiato running?). Choose another one with --port <n>.`);
    }
    throw e;
  }
}
