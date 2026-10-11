import { defineConfig } from "tsup";

const node = {
  format: ["esm"] as const,
  target: "node22",
  // keep "node:sqlite" intact: it has no bare-specifier alias
  removeNodeProtocol: false,
  external: ["mssql", "oracledb", "pg", "mysql2", "mysql2/promise", "vite"],
};

export default defineConfig([
  {
    ...node,
    entry: { index: "src/index.ts", bin: "src/cli/bin.ts", vite: "src/vite/index.ts" },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts", vite: "src/vite/index.ts" } },
    // dist/ui is built separately by @ashiato/ui
    clean: ["**/*", "!ui/**", "!client.global.js"],
  },
  {
    // injected into the page by the Vite plugin
    entry: { client: "src/client/index.ts" },
    format: ["iife"],
    platform: "browser",
    target: "es2020",
    minify: true,
  },
]);
