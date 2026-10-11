# ashiato

Records which rows an app inserts, updates and deletes, using read-only (SELECT-only) database access.

## Hard rules
- Adapters must work with SELECT permission only: no triggers, no CDC, no temp tables, no setting changes. CDC / Flashback may only ever be optional extras.
- Everything runs locally; never send data anywhere. The server binds to 127.0.0.1.
- Database drivers (mssql, oracledb, pg, mysql2) are optional peer dependencies loaded with `loadDriver()`.

## Layout
- `packages/ashiato` — the npm package: `src/core` (snapshot, diff, recorder), `src/adapters` (one file per database), `src/server` (HTTP API + static UI), `src/cli`.
- `packages/ui` — React timeline UI, built into `packages/ashiato/dist/ui`.

## Commands
- `pnpm test` — unit + SQLite tests. Real servers run when `ASHIATO_TEST_{POSTGRES,MYSQL,MSSQL,ORACLE}_URL` is set (CI sets all four).
- `pnpm typecheck`, `pnpm build`
