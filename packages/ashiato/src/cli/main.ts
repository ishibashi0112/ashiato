import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect, dialectOf } from "../adapters/index.js";
import { serveMcp } from "../agent/mcp.js";
import { writeClipboard } from "../chat/clipboard.js";
import { decodeText } from "../chat/decode.js";
import { planQueries, queryReport, refusedReport, runPlanned, type SqlFile } from "../chat/query.js";
import { schemaMarkdown } from "../chat/schema.js";
import { fileSource, recorderSource } from "../agent/source.js";
import { stepLine, stepShape, stepText } from "../agent/text.js";
import { agentTools } from "../agent/tools.js";
import { generateTest } from "../codegen/index.js";
import { tableId } from "../core/diff.js";
import { formatStep } from "../core/format.js";
import { MediaStore } from "../core/media.js";
import { evidenceBase, loadSession, outputFile, saveSession } from "../core/store.js";
import type { TableRef } from "../core/types.js";
import { EXPORT_FORMATS, exportEvidence, type ExportFormat } from "../export/index.js";
import { langOf, type Lang } from "../export/text.js";
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
  ashiato schema --db <url> [--tables a,b,M_*] [--no-views] [--out docs/db/schema.md] [--lang ja|en]
  ashiato query <file.sql | folder>... --db <url> [--max-rows 50] [--out <file>] [--no-clip] [--lang ja|en]

Options:
  --db <url>              Connection URL (or set ASHIATO_DB_URL). Read-only access is enough.
                          sqlite:./dev.db
                          mssql://user:pass@host:1433/db?instance=SQLEXPRESS
                          oracle://user:pass@host:1521/service?schema=OWNER  (&client=thick for Thick mode)
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

For AI chats (no agent: you carry the text between the chat and this machine):
  schema                  Writes the definitions of the tables and views (columns, types, primary keys,
                          comments) as Markdown, for the chat to write SQL against
  query                   Runs the statements of .sql files (a folder: its .sql files) read-only and
                          copies the results to the clipboard as Markdown, to paste into the chat.
                          Only SELECT / WITH statements: if any statement could write, none is run.
  --tables <list>         schema: tables and views to include; * and ? match any characters
  --no-views              schema: tables only
  --out <file>            schema: where to write it (default docs/db/schema.md; - for the terminal)
                          query: also write the results to this file (- for the terminal)
  --max-rows <n>          query: rows shown per statement (default 50)
  --no-clip               query: don't copy to the clipboard (without --out, the results are printed)
  --lang <ja|en>          schema / query: language of the text around the data (default: the machine's)

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

/** About what a chat (Microsoft 365 Copilot Chat) takes in one paste. */
const PASTE_LIMIT = 100_000;

const langOption = (v?: string): Lang => {
  if (v && v !== "ja" && v !== "en") throw new Error("--lang must be ja or en");
  return (v as Lang | undefined) ?? langOf();
};

/** A path as the report and the terminal show it: relative to here when it is below here, with / between folders. */
const shown = (path: string) => {
  const rel = relative(process.cwd(), path);
  return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path).split(sep).join("/");
};

/** The .sql files named (a folder: its .sql files, by name), read as UTF-8 or Shift_JIS. */
function readSqlFiles(paths: string[]): SqlFile[] {
  const files: string[] = [];
  for (const p of paths) {
    const path = resolve(p);
    if (statSync(path).isDirectory()) {
      const inFolder = readdirSync(path)
        .filter((f) => /\.sql$/i.test(f))
        .sort()
        .map((f) => join(path, f));
      if (!inFolder.length) throw new Error(`No .sql files in ${p}`);
      files.push(...inFolder);
    } else files.push(path);
  }
  return files.map((f) => {
    try {
      return { name: shown(f), text: decodeText(readFileSync(f)) };
    } catch (e) {
      throw new Error(`${shown(f)}: ${(e as Error).message}`);
    }
  });
}

async function runQueryCommand(paths: string[], values: { db?: string; out?: string; "max-rows"?: string; "no-clip"?: boolean; lang?: string }, dbUrl?: string) {
  if (!paths.length) throw new Error("Usage: ashiato query <file.sql | folder>... --db <url>");
  if (!dbUrl) throw new Error("--db <url> (or ASHIATO_DB_URL) is required");
  const dialect = dialectOf(dbUrl);
  if (!dialect) throw new Error(`Unsupported database URL: ${dbUrl.split(":")[0]}: (use sqlite:, mssql:, oracle:, postgres: or mysql:)`);
  const lang = langOption(values.lang);
  const maxRows = Number(values["max-rows"] ?? 50);
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new Error("--max-rows takes a number from 1 to 10000");

  // with --out -, stdout carries the results only
  const info = (m: string) => (values.out === "-" ? console.error(m) : console.log(m));
  const deliver = (markdown: string, what: string) => {
    if (values.out === "-") process.stdout.write(markdown);
    else if (values.out) {
      const out = resolve(values.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, markdown);
      console.log(`Wrote ${shown(out)}`);
    }
    if (values["no-clip"]) {
      if (!values.out) process.stdout.write(markdown);
    } else {
      const clip = writeClipboard(markdown);
      if (clip.ok) info(`Copied ${what} to the clipboard (${markdown.length.toLocaleString("en-US")} characters): paste it into the chat.`);
      else if (values.out) console.error(`Could not copy to the clipboard (${clip.message}).`);
      else {
        // nowhere else to go: show it here
        console.error(`Could not copy to the clipboard (${clip.message}). The text to paste:\n`);
        process.stdout.write(markdown);
      }
    }
    if (markdown.length > PASTE_LIMIT) info(`Note: a chat may cut off text this long (more than about ${PASTE_LIMIT.toLocaleString("en-US")} characters): lower --max-rows or run fewer statements.`);
  };

  const planned = planQueries(readSqlFiles(paths), dialect);
  if (!planned.length) throw new Error("No statements to run");
  const refused = planned.filter((p) => p.problem);
  if (refused.length) {
    // nothing is run, and the reasons go back to the chat so that it can rewrite the statements
    for (const p of refused) console.error(`${p.file}:${p.statement.line}: ${p.problem!.message}`);
    console.error(`Nothing was run: ${refused.length} statement(s) don't only read.`);
    deliver(refusedReport(planned, lang), "why nothing was run");
    process.exitCode = 1;
    return;
  }

  const db = await connect(dbUrl);
  try {
    let n = 0;
    const outcomes = await runPlanned(db, planned, maxRows, (o) => {
      const label = o.statement.title.split("\n")[0] || `${o.file}:${o.statement.line}`;
      const what = o.error !== undefined ? `error: ${o.error.split("\n")[0]}` : `${o.result!.rows.length}${o.result!.more ? "+" : ""} row(s)`;
      info(`${String(++n).padStart(3)}. ${padColumns(label, 50)} ${what}  (${o.ms} ms)`);
    });
    const errors = outcomes.filter((o) => o.error !== undefined).length;
    deliver(queryReport(outcomes, { dialect: db.dialect, lang, maxRows }), `the results of ${outcomes.length} statement(s)${errors ? `, ${errors} with an error,` : ""}`);
  } finally {
    await db.close();
  }
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
      "no-views": { type: "boolean" },
      "no-clip": { type: "boolean" },
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
    const base = evidenceBase(path, values.out, EXPORT_FORMATS);
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
    const out = outputFile(path, ".spec.ts", values.out);
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
    if (!Number.isInteger(since)) throw new Error(`--since takes a step id (a number), not "${values.since}"`);
    const steps = (await source.session()).steps.filter((s) => s.id > since);
    if (values.json) return void console.log(JSON.stringify(shown.values ? steps : steps.map(stepShape), null, 2));
    return void console.log(steps.map((s) => (values.full ? `${stepText(s, shown)}\n` : stepLine(s, shown))).join("\n") || "No steps.");
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
      // stdout to a pipe is written asynchronously on macOS: let the last answers out first
      await new Promise<void>((r) => process.stdout.write("", () => r()));
      process.exit(0);
    };
    process.on("SIGINT", () => void close());
    process.on("SIGTERM", () => void close());
    log(`MCP server ready on stdio (${values.recorder ? `reading ${values.recorder}` : "records when asked"}; row values ${values["share-values"] ? "shared" : "not shared"} with the AI)`);
    await serveMcp(agent.tools, { name: "ashiato", version: packageVersion(), instructions: agent.instructions }, { input: process.stdin, output: process.stdout });
    return close();
  }

  if (command === "query") return runQueryCommand(rest, values, dbUrl);

  if (!dbUrl) throw new Error("--db <url> (or ASHIATO_DB_URL) is required");
  const db = await connect(dbUrl);

  if (command === "schema") {
    const lang = langOption(values.lang);
    try {
      const { markdown, tables, views, unreadable } = await schemaMarkdown(db, { tables: list(values.tables), views: !values["no-views"], lang });
      if (values.out === "-") return void process.stdout.write(markdown);
      const out = resolve(values.out ?? join("docs", "db", "schema.md"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, markdown);
      console.log(`Wrote ${shown(out)} (${tables} table(s), ${views} view(s); ${markdown.length.toLocaleString("en-US")} characters)`);
      if (unreadable.length) console.log(`Could not read: ${unreadable.join(", ")}`);
      if (markdown.length > PASTE_LIMIT) console.log(`Note: that is more than a chat takes in one paste (about ${PASTE_LIMIT.toLocaleString("en-US")} characters): pick the tables with --tables.`);
    } finally {
      await db.close();
    }
    return;
  }

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
