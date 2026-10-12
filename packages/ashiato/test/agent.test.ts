import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/adapters/index.js";
import { serveMcp, type McpTool } from "../src/agent/mcp.js";
import { agentTools, type AgentTools } from "../src/agent/tools.js";
import { main } from "../src/cli/main.js";
import { startRecording, type Recording } from "../src/cli/recording.js";
import { createAppDb } from "./helpers.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** An MCP client on streams: sends requests, collects the answers. */
function client(tools: McpTool[], instructions?: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const answers: Record<string, unknown>[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      answers.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      buffer = buffer.slice(i + 1);
    }
  });
  const done = serveMcp(tools, { name: "ashiato", version: "1.2.3", instructions }, { input, output });
  let next = 1;
  const answerTo = async (id: number) => {
    await vi.waitFor(() => expect(answers.find((a) => a.id === id)).toBeDefined(), { timeout: 10_000 });
    return answers.find((a) => a.id === id)!;
  };
  return {
    answers,
    done,
    raw: (line: string) => input.write(`${line}\n`),
    end: () => input.end(),
    async request(method: string, params?: unknown) {
      const id = next++;
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answerTo(id);
    },
    /** A tool's text, or throws its error text. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const a = (await this.request("tools/call", { name, arguments: args })) as { result: { content: { text: string }[]; isError: boolean } };
      if (a.result.isError) throw new Error(a.result.content[0]!.text);
      return a.result.content[0]!.text;
    },
  };
}

describe("MCP over stdio", () => {
  const echo: McpTool = {
    name: "echo",
    description: "says it back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    run: async (args) => {
      if (args.text === "fail") throw new Error("it failed");
      return `echo: ${String(args.text)}`;
    },
  };

  it("answers initialize, tools/list, tools/call and ping, and ignores notifications", async () => {
    const c = client([echo], "how to use it");
    expect(await c.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ashiato", version: "1.2.3" }, instructions: "how to use it" },
    });
    c.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    // a version it doesn't know: its own newest
    expect(((await c.request("initialize", { protocolVersion: "2099-01-01" })) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    expect((await c.request("tools/list")).result).toEqual({ tools: [{ name: "echo", description: "says it back", inputSchema: echo.inputSchema }] });
    expect(await c.call("echo", { text: "hi" })).toBe("echo: hi");
    await expect(c.call("echo", { text: "fail" })).rejects.toThrow("it failed");
    expect((await c.request("tools/call", { name: "nope" })).error).toEqual({ code: -32602, message: "Unknown tool: nope" });
    expect((await c.request("resources/list")).error).toMatchObject({ code: -32601 });
    expect((await c.request("ping")).result).toEqual({});
    c.raw("{not json");
    await vi.waitFor(() => expect(c.answers.at(-1)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    c.end();
    await c.done;
    // no answer to the notification
    expect(c.answers.filter((a) => a.id === undefined)).toEqual([]);
  });
});

describe("tools for AI agents", () => {
  const setup = (o: { values?: boolean; recorder?: string } = {}) => {
    const app = createAppDb();
    const out = mkdtempSync(join(tmpdir(), "ashiato-agent-"));
    const agent = agentTools({ db: o.recorder ? undefined : `sqlite:${app.file}`, recorder: o.recorder, shareValues: o.values, out, port: 0 });
    cleanups.push(() => agent.close());
    return { app, out, agent, c: client(agent.tools, agent.instructions) };
  };

  it("records the database while the AI works, without giving it the rows' values", async () => {
    const { app, out, agent, c } = setup();
    expect(agent.instructions).toContain("Row values are not shared");
    expect(await c.call("list_tables")).toContain("stock: 2 rows, key: item_id");
    await expect(c.call("checkpoint")).rejects.toThrow("call start_recording first");

    const started = await c.call("start_recording", { ignore_columns: ["updated_at"] });
    expect(started).toMatch(/^Recording 3 tables on sqlite: baseline taken\.\nSession file: .+\.json\nTimeline: http:\/\/127\.0\.0\.1:\d+/);
    await expect(c.call("start_recording")).rejects.toThrow("Already recording");

    // values that can't turn up in the step's time
    app.db.exec("INSERT INTO orders VALUES (1042, 7, 10, 'secret-note'); UPDATE stock SET qty = 4711 WHERE item_id = 3");
    const step = await c.call("checkpoint", { label: "ran the import" });
    expect(step).toContain("#1 ran the import");
    expect(step).toContain("orders (key: id): 1 row inserted, 0 updated, 0 deleted\n    inserted rows have: id, customer_id, qty, updated_at");
    expect(step).toContain("stock (key: item_id): 0 rows inserted, 1 updated (qty), 0 deleted");
    expect(step).not.toMatch(/1042|secret-note|4711/);

    app.db.exec("DELETE FROM orders WHERE id = 1042");
    await c.call("checkpoint");
    expect(await c.call("list_steps")).toMatch(/: sqlite, started .+, 3 tables watched, 2 steps\n#1 ran the import: orders \+1, stock ~1\n#2 checkpoint: orders -1$/);
    expect(await c.call("list_steps", { since: 1 })).toMatch(/\n#2 checkpoint: orders -1$/);
    await expect(c.call("get_step", { id: 9 })).rejects.toThrow("There is no step #9");

    const test = await c.call("generate_test");
    const specFile = /^Wrote (.+\.spec\.ts): 2 steps checked, 2 TODOs to fill in\./.exec(test)![1]!;
    expect(test).not.toContain("1042");
    expect(readFileSync(specFile, "utf8")).toContain("inserted: [{ id: expect.any(Number), customer_id: 7, qty: 10 }]");

    const evidence = await c.call("export_evidence", { formats: ["html"], lang: "en" });
    expect(evidence).toMatch(/^Wrote .+\.html$/);
    await expect(c.call("export_evidence", { formats: ["docx"] })).rejects.toThrow("Unknown format: docx");

    const stopped = await c.call("stop_recording");
    expect(stopped).toMatch(/^Saved 2 steps to .+\.json$/);
    // still readable after it stopped
    expect(await c.call("get_step", { id: 2 })).toContain("orders (key: id): 0 rows inserted, 0 updated, 1 deleted");
    expect(stopped).toContain(out);
  });

  it("gives the rows' values when started with --share-values", async () => {
    const { app, c } = setup({ values: true });
    await c.call("start_recording");
    app.db.exec("INSERT INTO orders VALUES (1042, 7, 10, 'note'); UPDATE stock SET qty = 40 WHERE item_id = 3");
    const step = await c.call("checkpoint");
    expect(step).toContain('    + {"id":1042,"customer_id":7,"qty":10,"updated_at":"note"}');
    expect(step).toContain('    ~ {"item_id":3}: qty 50 → 40');
    expect(await c.call("generate_test")).toContain('import { test, expect } from "ashiato/playwright";');
  });

  it("reads a recorder started elsewhere (ashiato record)", async () => {
    const app = createAppDb();
    const db = await connect(`sqlite:${app.file}`);
    const recording: Recording = await startRecording(db, { out: mkdtempSync(join(tmpdir(), "ashiato-rec-")), port: 0 });
    cleanups.push(async () => {
      await recording.stop();
      await db.close();
    });
    const { out, c } = setup({ recorder: recording.url });
    app.db.exec("UPDATE stock SET qty = 1 WHERE item_id = 4");
    expect(await c.call("checkpoint", { label: "from the AI" })).toContain("stock (key: item_id): 0 rows inserted, 1 updated (qty), 0 deleted");
    expect(recording.session.steps.at(-1)?.label).toBe("from the AI");
    expect(await c.call("list_tables")).toContain("orders");
    await expect(c.call("start_recording")).rejects.toThrow("Recording is done by the recorder at");
    const test = await c.call("generate_test", { out: join(out, "t.spec.ts") });
    expect(test).toContain(`Wrote ${join(out, "t.spec.ts")}: 1 steps checked`);
    expect(await c.call("export_evidence", { formats: ["html"], out: join(out, "evidence") })).toBe(`Wrote ${join(out, "evidence.html")}`);
    expect(readFileSync(join(out, "evidence.html"), "utf8")).toContain("from the AI");
  });
});

describe("CLI for scripts", () => {
  it("takes a checkpoint in a running recorder and prints steps, with or without values", async () => {
    const app = createAppDb();
    const db = await connect(`sqlite:${app.file}`);
    const recording = await startRecording(db, { out: mkdtempSync(join(tmpdir(), "ashiato-cli-")), port: 0 });
    cleanups.push(async () => {
      await recording.stop();
      await db.close();
    });
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m: string) => void printed.push(m));
    cleanups.push(async () => log.mockRestore());

    app.db.exec("UPDATE stock SET qty = 1 WHERE item_id = 4");
    await main(["checkpoint", "after", "the", "batch", "--recorder", recording.url!]);
    expect(printed.pop()).toContain("#1 after the batch\n");
    await main(["checkpoint", "--recorder", recording.url!, "--json", "--no-values"]);
    expect(JSON.parse(printed.pop()!)).toMatchObject({ id: 2, label: "checkpoint", tables: [] });

    await main(["steps", recording.file]);
    expect(printed.pop()).toBe("#1 after the batch: stock ~1\n#2 checkpoint: no changes");
    await main(["steps", "--recorder", recording.url!, "--since", "1", "--json"]);
    expect(JSON.parse(printed.pop()!)).toMatchObject([{ id: 2 }]);
    await main(["steps", recording.file, "--full"]);
    expect(printed.pop()).toContain('    ~ {"item_id":4}: qty 20 → 1');
    await main(["steps", recording.file, "--full", "--no-values"]);
    expect(printed.pop()).not.toContain("20 → 1");
    await expect(main(["steps", "--recorder", "http://127.0.0.1:9"])).rejects.toThrow("No ashiato recorder at http://127.0.0.1:9");
  });
});

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
if (process.env.ASHIATO_REQUIRE_E2E && !existsSync(bin)) throw new Error("ashiato mcp test cannot run: build first (pnpm build)");

describe.skipIf(!existsSync(bin))("ashiato mcp", () => {
  it("serves the tools on stdio, with its log on stderr", async () => {
    const app = createAppDb();
    const out = mkdtempSync(join(tmpdir(), "ashiato-mcp-"));
    const child = spawn(process.execPath, [bin, "mcp", "--db", `sqlite:${app.file}`, "--out", out, "--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(async () => void child.kill());
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const answer = async (id: number) => {
      await vi.waitFor(() => expect(stdout.split("\n").some((l) => l.startsWith(`{"jsonrpc":"2.0","id":${id},`))).toBe(true), { timeout: 15_000 });
      return JSON.parse(stdout.split("\n").find((l) => l.startsWith(`{"jsonrpc":"2.0","id":${id},`))!) as { result: Record<string, unknown> };
    };
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect((await answer(1)).result.serverInfo).toEqual({ name: "ashiato", version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    send(2, "tools/call", { name: "start_recording", arguments: {} });
    expect(JSON.stringify((await answer(2)).result)).toContain("baseline taken");
    app.db.exec("INSERT INTO audit_log VALUES ('x')");
    send(3, "tools/call", { name: "checkpoint", arguments: { label: "logged" } });
    expect(JSON.stringify((await answer(3)).result)).toContain("audit_log (no primary key): 1 row inserted");
    // nothing but protocol messages on stdout
    for (const line of stdout.split("\n").filter(Boolean)) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    expect(stderr).toContain("row values not shared with the AI");
    expect(stderr).toContain("#1 logged: audit_log +1");

    // the client goes away: the session is saved
    child.stdin.end();
    const code = await new Promise((r) => child.on("exit", r));
    expect(code).toBe(0);
    const sessions = (await import("node:fs")).readdirSync(out);
    expect(sessions.filter((f) => f.endsWith(".json"))).toHaveLength(1);
  }, 30_000);
});
