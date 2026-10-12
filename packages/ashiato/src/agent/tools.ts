import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connect } from "../adapters/index.js";
import type { DbAdapter } from "../adapters/types.js";
import { startRecording, type Recording, type RecordingOptions } from "../cli/recording.js";
import { tableId } from "../core/diff.js";
import { evidenceBase, outputFile } from "../core/store.js";
import { EXPORT_FORMATS, type ExportFormat } from "../export/index.js";
import type { Lang } from "../export/text.js";
import type { McpTool } from "./mcp.js";
import { fileSource, recorderSource, recordingSource, type SessionSource } from "./source.js";
import { stepLine, stepText } from "./text.js";

export interface AgentOptions extends Omit<RecordingOptions, "onStep"> {
  /** Connection URL of the database to record (this process records). */
  db?: string;
  /** URL of a recorder started with `ashiato record` (it records; this process reads). */
  recorder?: string;
  /** Give the AI the rows' values. Default: tables, columns and counts only. */
  shareValues?: boolean;
  /** Messages for the person running the server (stderr: stdout is the protocol). */
  log?: (message: string) => void;
}

export interface AgentTools {
  tools: McpTool[];
  instructions: string;
  /** Saves the recording and closes the database connection. */
  close(): Promise<void>;
}

const sessionFileArg = {
  session_file: { type: "string", description: "A saved session file (.json) to read instead of the current recording" },
};

/** The tools of `ashiato mcp`: record the database while the AI works, and read what each step changed. */
export function agentTools(options: AgentOptions): AgentTools {
  const values = options.shareValues ?? false;
  const log = options.log ?? (() => undefined);
  let db: DbAdapter | undefined;
  let recording: Recording | undefined;
  /** The recording stopped last: still read by default. */
  let stopped: string | undefined;

  const database = async () => {
    if (!options.db) throw new Error("This server reads a recorder started with `ashiato record`: it has no database connection of its own.");
    return (db ??= await connect(options.db));
  };
  const source = (args: Record<string, unknown>): SessionSource => {
    if (typeof args.session_file === "string" && args.session_file) return fileSource(resolve(args.session_file));
    if (recording) return recordingSource(recording);
    if (options.recorder) return recorderSource(options.recorder);
    if (stopped) return fileSource(stopped);
    throw new Error("Nothing recorded yet: call start_recording first (or pass session_file).");
  };
  /** Where a file made from the session goes: `out` (a file or a folder), or next to the session file (else in the working directory). */
  const sessionFile = async (s: SessionSource) => s.file ?? resolve(`ashiato-${(await s.session()).startedAt.replace(/[:.]/g, "-")}.json`);
  const given = (out: unknown) => (typeof out === "string" && out ? out : undefined);
  const valuesNote = values ? "" : " Row values are not shown (the server was started without --share-values): you see tables, columns and counts.";

  const tools: McpTool[] = [
    {
      name: "list_tables",
      description: "The database's tables, with their row counts and primary keys (or, reading another recorder, the tables it watches).",
      inputSchema: { type: "object", properties: {} },
      async run() {
        if (!options.db) {
          const s = await source({}).session();
          return `${s.tables.length} tables watched by ${source({}).name}:\n${s.tables.map((t) => `  ${tableId(t)}`).join("\n")}`;
        }
        const conn = await database();
        const lines: string[] = [];
        for (const t of await conn.listTables()) lines.push(`  ${tableId(t)}: ${await conn.countRows(t)} rows, key: ${(await conn.primaryKey(t)).join(", ") || "(none)"}`);
        return `${lines.length} tables (${conn.dialect}):\n${lines.join("\n")}`;
      },
    },
    {
      name: "start_recording",
      description:
        "Takes a baseline snapshot of the database (read-only) and starts recording. From then on, each action in the app (with the ashiato Vite plugin) or each checkpoint call becomes a step that says which rows were inserted, updated and deleted.",
      inputSchema: {
        type: "object",
        properties: {
          tables: { type: "array", items: { type: "string" }, description: "Tables to watch (default: all)" },
          ignore_columns: { type: "array", items: { type: "string" }, description: "Columns whose changes alone don't count as an update, e.g. updated_at" },
          max_rows: { type: "number", description: "Tables with more rows than this are skipped (default 100000)" },
        },
      },
      async run(args) {
        if (!options.db) throw new Error(`Recording is done by the recorder at ${options.recorder}; read its steps with list_steps.`);
        if (recording) throw new Error(`Already recording (${recording.file}): call stop_recording first.`);
        const list = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String) : undefined);
        recording = await startRecording(await database(), {
          ...options,
          tables: list(args.tables) ?? options.tables,
          ignoreColumns: list(args.ignore_columns) ?? options.ignoreColumns,
          maxRows: typeof args.max_rows === "number" ? args.max_rows : options.maxRows,
          onStep: (step, error) => log(error ? error.message : stepLine(step)),
        });
        const r = recording;
        log(`Recording to ${r.file}${r.url ? `, timeline at ${r.url}` : ""}`);
        // a database's error message can quote a row's value
        const unreadable = (error: string) => (values ? `could not be read: ${error}` : "could not be read (the database's message is not shown)");
        const skipped = r.recorder.skippedTables().map((s) => `  ${tableId(s.table)}: ${s.error ? unreadable(s.error) : `${s.rowCount} rows, more than max rows`}`);
        return [
          `Recording ${r.session.tables.length} tables on ${r.session.dialect}: baseline taken.`,
          `Session file: ${r.file}`,
          ...(r.url ? [`Timeline: ${r.url} (the Vite plugin sends the app's actions here; each becomes a step)`] : []),
          ...(skipped.length ? ["Not compared:", ...skipped] : []),
          "Next: use the app, or do something (run the app's code, a script, a test) and call checkpoint. Read the steps with list_steps and get_step.",
        ].join("\n");
      },
    },
    {
      name: "checkpoint",
      description: `Reads the database now and records what changed since the previous step, as a new step.${valuesNote}`,
      inputSchema: { type: "object", properties: { label: { type: "string", description: "What was just done, e.g. 'ran the import'" } } },
      async run(args) {
        const s = recording ? recordingSource(recording) : options.recorder ? recorderSource(options.recorder) : undefined;
        if (!s) throw new Error("Not recording: call start_recording first.");
        const step = await s.checkpoint(typeof args.label === "string" && args.label.trim() ? args.label.trim() : "checkpoint", "mcp");
        return step ? stepText(step, { values }) : "No changes.";
      },
    },
    {
      name: "list_steps",
      description: "The steps recorded so far, one line each: what was done and how many rows of which tables changed.",
      inputSchema: { type: "object", properties: { since: { type: "number", description: "Only steps after this step id" }, ...sessionFileArg } },
      async run(args) {
        const s = source(args);
        const session = await s.session();
        const since = typeof args.since === "number" ? args.since : 0;
        const steps = session.steps.filter((st) => st.id > since);
        const head = `${s.name}: ${session.dialect}, started ${session.startedAt}, ${session.tables.length} tables watched, ${session.steps.length} steps`;
        return [head, ...steps.map((st) => stepLine(st, { values }))].join("\n");
      },
    },
    {
      name: "get_step",
      description: `One step in full: the user's action, the requests the page sent (HTTP and WebView2), and the changed rows of each table.${valuesNote}`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "number", description: "The step id (#n)" }, max_rows: { type: "number", description: "Rows shown per kind and table (default 20)" }, ...sessionFileArg },
        required: ["id"],
      },
      async run(args) {
        const step = (await source(args).session()).steps.find((st) => st.id === Number(args.id));
        if (!step) throw new Error(`There is no step #${String(args.id)}`);
        return stepText(step, { values, maxRows: typeof args.max_rows === "number" ? args.max_rows : undefined });
      },
    },
    {
      name: "stop_recording",
      description: "Stops recording and saves the session file. Its steps can still be read.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        if (!recording) throw new Error(options.recorder ? "The recorder runs in `ashiato record`: stop it there (Ctrl+C)." : "Not recording.");
        const r = recording;
        recording = undefined;
        await r.stop();
        stopped = r.file;
        return `Saved ${r.session.steps.length} steps to ${r.file}`;
      },
    },
    {
      name: "generate_test",
      description:
        "Writes a Playwright test made from the recording: it does again what was done in the browser (from the screen replay) and checks with expectDbChanges that each step changes the same rows. Returns the file's path" +
        (values ? " and its code." : " (its code holds row values, so it is not returned)."),
      inputSchema: {
        type: "object",
        properties: { out: { type: "string", description: "Output file (default: next to the session file, .spec.ts)" }, name: { type: "string", description: "The test's title" }, ...sessionFileArg },
      },
      async run(args) {
        const s = source(args);
        const code = await s.test(typeof args.name === "string" ? args.name : undefined);
        const file = outputFile(await sessionFile(s), ".spec.ts", given(args.out));
        write(file, code);
        const todos = (code.match(/\/\/ TODO/g) ?? []).length;
        const checks = (code.match(/await expectDbChanges\(/g) ?? []).length;
        const summary = `Wrote ${file}: ${checks} steps checked${todos ? `, ${todos} TODOs to fill in` : ""}. Run it on a database put back in its state from before the recording, with ASHIATO_DB_URL set: npx playwright test --workers=1`;
        return values ? `${summary}\n\n${code}` : summary;
      },
    },
    {
      name: "export_evidence",
      description: "Writes the session's evidence (each step with its screen and changed rows) as Excel, PDF and / or HTML files, and returns their paths.",
      inputSchema: {
        type: "object",
        properties: {
          formats: { type: "array", items: { type: "string", enum: EXPORT_FORMATS }, description: "Default: xlsx. PDF needs Chrome or Edge." },
          lang: { type: "string", enum: ["ja", "en"] },
          changed_only: { type: "boolean", description: "Leave out steps that changed nothing" },
          out: { type: "string", description: "Output file without extension (default: next to the session file)" },
          ...sessionFileArg,
        },
      },
      async run(args) {
        const formats = (Array.isArray(args.formats) && args.formats.length ? args.formats.map(String) : ["xlsx"]) as ExportFormat[];
        const unknown = formats.filter((f) => !EXPORT_FORMATS.includes(f));
        if (unknown.length) throw new Error(`Unknown format: ${unknown.join(", ")} (use ${EXPORT_FORMATS.join(", ")})`);
        const s = source(args);
        const base = evidenceBase(await sessionFile(s), given(args.out), EXPORT_FORMATS);
        const lines: string[] = [];
        for (const format of formats) {
          const { data, notes } = await s.evidence(format, { lang: args.lang === "en" || args.lang === "ja" ? (args.lang as Lang) : undefined, changedOnly: args.changed_only === true, browser: options.browser });
          write(`${base}.${format}`, data);
          lines.push(`Wrote ${base}.${format}`, ...notes.map((n) => `Note: ${n}`));
        }
        return lines.join("\n");
      },
    },
  ];

  const instructions = [
    "ashiato records which rows an app inserts, updates and deletes, with read-only database access.",
    options.db
      ? "Call start_recording before using the app; each action in the app (through the ashiato Vite plugin) or each checkpoint call becomes a step. Read steps with list_steps / get_step, then stop_recording."
      : `It reads the recorder at ${options.recorder}: each action in the app or checkpoint call becomes a step. Read steps with list_steps / get_step.`,
    "generate_test writes a Playwright regression test from the recording; export_evidence writes Excel / PDF evidence.",
    values ? "Row values are shared." : "Row values are not shared with you (only tables, columns and counts); the files written hold them.",
  ].join(" ");

  return {
    tools,
    instructions,
    async close() {
      if (recording) await recording.stop().catch(() => undefined);
      recording = undefined;
      await db?.close().catch(() => undefined);
    },
  };
}

function write(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}
