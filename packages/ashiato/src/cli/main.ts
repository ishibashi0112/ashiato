import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect, dialectOf } from "../adapters/index.js";
import { serveMcp } from "../agent/mcp.js";
import { writeClipboard } from "../chat/clipboard.js";
import { decodeText } from "../chat/decode.js";
import { planQueries, queryReport, refusedReport, runPlanned, type SqlFile } from "../chat/query.js";
import { ignoredColumns, leftOut, makePack, type PackResult } from "../chat/pack.js";
import { existingTests, filesIn, readSessions } from "../chat/files.js";
import { schemaMarkdown } from "../chat/schema.js";
import { ActionRunner } from "../chat/auto.js";
import { DEFAULT_LOGIN, openBrowser, saveLogin, type BrowserOptions, type Driven } from "../chat/browser.js";
import { EXPORTED_HEADER, exportTest } from "../chat/exportTests.js";
import { fileProblemsReport, runVerify, stepOf, verdictText, verifyReport, type AutoRunner, type VerifyRun } from "../chat/verify.js";
import { parseVerifyFile, type FileProblem, type VerifyFile } from "../chat/verifyFile.js";
import { fileSource, recorderSource } from "../agent/source.js";
import { stepLine, stepShape, stepText } from "../agent/text.js";
import { agentTools } from "../agent/tools.js";
import { generateTest } from "../codegen/index.js";
import { tableId } from "../core/diff.js";
import { formatStep } from "../core/format.js";
import { MediaStore } from "../core/media.js";
import { evidenceBase, loadSession, outputFile, saveSession, sessionPath } from "../core/store.js";
import type { Session, TableRef } from "../core/types.js";
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
  ashiato verify <file.verify.md | folder>... --db <url> [--tables a,b] [--ignore-columns c] [--out <file>] [--no-clip] [--save-session] [--lang ja|en]
                 [--auto --app <url> [--login] [--storage-state <file>] [--headed] [--cdp <url>]]
  ashiato pack [--app <url> [--login] [--storage-state <file>] [--page-text]] [--db <url>] [--pages /a,/b] [--sessions <folder>]
               [--tests <folder>] [--code <file>] [--out <file>] [--max-chars 100000]
  ashiato export-tests <file.verify.md | folder>... [--out tests/e2e/] [--app <url>] [--ignore-columns c] [--force]

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
                          get_step, stop_recording, generate_test, export_evidence, list_tables, pack, verify_auto.
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
  verify                  Shows the steps of a verification the chat wrote, one at a time: you do what a
                          step says and press Enter, and the changes in the database are compared with
                          the ones it expects (see the README). The results (OK / NG, what differs, the
                          rows that changed) are copied to the clipboard as Markdown.
  --tables <list>         schema: tables and views to include; * and ? match any characters
                          verify: tables to watch, as for record (default: all)
  --no-views              schema: tables only
  --out <file>            schema: where to write it (default docs/db/schema.md; - for the terminal)
                          query / verify: also write the results to this file (- for the terminal)
  --max-rows <n>          query: rows shown per statement (default 50)
                          verify: tables with more rows than this are not watched (default 100000)
  --no-clip               query / verify: don't copy to the clipboard (without --out, the results are printed)
  --save-session          verify: also save the changes as a session in .ashiato/sessions (for export / show)
  --lang <ja|en>          schema / query / verify / pack: language of the text around the data (default: the machine's)

End-to-end checks from a chat (the chat writes the steps, ashiato runs them in a browser with Playwright):
  pack                    Material for the chat in one text: what to write and how, each page's accessibility
                          tree (read in a browser, following the app's links; text that may show the database's
                          values is replaced with …), which recorded actions changed which tables (from
                          .ashiato/sessions), the table definitions and the tests there are already.
                          Written to docs/ashiato/pack.md and copied to the clipboard.
  verify --auto           Does the steps' actions (\`操作:\` / \`Actions:\` lines) in a browser and compares what
                          changed with what each step expects. A step that fails says why, with the names on
                          the page like the one written and the page's tree. Steps without actions: you do them.
  export-tests            Each verification as a Playwright test (tests/e2e/<name>.spec.ts, ashiato/playwright)
  --app <url>             The app's URL (pack: its pages are read; verify / export-tests: paths open from it)
  --login                 Open the app in a browser to log in first; the login is saved to .ashiato/login.json
                          and used from then on (it holds cookies: keep it out of version control)
  --storage-state <file>  A login saved with --login (default .ashiato/login.json, when there is one)
  --headed                Show the browser
  --cdp <url>             Use a browser that is already running (a WebView2 app started with
                          --remote-debugging-port), at http://127.0.0.1:<port>
  --pages <list>          pack: paths to read instead of following links
  --max-pages <n>         pack: pages read at most when following links (default 20)
  --page-text             pack: keep the pages' text (it may show the database's values)
  --sessions <path>       pack: recordings (a folder or .json files; default .ashiato/sessions)
  --tests <folder>        pack: where the tests there are already are (default tests, e2e, test, playwright, checks)
  --code <file>           pack: code to add at the end (e.g. repomix's output), as much as fits
  --max-chars <n>         pack: at most this many characters (default 100000); the later parts are left out first
  --out <path>            pack: the file (default docs/ashiato/pack.md; - for the terminal)
                          export-tests: the folder (default tests/e2e/), or a file for one verification
  --force                 export-tests: overwrite tests that export-tests didn't write

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
  const files = filesIn(paths, /\.sql$/i, ".sql");
  return files.map((f) => {
    try {
      return { name: shown(f), text: decodeText(readFileSync(f)) };
    } catch (e) {
      throw new Error(`${shown(f)}: ${(e as Error).message}`);
    }
  });
}

interface DeliverValues {
  out?: string;
  "no-clip"?: boolean;
}

/** With --out -, stdout carries the results only. */
const infoFor = (values: DeliverValues) => (m: string) => (values.out === "-" ? console.error(m) : console.log(m));

/** Puts a report for the chat on the clipboard, and in the file --out names (- for stdout). */
function deliverReport(markdown: string, what: string, values: DeliverValues, shorter: string): void {
  const info = infoFor(values);
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
  if (markdown.length > PASTE_LIMIT) info(`Note: a chat may cut off text this long (more than about ${PASTE_LIMIT.toLocaleString("en-US")} characters): ${shorter}.`);
}

async function runQueryCommand(paths: string[], values: { db?: string; out?: string; "max-rows"?: string; "no-clip"?: boolean; lang?: string }, dbUrl?: string) {
  if (!paths.length) throw new Error("Usage: ashiato query <file.sql | folder>... --db <url>");
  if (!dbUrl) throw new Error("--db <url> (or ASHIATO_DB_URL) is required");
  const dialect = dialectOf(dbUrl);
  if (!dialect) throw new Error(`Unsupported database URL: ${dbUrl.split(":")[0]}: (use sqlite:, mssql:, oracle:, postgres: or mysql:)`);
  const lang = langOption(values.lang);
  const maxRows = Number(values["max-rows"] ?? 50);
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new Error("--max-rows takes a number from 1 to 10000");

  const info = infoFor(values);
  const deliver = (markdown: string, what: string) => deliverReport(markdown, what, values, "lower --max-rows or run fewer statements");

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

interface BrowserValues {
  app?: string;
  headed?: boolean;
  browser?: string;
  cdp?: string;
  login?: boolean;
  "storage-state"?: string;
}

interface VerifyValues extends DeliverValues, BrowserValues {
  tables?: string;
  "ignore-columns"?: string;
  "max-rows"?: string;
  "full-read"?: boolean;
  "save-session"?: boolean;
  lang?: string;
  auto?: boolean;
}

/** The browser options of `pack` and `verify --auto`, with the login to use: `--login` saves one first (the person logs in). */
async function browserOptions(values: BrowserValues, ask: (prompt: string) => Promise<string | null>): Promise<BrowserOptions> {
  const options: BrowserOptions = { app: values.app, headed: values.headed, browser: values.browser, cdp: values.cdp };
  if (values.app && !/^https?:\/\//i.test(values.app)) throw new Error(`--app takes the app's URL (http://localhost:5173), not "${values.app}"`);
  const login = resolve(values["storage-state"] ?? DEFAULT_LOGIN);
  if (values.login) {
    if (!values.app) throw new Error("--login needs --app <url>: the page to log in on");
    if (values.cdp) throw new Error("--login is for a browser ashiato starts: with --cdp, log in in the app itself");
    console.log(`Opening ${values.app}: log in, then come back here.`);
    await saveLogin({ ...options, app: values.app, file: login, waitForPerson: () => ask("When you have logged in, press Enter > ") });
    console.log(`Saved the login to ${shown(login)} (it holds the session's cookies: keep it out of version control).`);
  }
  if (values["storage-state"] && !values.login && !existsSync(login)) throw new Error(`${values["storage-state"]} doesn't exist: save a login with --login first`);
  if (!values.cdp && existsSync(login)) {
    if (!values.login && !values["storage-state"]) console.log(`Using the login saved in ${shown(login)}.`);
    options.storageState = login;
  }
  return options;
}

async function runVerifyCommand(paths: string[], values: VerifyValues, dbUrl?: string) {
  if (!paths.length) throw new Error("Usage: ashiato verify <file.verify.md | folder>... --db <url>");
  if (!dbUrl) throw new Error("--db <url> (or ASHIATO_DB_URL) is required");
  if (!dialectOf(dbUrl)) throw new Error(`Unsupported database URL: ${dbUrl.split(":")[0]}: (use sqlite:, mssql:, oracle:, postgres: or mysql:)`);
  const lang = langOption(values.lang);
  const maxRows = values["max-rows"] === undefined ? undefined : Number(values["max-rows"]);
  if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 1)) throw new Error("--max-rows takes a number of rows");
  for (const option of ["app", "headed", "cdp", "login", "storage-state"] as const) {
    if (values[option] !== undefined && !values.auto) throw new Error(`--${option} is for --auto (the steps' actions are done in a browser)`);
  }
  const files = filesIn(paths, /\.verify\.md$/i, ".verify.md").map((path) => {
    const fileName = shown(path);
    try {
      return { fileName, file: parseVerifyFile(decodeText(readFileSync(path)), lang) };
    } catch (e) {
      throw new Error(`${fileName}: ${(e as Error).message}`);
    }
  });
  const deliver = (markdown: string, what: string) => deliverReport(markdown, what, values, "split the steps into several files");
  const sendBack = (list: { fileName: string; file: VerifyFile; problems: (FileProblem | string)[] }[], why: string) => {
    // nothing is checked, and what to correct goes back to the chat
    for (const { fileName, problems } of list) for (const p of problems) console.error(typeof p === "string" ? `${fileName}: ${p}` : `${fileName}:${p.line}: ${p.message}`);
    console.error(why);
    deliver(list.map(({ fileName, file, problems }) => fileProblemsReport(file, problems as FileProblem[], { fileName, lang })).join("\n"), "what to correct");
    process.exitCode = 1;
  };
  const wrong = files
    .map((f) => ({ ...f, problems: [...f.file.problems, ...(values.auto ? f.file.actionProblems : [])].sort((a, b) => a.line - b.line) }))
    .filter((f) => f.problems.length);
  if (wrong.length) return sendBack(wrong, "Nothing was checked: the file needs correcting.");
  if (values.auto && !files.some((f) => f.file.steps.some((s) => s.actions))) {
    const problem = lang === "ja" ? "「操作:」の行がある手順がありません(--auto はその操作を実行します)。" : "No step has actions (`Actions:`): --auto does those.";
    return sendBack(files.map((f) => ({ ...f, problems: [{ line: 1, message: problem }] })), "Nothing was checked: no step has actions.");
  }

  const db = await connect(dbUrl);
  const input = lineReader();
  // Ctrl+C ends the steps; the results so far are still copied
  const interrupted = () => input.close();
  process.once("SIGINT", interrupted);
  let driven: Driven | undefined;
  try {
    let auto: AutoRunner | undefined;
    if (values.auto) {
      const options = await browserOptions(values, input.ask);
      driven = await openBrowser("verify --auto", options);
      auto = new ActionRunner(driven.page, { lang, app: values.app });
    }
    const reports: string[] = [];
    const runs: { fileName: string; run: VerifyRun }[] = [];
    for (const { fileName, file } of files) {
      if (files.length > 1) console.log(`\n=== ${fileName}`);
      const run = await runVerify(db, file, {
        lang,
        tables: list(values.tables),
        ignoreColumns: list(values["ignore-columns"]),
        maxRows,
        incremental: !values["full-read"],
        ask: input.ask,
        log: (m) => console.log(m),
        auto,
      });
      if (run.problems) return sendBack([{ fileName, file, problems: run.problems }], "Nothing more was checked: the file names tables that aren't watched.");
      runs.push({ fileName, run });
      reports.push(verifyReport(file, run, { fileName, dialect: db.dialect, lang }));
      if (run.outcomes.some((o) => o.verdict === "not-run")) break;
    }
    const outcomes = runs.flatMap((r) => r.run.outcomes);
    const tally = (["ok", "ng", "unchecked", "skipped", "not-run", "error"] as const)
      .map((v) => [v, outcomes.filter((o) => o.verdict === v).length] as const)
      .filter(([, n]) => n)
      .map(([v, n]) => `${verdictText(v, lang)} ${n}`)
      .join(" / ");
    console.log(`\n${tally}`);
    deliver(reports.join("\n"), `the results of ${outcomes.length} step(s)`);
    if (values["save-session"] && runs.length) {
      const session: Session = {
        version: 1,
        id: randomUUID(),
        startedAt: runs[0]!.run.startedAt,
        dialect: db.dialect,
        tables: runs.at(-1)!.run.tables,
        // the checked steps, named with their result (Excel evidence shows the names)
        steps: runs
          .flatMap(({ fileName, run }) =>
            run.outcomes.flatMap((o, i) => stepOf(o, i, `[${verdictText(o.verdict, lang)}] ${runs.length > 1 ? `${fileName}: ` : ""}${o.step.title}`) ?? []),
          )
          .map((s, i) => ({ ...s, id: i + 1 })),
      };
      const sessionFile = sessionPath(resolve(".ashiato/sessions"), session);
      saveSession(sessionFile, session);
      console.log(`Saved the changes to ${shown(sessionFile)} (Excel evidence: ashiato export ${shown(sessionFile)})`);
    }
    if (outcomes.some((o) => o.verdict === "ng" || o.verdict === "error")) process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupted);
    input.close();
    await driven?.close().catch(() => undefined);
    await db.close();
  }
}

interface ExportTestsValues {
  out?: string;
  app?: string;
  tables?: string;
  "ignore-columns"?: string;
  "storage-state"?: string;
  force?: boolean;
  lang?: string;
}

/** `ashiato export-tests`: each verification as a Playwright test (tests/e2e/<name>.spec.ts). */
function runExportTestsCommand(paths: string[], values: ExportTestsValues) {
  if (!paths.length) throw new Error("Usage: ashiato export-tests <file.verify.md | folder>... [--out tests/e2e/] [--app <url>]");
  const lang = langOption(values.lang);
  if (values.app && !/^https?:\/\//i.test(values.app)) throw new Error(`--app takes the app's URL (http://localhost:5173), not "${values.app}"`);
  const files = filesIn(paths, /\.verify\.md$/i, ".verify.md");
  const toFile = values.out !== undefined && /\.[cm]?[jt]s$/i.test(values.out);
  if (toFile && files.length > 1) throw new Error(`--out ${values.out} is one file: give a folder for ${files.length} verifications`);
  const login = values["storage-state"] ?? (existsSync(DEFAULT_LOGIN) ? DEFAULT_LOGIN : undefined);
  if (values["storage-state"] && !existsSync(values["storage-state"])) throw new Error(`${values["storage-state"]} doesn't exist: save a login with \`ashiato verify --auto --login\` first`);

  let wrong = 0;
  for (const path of files) {
    const fileName = shown(path);
    const file = parseVerifyFile(decodeText(readFileSync(path)), lang);
    const problems = [...file.problems, ...file.actionProblems].sort((a, b) => a.line - b.line);
    if (problems.length) {
      for (const p of problems) console.error(`${fileName}:${p.line}: ${p.message}`);
      console.error(`${fileName}: not exported (correct it, and check it with ashiato verify --auto)`);
      wrong++;
      continue;
    }
    if (!file.steps.some((s) => s.actions)) {
      console.error(`${fileName}: not exported: no step has actions (\`Actions:\` / \`操作:\`), so there is nothing for a test to do`);
      wrong++;
      continue;
    }
    const out = toFile ? resolve(values.out!) : join(resolve(values.out ?? join("tests", "e2e")), basename(path).replace(/\.verify\.md$/i, ".spec.ts"));
    if (existsSync(out) && !values.force && !readFileSync(out, "utf8").startsWith(EXPORTED_HEADER)) {
      console.error(`${shown(out)}: kept: it isn't a file export-tests wrote (changed by hand?). Give --force to overwrite it.`);
      wrong++;
      continue;
    }
    const test = exportTest(file, {
      fileName,
      app: values.app,
      tables: list(values.tables),
      ignoreColumns: list(values["ignore-columns"]),
      storageState: login && shown(resolve(login)),
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, test.code);
    console.log(`Wrote ${shown(out)} (${test.automated} step(s)${test.manual.length ? `; ${test.manual.length} step(s) a person does left out as TODO: ${test.manual.join(", ")}` : ""})`);
  }
  if (wrong) process.exitCode = 1;
  else console.log("Run them with: npx playwright test --workers=1 (ASHIATO_DB_URL set to the test database)");
}

interface PackValues extends DeliverValues, BrowserValues {
  tables?: string;
  pages?: string;
  "max-pages"?: string;
  "max-chars"?: string;
  sessions?: string;
  tests?: string;
  code?: string;
  "page-text"?: boolean;
  lang?: string;
}

async function runPackCommand(values: PackValues, dbUrl?: string) {
  const lang = langOption(values.lang);
  const maxChars = Number(values["max-chars"] ?? PASTE_LIMIT);
  if (!Number.isInteger(maxChars) || maxChars < 5000) throw new Error("--max-chars takes a number of characters (5000 or more)");
  const maxPages = Number(values["max-pages"] ?? 20);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("--max-pages takes a number of pages");
  if (values.pages && !values.app) throw new Error("--pages needs --app <url>: the app the pages are paths of");
  for (const option of ["headed", "cdp", "login", "storage-state", "page-text"] as const) {
    if (values[option] !== undefined && !values.app) throw new Error(`--${option} needs --app <url> (the pages are read in a browser)`);
  }
  if (dbUrl && !dialectOf(dbUrl)) throw new Error(`Unsupported database URL: ${dbUrl.split(":")[0]}: (use sqlite:, mssql:, oracle:, postgres: or mysql:)`);
  const sessions = readSessions(list(values.sessions));
  if (!values.app && !dbUrl && !sessions.length) throw new Error("Nothing to pack: give --app <url> (the pages), --db <url> (the tables) and / or recordings (.ashiato/sessions)");
  const info = infoFor(values);
  const tests = existingTests(list(values.tests), lang, shown);
  const code = values.code ? { name: basename(values.code), text: decodeText(readFileSync(resolve(values.code))) } : undefined;

  const input = lineReader();
  const db = dbUrl ? await connect(dbUrl) : undefined;
  let made: PackResult;
  try {
    made = await makePack({
      lang,
      app: values.app,
      browser: async () => openBrowser("ashiato pack", await browserOptions(values, input.ask)),
      pages: list(values.pages),
      maxPages,
      pageText: values["page-text"],
      db,
      tables: list(values.tables),
      sessions,
      tests,
      code,
      maxChars,
      log: info,
    });
  } finally {
    input.close();
    await db?.close();
  }
  const { pack, pages, actions, tables, unreadable } = made;
  if (unreadable.length) info(`Could not read: ${unreadable.join(", ")}`);
  const redirected = pages.filter((p) => p.redirected);
  if (redirected.length && redirected.length === pages.length - 1) info(`Note: the pages went to ${redirected[0]!.redirected}: if that is a login page, log in first with --login.`);

  const out = values.out === "-" ? undefined : resolve(values.out ?? join("docs", "ashiato", "pack.md"));
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, pack.markdown);
  }
  info(
    `${out ? `Wrote ${shown(out)}` : "Packed"}: ${pages.length} page(s), ${actions.length} recorded action(s) from ${sessions.length} recording(s), ${tables.length} table(s); ${pack.markdown.length.toLocaleString("en-US")} characters.`,
  );
  const ignored = ignoredColumns(sessions);
  if (ignored.length) info(`Note: the recordings ignore changes of ${ignored.join(", ")}: run ashiato verify with --ignore-columns ${ignored.join(",")} too.`);
  if (values["page-text"]) info("Note: --page-text keeps the pages' text, which may show the database's values: check that your company allows pasting them into the chat.");
  const left = leftOut(pack.left);
  if (left) {
    info(`Left out to stay within --max-chars ${maxChars}: ${left}.`);
    if (pack.left.pages.length) info(`Make another pack of the rest and paste it after this one: ashiato pack --app ${values.app} --pages ${pack.left.pages.join(",")}`);
    else if (pack.left.tables.length) info("Pick the tables with --tables to put the ones that matter in.");
  }
  if (values.out === "-") return deliverReport(pack.markdown, "the pack", values, "lower --max-chars");
  if (values["no-clip"]) return;
  const clip = writeClipboard(pack.markdown);
  info(clip.ok ? "Copied it to the clipboard: paste it into the chat." : `Could not copy to the clipboard (${clip.message}): paste the file's text into the chat.`);
}

/**
 * Lines typed at the terminal, one per question. On a terminal, lines typed before the question
 * (Enter pressed twice) are dropped: they would answer a step the person hasn't read yet.
 */
function lineReader() {
  const rl = createInterface({ input: process.stdin });
  const typed: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else typed.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const w of waiting.splice(0)) w(null);
  });
  return {
    ask(prompt: string): Promise<string | null> {
      process.stdout.write(prompt);
      if (process.stdin.isTTY) typed.length = 0;
      if (typed.length) return Promise.resolve(typed.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((r) => waiting.push(r));
    },
    close: () => rl.close(),
  };
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
      "save-session": { type: "boolean" },
      auto: { type: "boolean" },
      app: { type: "string" },
      headed: { type: "boolean" },
      cdp: { type: "string" },
      login: { type: "boolean" },
      "storage-state": { type: "string" },
      pages: { type: "string" },
      "max-pages": { type: "string" },
      "max-chars": { type: "string" },
      sessions: { type: "string" },
      tests: { type: "string" },
      code: { type: "string" },
      "page-text": { type: "boolean" },
      force: { type: "boolean" },
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
  if (command === "pack") {
    if (rest.length) throw new Error(`ashiato pack takes no files (got ${rest.join(" ")}): give --app <url>, --db <url>, --sessions <folder>`);
    return runPackCommand(values, dbUrl);
  }
  if (command === "verify") return runVerifyCommand(rest, values, dbUrl);
  if (command === "export-tests") return runExportTestsCommand(rest, values);

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
