import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// A local model through an OpenAI-compatible server (Ollama: http://127.0.0.1:11434/v1).
// Tests without agent steps never call it.
const local = createOpenAICompatible({
  name: "local",
  baseURL: process.env.LLM_URL ?? "http://127.0.0.1:11434/v1",
  supportsStructuredOutputs: true,
});

export default {
  targets: [{ engine: web({ browser: "chromium" }), app: { url: process.env.APP_URL ?? "http://127.0.0.1:3000" } }],
  tests: ["tests/**/*.e2e.ts"],
  agents: { default: { model: local.chatModel(process.env.LLM_MODEL ?? "qwen3-vl:4b") } },
} satisfies E2EConfig;
