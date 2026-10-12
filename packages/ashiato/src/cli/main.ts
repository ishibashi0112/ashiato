import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "../adapters/index.js";
import { serveMcp } from "../agent/mcp.js";
import { fileSource, recorderSource } from "../agent/source.js";
import { stepLine, stepShape, stepText } from "../agent/text.js";
import { agentTools } from "../agent/tools.js";
import { generateTest } from "../codegen/index.js";
import { tableId } from "../core/diff.js";
import { formatStep } from "../core/format.js";
import { MediaStore } from "../core/media.js";
import { loadSession, saveSession } from "../core/store.js";
import type { TableRef } from "../core/types.js";
import { EXPORT_FORMATS, exportEvidence, type ExportFormat } from "../export/index.js";
import type { Lang } from "../export/text.js";
import { listen, startRecording, uiDir } from "./recording.js";

const HELP = `ashiato — record what your app changes in the database

Usage:
  ashiato tables --db <url> [--json]
  ashiato record --db <url> [--tables a,b] [--ignore-columns updated_at] [--port 4100] [--no-ui]
  ashiato show <session.json> [--port 4100]
  ashiato export <session.json> [--format xlsx,pdf,html] [--out <file>] [--lang ja|en] [--changed-only] [--no-screens]
  ashiato codegen <session.json> [--out <file>] [--name <title>]
  ashiato checkpoint [label] [--recorder <url>] [--json] [--no-values]
  ashiato steps [<session.json>] [--recorder <url>] [--since <id>] [--full] [--json] [--no-values]
  ashiato mcp --db <url> [record options] [--share-values]   (or --recorder <url>)

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

Export (evidence of a saved session):
  --format <list>         xlsx, pdf and / or html (default xlsx). PDF needs Chrome or Edge.
  --out <file>            Output file (default: next to the session file, same name)
  --lang <ja|en>          Language of the document (default: the machine's)
  --changed-only          Leave out steps that changed no rows
  --no-screens            No screenshots of the screen replay / recordings
  --browser <path>        Chrome / Edge used for PDF and screenshots (or set ASHIATO_BROWSER)

Codegen (a Playwright test made from a saved session, using ashiato/playwright):
  --out <file>            Output file, or - for the terminal (default: next to the session file, .spec.ts)
  --name <title>          The test's title (default: "recorded <date>")

For AI agents and scripts:
  checkpoint              Takes a checkpoint in a running \`ashiato record\` and prints what changed
  steps                   Prints the steps of a saved session, or of a running recorder
  --recorder <url>        The running recorder (default http://127.0.0.1:<port>)
  --since <id>            Only steps after this one
  --full                  Every step in full (requests and changed rows), not one line each
  --json                  JSON instead of text
  --no-values             Tables, columns and counts only: no row values
  mcp                     An MCP server (stdio) for AI agents: start_recording, checkpoint, list_steps,
                          get_step, stop_recording, generate_test, export_evidence, list_tables.
                          With --db it records itself (timeline on --port); with --recorder it reads
                          a running \`ashiato record\`.
  --share-values          mcp: give the AI the rows' values. Without it the AI sees tables, columns and
                          counts only, and gets the paths of generated tests and evidence, not their
                          contents (an AI in the cloud would otherwise receive your data).

While recording, press Enter to take a checkpoint (type a label first if you like).
`;

/** The package's version (dist/*.js and src/cli/*.ts are one and two folders down). */
function packageVersion(): string {
  for (const path of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "ashiato" && pkg.version) return pkg.version;
    } catch {
      // not there
    }
  }
  return "unknown";
}

const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** East Asian wide characters (CJK, kana, hangul, fullwidth forms) take two terminal columns. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const padColumns = (s: string, width: number) => s + " ".repeat(Math.max(0, width - [...s].reduce((n, c) => n + (WIDE.test(c) ? 2 : 1), 0)));

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
      format: { type: "string" },
      lang: { type: "string" },
      "changed-only": { type: "boolean" },
      "no-screens": { type: "boolean" },
      browser: { type: "string" },
      name: { type: "string" },
      recorder: { type: "string" },
      since: { type: "string" },
      full: { type: "boolean" },
      json: { type: "boolean" },
      "no-values": { type: "boolean" },
      "share-values": { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) return void console.log(packageVersion());
  if (values.help || !command) return void process.stdout.write(HELP);

  const port = Number(values.port ?? 4100);
  const dbUrl = values.db ?? process.env.ASHIATO_DB_URL;

  if (command === "show") {
    const file = rest[0];
    if (!file) throw new Error("Usage: ashiato show <session.json>");
    const session = loadSession(resolve(file));
    const media = new MediaStore(resolve(file), session, undefined, true);
    await listen(port, { uiDir: uiDir(), getSession: () => session, media, sessionFile: resolve(file), browser: values.browser });
    console.log(`Viewing ${file} at http://127.0.0.1:${port}  (Ctrl+C to quit)`);
    return;
  }

  if (command === "export") {
    const file = rest[0];
    if (!file) throw new Error("Usage: ashiato export <session.json> [--format xlsx,pdf,html]");
    const formats = (list(values.format) ?? ["xlsx"]).map((f) => f.toLowerCase());
    const unknown = formats.filter((f) => !EXPORT_FORMATS.includes(f as ExportFormat));
    if (unknown.length) throw new Error(`Unknown export format: ${unknown.join(", ")} (use ${EXPORT_FORMATS.join(", ")})`);
    if (values.lang && values.lang !== "ja" && values.lang !== "en") throw new Error("--lang must be ja or en");
    const path = resolve(file);
    const session = loadSession(path);
    const { files, notes } = await exportEvidence(session, {
      formats: formats as ExportFormat[],
      lang: values.lang as Lang | undefined,
      changedOnly: values["changed-only"],
      screens: !values["no-screens"],
      browser: values.browser,
      media: new MediaStore(path, session, undefined, true),
      sessionFile: path,
      log: (m) => console.log(m),
    });
    // --out evidence/login.xlsx, --out evidence/login (for several formats) or --out evidence/ (a folder)
    let out = values.out ? resolve(values.out) : path;
    if (values.out && (/[/\\]$/.test(values.out) || statSync(out, { throwIfNoEntry: false })?.isDirectory())) out = join(out, basename(path));
    const ext = extname(out);
    const base = EXPORT_FORMATS.includes(ext.slice(1).toLowerCase() as ExportFormat) || ext.toLowerCase() === ".json" ? out.slice(0, -ext.length) : out;
    for (const [format, data] of Object.entries(files)) {
      const target = `${base}.${format}`;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      console.log(`Wrote ${target}`);
    }
    for (const n of notes) console.log(`Note: ${n}`);
    return;
  }

  if (command === "codegen") {
    const file = rest[0];
    if (!file) throw new Error("Usage: ashiato codegen <session.json> [--out <file>]");
    const path = resolve(file);
    const session = loadSession(path);
    const media = new MediaStore(path, session, undefined, true);
    const code = await generateTest(session, { media, sessionFile: basename(path), name: values.name });
    if (values.out === "-") return void process.stdout.write(code);
    const out = values.out ? resolve(values.out) : path.replace(/(\.json)?$/i, ".spec.ts");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, code);
    console.log(`Wrote ${out}`);
    if (!media.replayPath()) {
      console.log("Note: the session has no screen replay, so the test's actions are left as TODOs. Record with the Vite plugin to get them.");
    }
    return;
  }

  if (command === "checkpoint" || command === "steps") {
    const file = command === "steps" ? rest[0] : undefined;
    const source = file ? fileSource(resolve(file)) : recorderSource(values.recorder ?? `http://127.0.0.1:${port}`);
    const shown = { values: !values["no-values"] };
    if (command === "checkpoint") {
      const step = await source.checkpoint(rest.join(" ").trim() || "checkpoint", "cli");
      if (!step) return void console.log(values.json ? "null" : "No changes.");
      return void console.log(values.json ? JSON.stringify(shown.values ? step : stepShape(step), null, 2) : stepText(step, shown));
    }
    const since = Number(values.since ?? 0);
    const steps = (await source.session()).steps.filter((s) => s.id > since);
    if (values.json) return void console.log(JSON.stringify(shown.values ? steps : steps.map(stepShape), null, 2));
    return void console.log(steps.map((s) => (values.full ? `${stepText(s, shown)}\n` : stepLine(s))).join("\n") || "No steps.");
  }

  if (command === "mcp") {
    if (!dbUrl && !values.recorder) throw new Error("ashiato mcp needs --db <url> (it records) or --recorder <url> (it reads a running ashiato record)");
    const log = (m: string) => process.stderr.write(`ashiato: ${m}\n`);
    const agent = agentTools({
      db: values.recorder ? undefined : dbUrl,
      recorder: values.recorder,
      shareValues: values["share-values"],
      tables: list(values.tables),
      ignoreColumns: list(values["ignore-columns"]),
      maxRows: values["max-rows"] ? Number(values["max-rows"]) : undefined,
      incremental: !values["full-read"],
      out: values.out,
      port: values["no-ui"] ? false : port,
      browser: values.browser,
      log,
    });
    const close = async () => {
      await agent.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void close());
    process.on("SIGTERM", () => void close());
    log(`MCP server ready on stdio (${values.recorder ? `reading ${values.recorder}` : "records when asked"}; row values ${values["share-values"] ? "shared" : "not shared"} with the AI)`);
    await serveMcp(agent.tools, { name: "ashiato", version: packageVersion(), instructions: agent.instructions }, { input: process.stdin, output: process.stdout });
    return close();
  }

  if (!dbUrl) throw new Error("--db <url> (or ASHIATO_DB_URL) is required");
  const db = await connect(dbUrl);

  if (command === "tables") {
    if (values.json) {
      const tables = [];
      for (const t of await db.listTables()) tables.push({ table: tableId(t), schema: t.schema, name: t.name, rows: await db.countRows(t), key: await db.primaryKey(t) });
      console.log(JSON.stringify(tables, null, 2));
      await db.close();
      return;
    }
    for (const t of await db.listTables()) {
      const key = await db.primaryKey(t);
      const rows = await db.countRows(t);
      console.log(`${padColumns(tableId(t), 40)} ${String(rows).padStart(10)} rows  key: ${key.length ? key.join(", ") : "(none)"}`);
    }
    await db.close();
    return;
  }

  if (command !== "record") throw new Error(`Unknown command: ${command}\n\n${HELP}`);

  // tables that stay skipped (too large) are reported again only when the set or a reason changes
  // (row counts of a too-large table change all the time; only an error's text is worth repeating)
  const kind = (reason: string) => (reason.startsWith("could not be read") ? reason : /more than max rows/.test(reason) ? "too large" : "");
  const skippedText = (list: { table: TableRef; reason: string }[]) => JSON.stringify(list.map((s) => [tableId(s.table), kind(s.reason)]));
  let lastSkipped: string | undefined;
  const recording = await startRecording(db, {
    tables: list(values.tables),
    ignoreColumns: list(values["ignore-columns"]),
    maxRows: values["max-rows"] ? Number(values["max-rows"]) : undefined,
    incremental: !values["full-read"],
    out: values.out,
    port: values["no-ui"] ? false : port,
    browser: values.browser,
    onStep: (step, error) => {
      if (error) console.error(error.message);
      const skipped = skippedText(step.skipped ?? []);
      console.log(formatStep(step, 5, skipped !== lastSkipped));
      lastSkipped = skipped;
    },
  }).catch(async (e: Error) => {
    await db.close().catch(() => undefined);
    throw e;
  });
  const { recorder, session, file } = recording;

  console.log(`Watching ${session.tables.length} table(s) on ${db.dialect}. Baseline snapshot taken.`);
  for (const s of recorder.skippedTables()) {
    console.log(`  skipped ${tableId(s.table)} (${s.error ? `could not be read: ${s.error}` : `${s.rowCount} rows > --max-rows`})`);
  }
  for (const f of recorder.fullReadTables()) {
    console.log(`  ${tableId(f.table)} is read in full at each checkpoint (${f.reason})`);
  }
  lastSkipped = skippedText(recorder.skippedTables().map((s) => ({ table: s.table, reason: s.error ? `could not be read: ${s.error}` : "more than max rows" })));
  if (recording.url) console.log(`Timeline: ${recording.url}`);
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
