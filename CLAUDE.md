# ashiato

Records which rows an app inserts, updates and deletes, using read-only (SELECT-only) database access.

## Hard rules
- Adapters must work with SELECT permission only: no triggers, no CDC, no temp tables, no setting changes. CDC / Flashback may only ever be optional extras.
- Everything runs locally; never send data anywhere. The server binds to 127.0.0.1.
- Database drivers (mssql, oracledb, pg, mysql2) are optional peer dependencies loaded with `loadDriver()`.

## Layout
- `packages/ashiato` — the npm package: `src/core` (snapshot, diff, recorder, media: replay/video files next to the session), `src/adapters` (one file per database), `src/server` (HTTP API + static UI), `src/cli`, `src/vite` (Vite plugin, export `ashiato/vite`), `src/client` (browser script the plugin inlines: action tracker + fetch / XHR / WebView2 postMessage hooks + rrweb screen replay recording; built as `dist/client.global.js`).
- `packages/ui` — React timeline UI (step list, diffs, rrweb replay, screen recording via getDisplayMedia), built into `packages/ashiato/dist/ui`.

## Commands
- `pnpm test` — unit + SQLite tests. Real servers run when `ASHIATO_TEST_{POSTGRES,MYSQL,MSSQL,ORACLE}_URL` is set (CI sets all four). The real-browser Vite test (`test/vite.e2e.test.ts`, also covers the timeline UI replay and screen recording) needs `pnpm build` first and a Chromium for playwright-core; CI sets `ASHIATO_REQUIRE_E2E=1` so it can't silently skip.
- `pnpm typecheck`, `pnpm build`
