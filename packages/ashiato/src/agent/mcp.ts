/**
 * A Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line), without
 * dependencies: just enough of the protocol for tools.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** The tool's answer, as text. A thrown error is the answer too, marked as an error. */
  run(args: Record<string, unknown>): Promise<string>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  /** How to use the tools, for the AI. */
  instructions?: string;
}

/** Protocol versions this server speaks, newest first. */
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Serves the tools until the input ends. Tool calls run one at a time, in order. */
export async function serveMcp(tools: McpTool[], info: McpServerInfo, io: { input: Readable; output: Writable }): Promise<void> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (m: unknown) => io.output.write(`${JSON.stringify(m)}\n`);
  let queue: Promise<unknown> = Promise.resolve();

  const handle = async (m: Message): Promise<unknown> => {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: (typeof m === "object" && m !== null ? m.id : undefined) ?? null, error: { code, message } });
    if (typeof m !== "object" || m === null || typeof m.method !== "string") {
      // a response to a request of ours (there are none), or not a message at all
      return m && typeof m === "object" && "id" in m && !("method" in m) ? undefined : fail(-32600, "Invalid request");
    }
    // notifications (initialized, cancelled) need no answer
    if (m.id === undefined) return undefined;
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion;
        return ok({
          protocolVersion: typeof asked === "string" && VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          ...(info.instructions ? { instructions: info.instructions } : {}),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = byName.get(String(m.params?.name));
        if (!tool) return fail(-32602, `Unknown tool: ${String(m.params?.name)}`);
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        const run = queue.then(() => tool.run(args));
        queue = run.catch(() => undefined);
        try {
          return ok({ content: [{ type: "text", text: await run }], isError: false });
        } catch (e) {
          return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`);
    }
  };

  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // answered as they finish: a ping isn't held up by a long checkpoint
    const p = (async () => {
      try {
        if (Array.isArray(parsed)) {
          if (!parsed.length) {
            send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: empty batch" } });
            return;
          }
          const answers = (await Promise.all(parsed.map((m) => handle(m as Message)))).filter((a) => a !== undefined);
          if (answers.length) send(answers);
        } else {
          const answer = await handle(parsed as Message);
          if (answer !== undefined) send(answer);
        }
      } catch (e) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: `Internal error: ${(e as Error).message}` } });
      }
    })();
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
