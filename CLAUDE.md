# ashiato

Records which rows an app inserts, updates and deletes, using read-only (SELECT-only) database access.

## Hard rules
- Adapters must work with SELECT permission only: no triggers, no CDC, no temp tables, no setting changes. CDC / Flashback may only ever be optional extras.
- Everything runs locally; never send data anywhere. The server binds to 127.0.0.1.
- The MCP server's answers go to an AI (maybe in the cloud): row values, URL queries, the text of clicked elements other than buttons' captions and text fields' labels (the browser marks those: `ActionInfo.caption`), and the app's and database's error messages are left out unless it was started with `--share-values`; files it writes (tests, evidence) are returned as paths only.
- Database drivers (mssql, oracledb, pg, mysql2) are optional peer dependencies loaded with `loadDriver()`.

## Layout
- `packages/ashiato` — the npm package: `src/core` (snapshot, diff, recorder, media: replay/video files next to the session), `src/adapters` (one file per database), `src/server` (HTTP API + static UI), `src/cli` (`recording.ts`: recording + timeline server, shared by `record` and `mcp`), `src/agent` (for AI agents: dependency-free stdio MCP server, its tools, steps as text with or without values), `src/testing` (`expectDbChanges` matching and the watcher that waits for changes to settle), `src/playwright` (Playwright fixtures, export `ashiato/playwright`), `src/codegen` (Playwright tests from a recording: page mirror rebuilt from the rrweb replay → user interactions → locators → test code), `src/export` (evidence export: dependency-free .xlsx writer, HTML printed to PDF and screenshots taken by a local headless Chrome / Edge over the DevTools pipe; `capture.ts` is the screenshot page's script, built as `dist/capture.global.js`), `src/vite` (Vite plugin, export `ashiato/vite`), `src/client` (browser script the plugin inlines: action tracker + fetch / XHR / WebView2 postMessage hooks + rrweb screen replay recording + custom replay events for codegen in `events.ts`: dialogs, Enter, options picked by a script; built as `dist/client.global.js`).
- `packages/ui` — React timeline UI (step list, diffs, rrweb replay, screen recording via getDisplayMedia), built into `packages/ashiato/dist/ui`.

## Commands
- `pnpm test` — unit + SQLite tests. Real servers run when `ASHIATO_TEST_{POSTGRES,MYSQL,MSSQL,ORACLE}_URL` is set (CI sets all four). The adapter test connects as a user granted only SELECT (Oracle also needs `ASHIATO_TEST_ORACLE_ADMIN_URL`), so permission-dependent catalog queries are covered. The real-browser Vite test (`test/vite.e2e.test.ts`, also covers the timeline UI replay and screen recording) needs `pnpm build` first and a Chromium for playwright-core; CI sets `ASHIATO_REQUIRE_E2E=1` so it can't silently skip. `test/playwright.e2e.test.ts` runs the real Playwright test runner on the built `ashiato/playwright`; `test/agent.test.ts` runs the built `ashiato mcp` over stdio.
- `pnpm typecheck`, `pnpm build`
