import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { connect } from "../adapters/index.js";
import type { DbAdapter } from "../adapters/types.js";
import { ActionRunner } from "../chat/auto.js";
import { DEFAULT_LOGIN, openBrowser } from "../chat/browser.js";
import { decodeText } from "../chat/decode.js";
import { existingTests, filesIn, readSessions } from "../chat/files.js";
import { leftOut, makePack } from "../chat/pack.js";
import { fileProblemsReport, runVerify, verifyReport } from "../chat/verify.js";
import { parseVerifyFile } from "../chat/verifyFile.js";
import { startRecording, type Recording, type RecordingOptions } from "../cli/recording.js";
import { tableId } from "../core/diff.js";
import { evidenceBase, outputFile } from "../core/store.js";
import { EXPORT_FORMATS, type ExportFormat } from "../export/index.js";
import { langOf, type Lang } from "../export/text.js";
import type { McpTool } from "./mcp.js";
import { fileSource, recorderSource, recordingSource, type SessionSource } from "./source.js";
import { stepLine, stepText } from "./text.js";
import { verifySummary } from "./verifyText.js";

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
  /** A path as this machine's person reads it: relative to the working directory when below it. */
  const display = (path: string) => {
    const rel = relative(process.cwd(), path);
    return (rel && !rel.startsWith("..") && !/^[a-z]:|^\//i.test(rel) ? rel : path).replace(/\\/g, "/");
  };
  /** The login to use: the one named, or the default one when it was saved. */
  const login = (named: unknown) => {
    const file = typeof named === "string" && named ? resolve(named) : resolve(DEFAULT_LOGIN);
    if (typeof named === "string" && named && !existsSync(file)) throw new Error(`${named} doesn't exist: save a login with \`ashiato verify --auto --login --app <url>\` first`);
    return existsSync(file) ? { storageState: file } : {};
  };

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
    {
      name: "pack",
      description:
        "Material for writing verifications of the app (checks/*.verify.md, run by verify_auto): how to write them, each page's accessibility tree (read in a browser, following the app's links), " +
        "which recorded actions changed which tables, the tables' definitions and the tests there are already. Read it, then write the verification files yourself." +
        (values ? "" : " Text on the pages that may show the database's values is replaced with … (the server was started without --share-values)."),
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "The app's URL (http://localhost:5173): its pages are read in a browser. Without it, only the tables and recordings" },
          pages: { type: "array", items: { type: "string" }, description: "Paths of pages to read instead of following links" },
          max_pages: { type: "number", description: "Pages read at most when following links (default 20)" },
          tables: { type: "array", items: { type: "string" }, description: "Tables to describe (* matches any characters; default: all)" },
          sessions: { type: "string", description: "A recording (.json) or a folder of them (default .ashiato/sessions)" },
          tests: { type: "string", description: "A folder of tests there are already (default: tests, e2e, test, playwright, checks)" },
          storage_state: { type: "string", description: `A login saved by \`ashiato verify --auto --login\` (default ${DEFAULT_LOGIN}, when there is one)` },
          ...(values ? { page_text: { type: "boolean", description: "Keep the pages' text (it may show the database's values)" } } : {}),
          max_chars: { type: "number", description: "At most this many characters (default 100000): the later parts are left out first" },
          lang: { type: "string", enum: ["ja", "en"], description: "Language of the instructions (default: the machine's)" },
          out: { type: "string", description: "Also write it to this file" },
        },
      },
      async run(args) {
        const lang = args.lang === "en" || args.lang === "ja" ? (args.lang as Lang) : langOf();
        const app = given(args.app);
        if (app && !/^https?:\/\//i.test(app)) throw new Error(`app takes the app's URL (http://localhost:5173), not "${app}"`);
        if (args.page_text && !values) throw new Error("page_text needs the server started with --share-values: the pages' text may show the database's values");
        const strings = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String) : undefined);
        const sessions = readSessions(given(args.sessions) ? [String(args.sessions)] : undefined, "sessions");
        const db = options.db ? await connect(options.db) : undefined;
        try {
          const made = await makePack({
            lang,
            app,
            browser: () => openBrowser("ashiato mcp", { app, browser: options.browser, ...login(args.storage_state) }),
            pages: strings(args.pages),
            maxPages: typeof args.max_pages === "number" ? args.max_pages : undefined,
            pageText: values && args.page_text === true,
            db,
            tables: strings(args.tables),
            sessions,
            tests: existingTests(given(args.tests) ? [String(args.tests)] : undefined, lang, display, "tests"),
            maxChars: typeof args.max_chars === "number" ? args.max_chars : undefined,
            log,
          });
          const out = given(args.out);
          if (out) write(resolve(out), made.pack.markdown);
          const left = leftOut(made.pack.left);
          const notes = [
            `${made.pages.length} page(s), ${made.actions.length} recorded action(s) from ${sessions.length} recording(s), ${made.tables.length} table(s)${left ? `; left out to fit: ${left}` : ""}${out ? `; also written to ${resolve(out)}` : ""}.`,
            "You are an agent: write each verification to checks/<name>.verify.md yourself (not in the chat), then run verify_auto on it and correct the steps it reports NG until they pass.",
            ...(values ? [] : ["Where the material says a person runs SELECT statements to find values, ask the person for the values you need instead (you are not given the database's values)."]),
          ];
          return `${notes.join("\n")}\n\n${made.pack.markdown}`;
        } finally {
          await db?.close();
        }
      },
    },
    {
      name: "verify_auto",
      description:
        "Checks verifications (checks/*.verify.md): does each step's actions in a browser with Playwright, waits for the database to settle and compares what changed with the step's expected changes. " +
        "Steps without actions are skipped (a person does them). Writes the full report to a file and returns " +
        (values ? "it." : "a summary without the database's values: verdicts, the action that failed and why, names on the page like the one written, the page's tree with values hidden, and what changed in counts and columns."),
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Verification files (.verify.md) or folders of them" },
          app: { type: "string", description: "The app's URL: the paths the steps open are of it" },
          tables: { type: "array", items: { type: "string" }, description: "Tables to watch (default: all)" },
          ignore_columns: { type: "array", items: { type: "string" }, description: "Columns whose changes alone don't count as an update, e.g. updated_at" },
          storage_state: { type: "string", description: `A login saved by \`ashiato verify --auto --login\` (default ${DEFAULT_LOGIN}, when there is one)` },
          headed: { type: "boolean", description: "Show the browser" },
          lang: { type: "string", enum: ["ja", "en"], description: "Language of the messages and the report (default: the machine's)" },
          out: { type: "string", description: "The report file (default .ashiato/verify/<file>.md)" },
        },
        required: ["files"],
      },
      async run(args) {
        if (!options.db) throw new Error("verify_auto reads the database itself: start the server with --db <url>.");
        const lang = args.lang === "en" || args.lang === "ja" ? (args.lang as Lang) : langOf();
        const app = given(args.app);
        if (app && !/^https?:\/\//i.test(app)) throw new Error(`app takes the app's URL (http://localhost:5173), not "${app}"`);
        const strings = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String) : undefined);
        const paths = strings(args.files);
        if (!paths) throw new Error("files: give the verification files (.verify.md) or folders of them");
        const files = filesIn(paths, /\.verify\.md$/i, ".verify.md").map((path) => ({ path, fileName: display(path), file: parseVerifyFile(decodeText(readFileSync(path)), lang) }));
        const wrong = files.filter((f) => f.file.problems.length || f.file.actionProblems.length);
        // what to correct: the files' own lines, no values
        if (wrong.length) {
          return [
            "Nothing was checked: correct these files first.",
            ...wrong.map((f) => fileProblemsReport(f.file, [...f.file.problems, ...f.file.actionProblems].sort((a, b) => a.line - b.line), { fileName: f.fileName, lang })),
          ].join("\n\n");
        }
        if (!files.some((f) => f.file.steps.some((st) => st.actions))) throw new Error("No step has actions (`Actions:` / `操作:`): verify_auto does those.");
        const db = await connect(options.db);
        let driven: Awaited<ReturnType<typeof openBrowser>> | undefined;
        try {
          driven = await openBrowser("ashiato mcp", { app, browser: options.browser, headed: args.headed === true, ...login(args.storage_state) });
          const auto = new ActionRunner(driven.page, { lang, app });
          const reports: string[] = [];
          const summaries: string[] = [];
          for (const { fileName, file } of files) {
            const run = await runVerify(db, file, {
              lang,
              tables: strings(args.tables) ?? options.tables,
              ignoreColumns: strings(args.ignore_columns) ?? options.ignoreColumns,
              maxRows: options.maxRows,
              incremental: options.incremental,
              // steps without actions are a person's: skipped
              ask: async () => "s",
              log: () => undefined,
              auto,
            });
            if (run.problems) {
              summaries.push(`${fileName}: nothing checked:\n${run.problems.map((p) => `  ${p}`).join("\n")}`);
              continue;
            }
            reports.push(verifyReport(file, run, { fileName, dialect: db.dialect, lang }));
            summaries.push(values ? reports.at(-1)! : verifySummary(run, { fileName, lang }));
          }
          const out = resolve(given(args.out) ?? `.ashiato/verify/${basename(files[0]!.path).replace(/\.verify\.md$/i, "")}${files.length > 1 ? "-and-more" : ""}.md`);
          if (reports.length) write(out, reports.join("\n"));
          return [...summaries, ...(reports.length ? [`Report${values ? "" : " (with the rows' values, for the person)"}: ${out}`] : [])].join("\n\n");
        } finally {
          await driven?.close().catch(() => undefined);
          await db.close();
        }
      },
    },
  ];

  const instructions = [
    "ashiato records which rows an app inserts, updates and deletes, with read-only database access.",
    options.db
      ? "Call start_recording before using the app; each action in the app (through the ashiato Vite plugin) or each checkpoint call becomes a step. Read steps with list_steps / get_step, then stop_recording."
      : `It reads the recorder at ${options.recorder}: each action in the app or checkpoint call becomes a step. Read steps with list_steps / get_step.`,
    "generate_test writes a Playwright regression test from the recording; export_evidence writes Excel / PDF evidence.",
    "To write end-to-end checks of the app: call pack (with app), write checks/*.verify.md as it says, run verify_auto and correct the NG steps; `npx ashiato export-tests checks/` then turns them into Playwright tests.",
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
