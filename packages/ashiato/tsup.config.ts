import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/cli/bin.ts" },
  format: ["esm"],
  target: "node22",
  dts: { entry: { index: "src/index.ts" } },
  // dist/ui is built separately by @ashiato/ui
  clean: ["**/*", "!ui/**"],
  // keep "node:sqlite" intact: it has no bare-specifier alias
  removeNodeProtocol: false,
  external: ["mssql", "oracledb", "pg", "mysql2", "mysql2/promise"],
});
