# ashiato

**Record which rows your app inserts, updates and deletes — step by step, with read-only database access.**

**アプリを操作するたびに、DBのどの行が追加・更新・削除されたかを記録する。参照権限だけで動きます。**

**English** | [日本語](#日本語)

![Timeline](docs/timeline.png)

---

## Why

Checking that "Save" really wrote the right rows usually means a pile of hand-written `SELECT`s before and after every click. ashiato takes a snapshot of the tables you care about, and every time you take a checkpoint it shows exactly what changed since the last one.

- **Read-only.** Only `SELECT` is used. No triggers, no CDC, no database setting changes.
- **All major databases.** SQL Server, Oracle, PostgreSQL, MySQL / MariaDB, SQLite.
- **Local only.** Everything stays on your machine. Sessions are saved as JSON files.

## Quick start

```sh
npm install -D ashiato mssql   # plus the driver for your database: mssql | oracledb | pg | mysql2 (SQLite needs nothing)

npx ashiato tables --db "mssql://user:pass@localhost:1433/devdb"
npx ashiato record --db "mssql://user:pass@localhost:1433/devdb" --tables orders,stock --ignore-columns updated_at
```

Then use your app. After each action, press **Enter** in the terminal (type a label first if you like) or click **Checkpoint** in the timeline at <http://127.0.0.1:4100>.

```
#1 click Save  (+1 ~1 -0, 12ms)
  dbo.orders
    + id=1042
  dbo.stock
    ~ item_id=3  qty: 50 → 40
```

Press **Ctrl+C** to stop. The session is saved in `.ashiato/sessions/`; open it again with `ashiato show <file>`.

## Automatic checkpoints from your Vite app

Add the plugin and every click, submit or Enter that sends requests becomes one checkpoint, labelled with what you clicked and the requests it made.

```ts
// vite.config.ts
import ashiato from "ashiato/vite";

export default defineConfig({
  plugins: [react(), ashiato()], // dev server only; never included in builds
});
```

![Vite timeline](docs/vite-timeline.png)

- **What is tracked:** `fetch`, `XMLHttpRequest` (axios), and WebView2 `window.chrome.webview.postMessage` with JSON-RPC style `{ id, method }` → `{ id, result | error }` replies (webview2-bridge works as is). A WinForms / WPF host that loads the Vite dev server URL gets the same tracking. Synchronous XHR (`open(method, url, false)`) and `chrome.webview.postMessageWithAdditionalObjects` are not tracked.
- **One checkpoint per action:** requests that start within 1s of a click, and requests chained after them, belong to that click. The checkpoint is taken 150ms after the last one finishes. A poller that sends requests less than `settleMs` apart keeps an action open until `maxRequestMs`, so add fast-polling endpoints to `ignore`.
- **Outside changes are kept apart:** right before an action's first request is sent, ashiato takes a quick checkpoint. Anything another user or a batch job changed shows up as an `outside actions` step instead of being blamed on your click. (The request waits for that read; turn it off with `syncBefore: false`.)
- **Overlapping actions become one step:** when a click's requests run at the same time as another click's requests that change data (a double click), their changes can't be told apart. They are recorded as one step, named after the first click that changed data, listing every request.
- **A slow database doesn't put two clicks together:** a click's requests wait as long as the previous click's requests waited for their quick checkpoint, so they stay as far apart as you clicked them, and then for the previous click's checkpoint. Where a checkpoint takes about a second, requests can wait a second or two; watching fewer tables (`--tables`) makes checkpoints faster. A checkpoint you take in the terminal (Enter) while requests are waiting gets part of their changes: press Enter once the last step has shown up.
- Requests with no click that change data (anything but `GET` / `HEAD`) are recorded only when they changed something. Requests with no click that only read (page load, polling) take no checkpoint at all; if one did change something, it shows up in the next step as `outside actions`. Clicks that send nothing are not recorded.

| Option | Default | |
| --- | --- | --- |
| `recorder` | `http://127.0.0.1:4100` | URL of `ashiato record` (or `ASHIATO_RECORDER_URL`) |
| `settleMs` | `150` | Quiet time after the last request before the checkpoint |
| `oneWayMs` | `500` | Wait after a `postMessage` that gets no reply |
| `syncBefore` | `true` | Checkpoint before each action so outside changes stay separate |
| `syncTimeoutMs` | `5000` | Longest a request waits for that checkpoint |
| `mergeMs` | `300` | Events this close together, before any request, count as one action (click + submit) |
| `attachMs` | `1000` | A request belongs to the last click only if it starts within this time (or while the click's requests are running) |
| `maxRequestMs` | `30000` | A request still open after this long is recorded as "no reply"; an action this old takes no new requests |
| `ignore` | `[]` | URL substrings never tracked |
| `replay` | `true` | Record the page for screen replay. `{ maskAllInputs: true }` hides every input value |
| `enabled` | `true` | Also `ASHIATO=0` |

## Screen replay and recording

Select a step in the timeline and the **Screen** panel shows what the screen looked like when you did it. **▶ Play this action** plays it from just before the click to the checkpoint.

![Screen replay](docs/replay.png)

- **Replay (Vite plugin):** the page is recorded as DOM changes with [rrweb](https://github.com/rrweb-io/rrweb), not pixels, so it is light and sharp. Password fields are always masked. Each browser tab is kept apart (a popup gets its own; frames are part of their page). Pages already open when the recorder starts are replayed from a few seconds after it starts.
- **Video (any app):** press **● Record screen** in the timeline and pick a window or the whole screen. This works for anything on your desktop, such as a WinForms / WPF app with WebView2, not only the browser. The video is uploaded to the recorder every second, and each step jumps to its moment in the video.
- Both stay on your machine, next to the session file: `<session>.replay.ndjson` (up to 1 GB) and `<session>.video-<n>.webm`. `ashiato show` replays them too.

## Evidence export (Excel / PDF)

Turn a session into test evidence: click **⤓ Excel** or **⤓ PDF** in the timeline, or export a saved session from the terminal.

```sh
npx ashiato export .ashiato/sessions/2026-10-11T04-00-00-000Z.json --format xlsx,pdf
```

- **Excel:** a summary sheet (one row per step, linked to the step's sheet), an **All changes** sheet listing every changed row and column (with filters), and one sheet per step: what was clicked, its requests, screenshots, and the changed rows of each table. An update shows the row before and after, with the changed cells highlighted. Values keep their types; numbers longer than 15 digits (IDs) stay text so Excel doesn't round them.
- **PDF:** the same evidence on A4 landscape with page numbers: a summary page, then a page per step. Tables show up to 200 rows per kind; the Excel file has them all.
- **Screenshots:** each step gets the screen just before its action and the screen at its checkpoint, from the screen replay, or from the screen recording when there is no replay. Steps without a recorded screen get none.
- **Local only:** the PDF and the screenshots are made by the Chrome or Edge already on your machine (every Windows has Edge), started headless with a throwaway profile and no network access except localhost. The Excel file needs no browser. If a policy turns off the browser's remote debugging, the PDF is printed without page numbers and screenshots.
- The language follows your machine (Japanese or English). In the timeline, **Hide steps without changes** also leaves those steps out of the export.

| Option | |
| --- | --- |
| `--format xlsx,pdf,html` | Formats to write (default `xlsx`). `html` is the printable page the PDF is made from |
| `--out <path>` | Output file, or folder (default: next to the session file, same name) |
| `--lang ja\|en` | Language of the document (default: the machine's) |
| `--changed-only` | Leave out steps that changed no rows |
| `--no-screens` | No screenshots |
| `--browser <path>` | Chrome / Edge to use (or set `ASHIATO_BROWSER`) |

## Database checks in Playwright tests

`expectDbChanges(action, expected)` runs an action and checks what it changed in the database, with the same read-only access. Install `@playwright/test` next to ashiato.

```ts
// tests/orders.spec.ts
import { test, expect } from "ashiato/playwright";

test.use({ ashiato: { ignoreColumns: ["updated_at"] } }); // the database: ASHIATO_DB_URL, or ashiato: { db: "..." }

test("placing an order", async ({ page, expectDbChanges }) => {
  await page.goto("/orders/new");
  await page.getByLabel("Quantity").fill("10");
  const changes = await expectDbChanges(() => page.getByRole("button", { name: "Save" }).click(), {
    orders: { inserted: [{ id: expect.any(Number), customer_id: 7, qty: 10 }] },
    stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
  });
  expect(changes.orders.inserted[0].id).toBeGreaterThan(0);
});
```

- It reads the watched tables before the action, runs it, then waits until the changes stop for `settleMs` (300 ms) and match, for up to `timeout` (5 s).
- Every table listed must change exactly as described, and **no other watched table may change**. `{}` checks that nothing changed; `orders: {}` that `orders` didn't. A watched table that could be read before the action but not after it fails the check too, since it may have changed.
- `inserted` / `deleted` are rows or a count (`inserted: 300`). `updated` rows are `{ where, set }`: `where` picks the row, and `set` lists every column the update changed (leave columns like `updated_at`, and SQL Server `rowversion` columns, to `ignoreColumns`). Only the columns you give are compared, names in any case, and Playwright's `expect.any()`, `expect.stringContaining()` and the like work in them. A `Date` matches the same moment; times the database gives without a time zone are read as UTC, so a test passes the same on every machine.
- When it fails, the error says which rows and columns differ, lists changes the expectation doesn't mention, and shows everything that changed. It points at your test's line, as a step named `expect database changes: orders +1, stock ~1`.
- Run tests that check the same database one at a time (`--workers=1`): parallel tests would see each other's writes.
- Options (`test.use({ ashiato })`): `db`, `tables`, `ignoreColumns`, `maxRows`, `timeout`, `settleMs`. Per call, as the third argument: `timeout`, `settleMs`.
- Without Playwright: `import { watchDb } from "ashiato"`, then `const db = watchDb(url)`, `await db.expectChanges(action, expected)`, and `await db.close()` at the end (an open connection keeps Node running).

## Tests from a recording

A recording can be turned into a Playwright test that does again what was done in the browser and checks, step by step, that the same rows change: click **⤓ Playwright test** in the timeline, or:

```sh
npx ashiato codegen .ashiato/sessions/2026-10-11T04-00-00-000Z.json   # writes ...000Z.spec.ts next to it
```

```ts
test("recorded 2026-10-11 13:00", async ({ page, expectDbChanges }) => {
  await page.goto("/");
  await page.getByPlaceholder("Customer name", { exact: true }).fill("Suzuki Trading");

  // #1 click button "Add customer" (POST /api/customers)
  await expectDbChanges(() => page.getByRole("button", { name: "Add customer", exact: true }).click(), {
    customers: {
      inserted: [{ id: expect.any(Number), name: "Suzuki Trading", created_at: expect.any(String) }],
    },
  });
  ...
```

- The clicks, typing, options picked, checkboxes, Enter presses and page loads come from the screen replay (the Vite plugin records it), and so does text typed in an editable area (`contenteditable`). Elements are found the way Playwright recommends: test id, role and name, label, placeholder, text, then an id or attribute, checked to be unique on the page at that moment. A name whose spaces depend on the stylesheet (`<span>Order</span><span>list</span>` in a flex box) is matched with a pattern: `/^Order ?list$/`.
- Answers to `alert` / `confirm` / `prompt` are given back the same way (`page.once("dialog", ...)`).
- Values the database makes up are matched with `expect.any()`: keys of new rows, columns referring to them (`order_id`), UUIDs in new rows, SQL Server row versions, and dates near the time of the recording. Columns named like a password, hash, salt, token or secret are matched with `expect.any(String)` too, so their values aren't copied into the test. Steps with more than 20 rows of a kind are checked by count.
- Before running it, put the database back in the state it was in when recording started, and set `ASHIATO_DB_URL`. Steps sent through WebView2 need the page hosted by your desktop app (or a stand-in for `chrome.webview`). Without a screen replay, the actions are left as `TODO`s.
- Typed passwords and masked inputs (`maskAllInputs`) are not in the replay: they become `TODO`s.

## For AI agents (CLI / MCP)

An AI agent working on your app can record the database while it works and read what each step changed.

**MCP server.** Add it to your agent (Claude Code: `claude mcp add ashiato -- npx ashiato mcp --db <url>`):

```sh
npx ashiato mcp --db <url> [--tables ...] [--ignore-columns ...] [--port 4100] [--out <folder>] [--share-values]
npx ashiato mcp --recorder http://127.0.0.1:4100   # read a running `ashiato record` instead
```

Sessions are saved in `--out` (default `.ashiato/sessions`), and relative paths are taken from the folder the agent starts the server in: give a full path if your agent starts it elsewhere.

| Tool | |
| --- | --- |
| `list_tables` | Tables, row counts and primary keys |
| `start_recording` | Baseline snapshot; starts the timeline on `--port`, so the Vite plugin turns each action in the app into a step |
| `checkpoint` | A step now: what changed since the previous one |
| `list_steps`, `get_step` | The steps, one line each, or one in full (action, requests, changed rows) |
| `stop_recording` | Saves the session file |
| `generate_test` | Writes a Playwright test from the recording (see above) |
| `export_evidence` | Writes Excel / PDF / HTML evidence |

**Row values stay with you by default.** What the MCP server answers goes to the AI, and an AI in the cloud would receive your data. Unless the server is started with `--share-values`, the AI sees table names, column names, counts and which columns changed, but no row values, no URL queries, no text of what was clicked other than buttons' captions and text fields' labels (a link, a cell, a checkbox's label or a row made clickable can show data), and no error messages of the app or the database. Generated tests and evidence are written to files and only their paths are returned. ashiato itself sends nothing anywhere.

**CLI.** For scripts, and agents that run commands:

```sh
npx ashiato checkpoint "ran the import" [--recorder http://127.0.0.1:4100] [--json] [--no-values]
npx ashiato steps [session.json] [--since 3] [--full] [--json] [--no-values]
npx ashiato tables --db <url> --json
```

`checkpoint` and `steps` talk to a running `ashiato record` (default `http://127.0.0.1:4100`), or `steps` reads a saved session. They show values unless `--no-values` is given.

## For AI chats (no agent)

Where AI agents aren't allowed but a chat is (Microsoft 365 Copilot Chat, for example), you carry the text between the chat and your machine. Two commands make that one paste each way:

```sh
npx ashiato schema --db <url> [--tables "M_*,T_ORDER"] [--no-views] [--out docs/db/schema.md]
npx ashiato query checks/order-totals.sql --db <url> [--max-rows 50] [--out <file>] [--no-clip]
```

- **`schema`** writes the tables' and views' columns, types, primary keys and comments as Markdown (`docs/db/schema.md` by default), for the chat to write SQL against. No row values. `--tables` takes names or `*` / `?` patterns: a chat takes about 100,000 characters in one paste, so pick the tables of a large database.
- **`query`** runs the statements of `.sql` files (a folder: its `.sql` files by name), one after another, and copies the results to the clipboard as Markdown: each statement with the comment above it, its SQL, and its first `--max-rows` rows. Paste that into the chat. A statement that fails shows the database's error and the others still run.

```sql
-- Orders whose total differs from their lines (none expected)
SELECT o.order_no, o.total, SUM(l.qty * l.price) AS lines_total
FROM orders o JOIN order_lines l ON l.order_no = o.order_no
GROUP BY o.order_no, o.total
HAVING o.total <> SUM(l.qty * l.price);
```

**Only reading.** `query` runs `SELECT` and `WITH` statements only. If any statement could write (`INSERT`, `UPDATE`, `SELECT ... INTO`, `FOR UPDATE`, `EXEC`, a second statement hidden in a SQL Server batch...), none is run, and what is copied says which statement and why, so that the chat can rewrite it. As second guards, statements run in a read-only transaction (PostgreSQL, MySQL, Oracle), in a transaction that is always rolled back (SQL Server), or on a database opened read-only (SQLite). Connect as a user that may only `SELECT` all the same (see below).

**The results hold your data.** ashiato only puts them on your clipboard; pasting them into a chat sends them to that service. Check that your company allows it for the database you query (a test database, not production). Files are read as UTF-8 or Shift_JIS. Statements end with `;`, or a line with only `GO` or `/`. On SQL Server the driver hands decimals over as floating-point numbers: `CAST` a column with more than 15 significant digits to `varchar` to see all of them.

## Large tables

Only the first snapshot reads every row. After that, the database splits each table into buckets of about 256 rows and returns a row count and a checksum per bucket. Only buckets whose checksum changed are read again, so a checkpoint where nothing changed transfers almost nothing. It is all plain `SELECT`s: no setting changes, no extra permissions.

| Database | Checksum of a row | Buckets |
| --- | --- | --- |
| PostgreSQL | `xmin` (changes on every insert and update) | hash of the primary key |
| SQL Server | the table's `rowversion` column if it has one, otherwise SHA-256 of the row as JSON (SQL Server 2016 or later) | `CHECKSUM` of the primary key |
| Oracle | `ORA_ROWSCN` (kept per data block) | data block, so a change also re-reads the rows sharing its block |
| MySQL / MariaDB | MD5 of the row's values | CRC32 of the primary key |
| SQLite | — (a local file: read in full) | |

A table without a primary key is a single bucket: it is read again only when something in it changed. When a table can't be read this way (for example a SQL Server column type that `FOR JSON` can't serialize), the recorder says so at start and reads that table in full. `--full-read` turns incremental reads off.

Rows are kept in memory, so `--max-rows` still applies.

## Tables created while recording

The tables are listed again at every checkpoint. A table created while recording is watched from the first checkpoint that sees it: that step marks it as a new table and shows its rows as inserted. A table that is dropped (or can no longer be read) is reported once and no longer watched. A table that is created again or altered (`ALTER TABLE`) is read in full again, with its new columns and primary key. With `--tables`, only tables with those names are watched.

The read-only user only sees the tables it may read. For new tables to be watched, let it read the whole schema rather than table by table:

| Database | |
| --- | --- |
| SQL Server | `GRANT SELECT ON SCHEMA::dbo TO ashiato` (or the `db_datareader` role) |
| Oracle | `GRANT READ ANY TABLE ON SCHEMA app TO ashiato` (23ai), or `GRANT READ ANY TABLE TO ashiato` |
| PostgreSQL | `ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON TABLES TO ashiato` (or the `pg_read_all_data` role, 14+) |
| MySQL / MariaDB | `GRANT SELECT ON appdb.* TO 'ashiato'@'%'` |

## Connection URLs

| Database | URL | Driver |
| --- | --- | --- |
| SQL Server | `mssql://user:pass@host:1433/db?instance=SQLEXPRESS` (options: `encrypt=true`, `applicationIntent=ReadOnly`, `requestTimeout=120000`) | `mssql` |
| Oracle | `oracle://user:pass@host:1521/service?schema=OWNER` | `oracledb` (Thin mode, no Instant Client). Add `client=thick` (and `libDir=<Instant Client folder>` unless it is on `PATH`) for Thick mode, which also connects with old 10G passwords (`NJS-116`), required network encryption (`NJS-533`) and 11g (`NJS-138`) |
| PostgreSQL | `postgres://user:pass@host:5432/db` | `pg` |
| MySQL / MariaDB | `mysql://user:pass@host:3306/db` | `mysql2` |
| SQLite | `sqlite:./dev.db` | built in (Node.js 22.13+; 22.5–22.12 need `--experimental-sqlite`) |

The URL can also come from the `ASHIATO_DB_URL` environment variable.

## Options

| Option | |
| --- | --- |
| `--tables a,b` | Tables to watch (default: all, including tables created while recording). `name` or `schema.name`, case-insensitive |
| `--ignore-columns updated_at` | Columns ignored when detecting updates |
| `--max-rows 100000` | Tables larger than this are skipped (reported, not read) |
| `--full-read` | Read every row at each checkpoint, not only the parts that changed |
| `--out .ashiato/sessions` | Where sessions are saved |
| `--port 4100` | Timeline UI port |
| `--no-ui` | Terminal only |

## HTTP API

The recorder listens on `127.0.0.1` only.

| | |
| --- | --- |
| `POST /api/checkpoint` `{ "label": "click Save", "source": "orders.save" }` | Take a checkpoint, returns the step |
| `GET /api/session` | The whole session |
| `GET /api/events` | Server-sent events, one `step` event per checkpoint |
| `POST /api/replay` `{ "tab": "a1b2", "events": [...] }` | Append rrweb events (sent by the Vite plugin). Replies `{ "snapshot": true }` while the tab has sent no full snapshot |
| `GET /api/replay` | All replay events, one `{ tab, events }` batch per line (supports `Range`) |
| `POST /api/video`, `/api/video/:id/chunk`, `/api/video/:id/stop` | Screen recording upload (from the timeline UI only) |
| `GET /api/video/:id` | A screen recording (supports `Range`) |
| `GET /api/export?format=xlsx\|pdf\|html&lang=ja&changedOnly=1` | Evidence file (requests from the timeline page only) |
| `GET /api/export?format=playwright&name=...` | A Playwright test made from the session (requests from the timeline page only) |

Other web pages open in your browser can call `POST /api/checkpoint` and `POST /api/replay` (the app under test runs on another origin), but they can't read recorded rows, replays or videos back.

## Limits of read-only snapshots

- Changes are compared between checkpoints, so a row changed twice between two checkpoints shows only the final result.
- On a shared development database, other people's changes during the same moment are included.
- Tables without a primary key are compared row by row, so an update appears as a delete plus an insert.
- The first snapshot reads the watched tables in full and keeps them in memory; later checkpoints re-read only what changed (see [Large tables](#large-tables)). Tables above `--max-rows` are skipped. A step lists any table it could not compare (too large, or unreadable).
- A table created and dropped again between two checkpoints is never seen. Tables created later are watched only if the read-only user can read them (see [Tables created while recording](#tables-created-while-recording)).

## Roadmap

1. ✅ Read-only snapshot diff, all major databases, CLI, timeline UI
2. ✅ Vite plugin: checkpoint automatically around each user action (fetch / XHR / WebView2 `postMessage`)
3. ✅ Screen replay (rrweb) and screen recording synced with the timeline
4. ✅ Faster checkpoints for large tables: re-read only the buckets whose checksum changed (`xmin`, `rowversion`, `ORA_ROWSCN`, row hashes)
5. ✅ Evidence export (Excel / PDF) with screenshots of each step
6. ✅ `expectDbChanges()` for Playwright, tests generated from recordings, CLI / MCP server for AI agents

## Development

```sh
pnpm install
pnpm test          # unit tests + SQLite; set ASHIATO_TEST_{POSTGRES,MYSQL,MSSQL,ORACLE}_URL for real servers
pnpm build         # UI + CLI into packages/ashiato/dist
node packages/ashiato/dist/bin.js record --db sqlite:./dev.db
```

---

## 日本語

アプリで「保存」を押したあと、DBに正しく書き込まれたかを確かめるには、操作の前後で `SELECT` を何本も打って見比べる必要があります。ashiato は対象テーブルのスナップショットを取り、チェックポイントを打つたびに「前回から何が変わったか」を表示します。

- **参照権限だけで動く**:`SELECT` しか使いません。トリガー・CDC・DBの設定変更は不要です
- **主要DBに対応**:SQL Server / Oracle / PostgreSQL / MySQL・MariaDB / SQLite
- **ローカル完結**:データは外部に送信しません。セッションはJSONファイルとして保存します

### 使い方

```sh
npm install -D ashiato mssql   # 使うDBのドライバーも一緒に: mssql | oracledb | pg | mysql2(SQLiteは不要)

npx ashiato tables --db "mssql://user:pass@localhost:1433/devdb"
npx ashiato record --db "mssql://user:pass@localhost:1433/devdb" --tables orders,stock --ignore-columns updated_at
```

アプリを操作し、操作ごとにターミナルで **Enter** を押します(先にラベルを入力しても構いません)。タイムライン画面 <http://127.0.0.1:4100> の **Checkpoint** ボタンでも記録できます。**Ctrl+C** で終了すると、セッションが `.ashiato/sessions/` に保存されます。あとから `ashiato show <ファイル>` で見返せます。

社内の SQL Server / Oracle と実際のアプリで試すときの手順は [docs/trial-guide.ja.md](docs/trial-guide.ja.md) にあります。

### Viteアプリから自動でチェックポイント

```ts
// vite.config.ts
import ashiato from "ashiato/vite";

export default defineConfig({
  plugins: [react(), ashiato()], // dev サーバーのときだけ動き、本番ビルドには入りません
});
```

通信を伴うクリック・送信・Enter が、それぞれ1つのチェックポイントになります。ラベルには、押したボタンと送った通信が入ります。

- **追跡するもの**:`fetch`、`XMLHttpRequest`(axios)、WebView2 の `window.chrome.webview.postMessage`(JSON-RPC 形式 `{ id, method }` → `{ id, result | error }`。webview2-bridge はそのまま使えます)。同期 XHR(`open(method, url, false)`)と `chrome.webview.postMessageWithAdditionalObjects` は追跡しません
- **操作ごとに1つ**:クリックから1秒以内に始まった通信と、それに続く通信をそのクリックにまとめ、最後の通信が終わってから150ms後に記録します。`settleMs` より短い間隔で通信するポーリングがあると、操作が `maxRequestMs` まで終わらないため、そのURLは `ignore` に指定してください
- **操作外の変更は分ける**:操作の最初の通信を送る直前に一度記録します。他の人やバッチによる変更は「outside actions」として別に表示し、あなたの操作のせいにはしません
- **重なった操作は1つにまとめる**:データを変える通信と次のクリックの通信が同時に動くと(ダブルクリックなど)、どちらの変更かを区別できません。データを変えた最初のクリックの名前で1つのステップにまとめ、すべての通信を一覧に出します
- **DBが遅くても別々のクリックはまとめない**:クリックの通信は、前のクリックの通信が記録を待ったのと同じ時間だけ待ってから(クリックした間隔を保ったまま)、前のクリックの記録が終わるのを待って送ります。1回の記録に1秒ほどかかるDBでは、通信が1〜2秒待つことがあります。監視するテーブルを絞る(`--tables`)と速くなります。通信が待っている間にターミナルで Enter を押すと、その変更の一部がそのステップに入ります。直前のステップが表示されてから押してください
- クリックを伴わない通信のうちデータを変えうるもの(`GET` / `HEAD` 以外)は、変更があったときだけ記録します。読むだけの通信(画面表示時、ポーリング)では記録しません。それでも何か変わっていた場合は、次のステップで「outside actions」として表示します。通信のないクリックは記録しません

| オプション | 既定値 | |
| --- | --- | --- |
| `recorder` | `http://127.0.0.1:4100` | `ashiato record` のURL(`ASHIATO_RECORDER_URL` でも指定できます) |
| `settleMs` | `150` | 最後の通信が終わってからチェックポイントまでの待ち時間 |
| `oneWayMs` | `500` | 返信のない `postMessage` のあとに待つ時間 |
| `syncBefore` | `true` | 操作の前にも記録して、操作外の変更を分ける |
| `syncTimeoutMs` | `5000` | 通信がその記録を待つ最大時間 |
| `mergeMs` | `300` | 通信が始まる前にこの間隔で続いたイベントを1つの操作にまとめる(クリック+送信) |
| `attachMs` | `1000` | この時間内に始まった通信(またはクリックの通信が続いている間に始まった通信)だけを直前のクリックにまとめる |
| `maxRequestMs` | `30000` | この時間を過ぎても終わらない通信は「応答なし」として記録する。これより古い操作には新しい通信をまとめない |
| `ignore` | `[]` | 追跡しないURL(部分一致) |
| `replay` | `true` | 画面リプレイ用にページを記録する。`{ maskAllInputs: true }` ですべての入力値を隠す |
| `enabled` | `true` | `ASHIATO=0` でも無効にできる |

### 画面リプレイと画面録画

タイムラインでステップを選ぶと、**Screen** 欄にそのときの画面が表示されます。**▶ Play this action** で、クリックの直前からチェックポイントまでを再生します。

- **リプレイ(Viteプラグイン)**:画面を動画ではなくDOMの変化として [rrweb](https://github.com/rrweb-io/rrweb) で記録するので、軽くて鮮明です。パスワード欄は常に伏せ字になり、すべての入力値を隠すなら `replay: { maskAllInputs: true }` を指定します。タブごとに分けて記録します(ポップアップは別のタブ、フレームはそのページの一部として扱います)。レコーダーより先に開いていたページは、レコーダー起動の数秒後から再生できます
- **録画(どのアプリでも)**:タイムラインの **● Record screen** を押し、ウィンドウか画面全体を選びます。ブラウザに限らず、WebView2 を使った WinForms / WPF アプリなどデスクトップ上の何でも録画できます。動画は1秒ごとにレコーダーへ送られ、各ステップは動画内のその時刻に移動します
- どちらもセッションファイルの隣(`<session>.replay.ndjson`(最大1GB)、`<session>.video-<n>.webm`)に保存され、外部には送られません。`ashiato show` でも再生できます

### 証跡の出力(Excel / PDF)

セッションをテストの証跡として出力します。タイムライン画面の **⤓ Excel** / **⤓ PDF** ボタンを押すか、保存済みのセッションをターミナルから出力します。

```sh
npx ashiato export .ashiato/sessions/2026-10-11T04-00-00-000Z.json --format xlsx,pdf
```

- **Excel**:概要シート(1ステップ1行。各ステップのシートへのリンク付き)、変わった行と列をすべて並べた **変更一覧** シート(フィルター付き)、ステップごとのシート(操作・通信・画面キャプチャ・テーブルごとの変更行)を出力します。更新は変更前と変更後の行を並べ、変わったセルを色付けします。値は型を保ったまま書き込み、15桁を超える数値(IDなど)はExcelで丸められないよう文字列にします
- **PDF**:同じ内容をA4横・ページ番号付きで出力します。1ページ目が概要、以降は1ステップ1ページです。表は種類(追加・更新・削除)ごとに200行までで、全行はExcelにあります
- **画面キャプチャ**:各ステップの「操作直前の画面」と「チェックポイント時点の画面」を、画面リプレイ(なければ画面録画)から切り出して載せます。画面を記録していないステップには付きません
- **手元だけで完結**:PDFと画面キャプチャは、PCにインストール済みの Chrome / Edge(WindowsにはEdgeが必ずあります)を、使い捨てのプロファイル・localhost以外へのネットワークなしのヘッドレスで起動して作ります。Excelはブラウザなしで出力できます。ポリシーでブラウザのリモートデバッグが無効な場合は、ページ番号と画面キャプチャなしのPDFになります
- 言語はPCの設定に合わせます(日本語/英語)。タイムライン画面で **Hide steps without changes** にチェックを入れると、変更のないステップは出力にも含めません

| オプション | |
| --- | --- |
| `--format xlsx,pdf,html` | 出力形式(既定 `xlsx`)。`html` はPDFの元になる印刷用ページです |
| `--out <パス>` | 出力ファイルまたはフォルダー(既定:セッションファイルの隣に同じ名前で) |
| `--lang ja\|en` | 出力の言語(既定:PCの設定) |
| `--changed-only` | 変更のないステップを含めない |
| `--no-screens` | 画面キャプチャを付けない |
| `--browser <パス>` | 使う Chrome / Edge(`ASHIATO_BROWSER` でも指定できます) |

### Playwright のテストでDBを確かめる

`expectDbChanges(操作, 期待)` は、操作を実行して、それでDBがどう変わったかを同じ参照権限だけで確かめます。ashiato と一緒に `@playwright/test` をインストールしてください。

```ts
// tests/orders.spec.ts
import { test, expect } from "ashiato/playwright";

test.use({ ashiato: { ignoreColumns: ["updated_at"] } }); // DB は ASHIATO_DB_URL、または ashiato: { db: "..." }

test("注文する", async ({ page, expectDbChanges }) => {
  await page.goto("/orders/new");
  await page.getByLabel("数量").fill("10");
  const changes = await expectDbChanges(() => page.getByRole("button", { name: "保存" }).click(), {
    orders: { inserted: [{ id: expect.any(Number), customer_id: 7, qty: 10 }] },
    stock: { updated: [{ where: { item_id: 3 }, set: { qty: 40 } }] },
  });
  expect(changes.orders.inserted[0].id).toBeGreaterThan(0);
});
```

- 操作の前に対象テーブルを読み、操作を実行してから、変更が `settleMs`(300ミリ秒)止まって期待と合うまで、最大 `timeout`(5秒)待ちます
- 書いたテーブルはすべて書いたとおりに変わる必要があり、**書いていない対象テーブルが変わると失敗**します。`{}` は「何も変わらない」、`orders: {}` は「orders は変わらない」を確かめます。操作の前には読めたのに後で読めなくなった対象テーブルも、変わったかもしれないので失敗にします
- `inserted` / `deleted` は行のリストか件数(`inserted: 300`)、`updated` は `{ where, set }` のリストです。`where` で行を選び、`set` にはその更新で変わった列をすべて書きます(`updated_at` のような列や SQL Server の `rowversion` 列は `ignoreColumns` に)。書いた列だけを比べ(列名の大文字・小文字は問いません)、Playwright の `expect.any()` や `expect.stringContaining()` なども使えます。`Date` は同じ時刻かを比べます。DB がタイムゾーンなしで返す時刻は UTC として読むので、どのマシンでも同じ結果になります
- 失敗すると、どの行のどの列が違うか、期待にない変更、実際に変わったものすべてをエラーに出します。エラーはテスト自身の行を指し、レポートには `expect database changes: orders +1, stock ~1` というステップで表示されます
- 同じDBを確かめるテストは1つずつ実行してください(`--workers=1`)。並列だとお互いの書き込みが見えてしまいます
- オプション(`test.use({ ashiato })`):`db`・`tables`・`ignoreColumns`・`maxRows`・`timeout`・`settleMs`。呼び出しごと(第3引数)には `timeout`・`settleMs`
- Playwright なしでも使えます:`import { watchDb } from "ashiato"` して `const db = watchDb(url)`、`await db.expectChanges(操作, 期待)`、最後に `await db.close()`(接続が開いたままだと Node が終わりません)

### 記録からテストを作る

記録したセッションから、ブラウザでの操作をもう一度行い、ステップごとに同じ行が変わるかを確かめる Playwright のテストを作れます。タイムライン画面の **⤓ Playwright test** を押すか、次のコマンドを実行します。

```sh
npx ashiato codegen .ashiato/sessions/2026-10-11T04-00-00-000Z.json   # 隣に ...000Z.spec.ts を書き出します
```

- クリック・入力・選択・チェック・Enter・ページ移動は、画面リプレイ(Viteプラグインが記録)から取り出します。編集できる領域(`contenteditable`)への入力も同じです。要素は Playwright 推奨の順(テストID → ロールと名前 → ラベル → プレースホルダ → テキスト → id や属性)で、その時点のページで1つに決まるものを使います。スタイルシートで空白が入るかが決まる名前(flex の中の `<span>受注</span><span>一覧</span>` など)は `/^受注 ?一覧$/` のようなパターンで探します
- `alert` / `confirm` / `prompt` には、記録時と同じ応答を返します(`page.once("dialog", ...)`)
- DB が決める値は `expect.any()` で比べます:新しい行のキー、それを参照する列(`order_id` など)、新しい行の UUID、SQL Server の行バージョン、記録時刻付近の日時です。パスワード・ハッシュ・ソルト・トークン・シークレットらしい名前の列も、値をテストに書き写さず `expect.any(String)` にします。1つの種類で20行を超えるステップは件数で確かめます
- 実行する前に、DB を記録開始時の状態に戻し、`ASHIATO_DB_URL` を設定してください。WebView2 経由のステップは、ページをデスクトップアプリ(または `chrome.webview` の代役)の中で動かす必要があります。画面リプレイがない場合、操作は `TODO` になります
- パスワードと伏せ字にした入力(`maskAllInputs`)はリプレイにないので `TODO` になります

### AIエージェント向け(CLI / MCP)

アプリを開発中のAIエージェントが、作業しながらDBを記録し、各ステップで何が変わったかを読めます。

**MCPサーバー**:エージェントに登録します(Claude Code なら `claude mcp add ashiato -- npx ashiato mcp --db <url>`)。

```sh
npx ashiato mcp --db <url> [--tables ...] [--ignore-columns ...] [--port 4100] [--out <フォルダー>] [--share-values]
npx ashiato mcp --recorder http://127.0.0.1:4100   # 起動中の ashiato record を読む場合
```

セッションは `--out`(既定 `.ashiato/sessions`)に保存します。相対パスはエージェントがサーバーを起動したフォルダーから数えるので、別の場所で起動するエージェントではフルパスを指定してください。

| ツール | |
| --- | --- |
| `list_tables` | テーブル・行数・主キー |
| `start_recording` | 基準のスナップショットを取り、`--port` でタイムラインを起動します。Viteプラグインがアプリの操作ごとにステップを作ります |
| `checkpoint` | 今の時点でステップを作ります(前のステップからの変更) |
| `list_steps`・`get_step` | ステップの一覧(1行ずつ)、または1つの詳細(操作・通信・変わった行) |
| `stop_recording` | セッションファイルを保存します |
| `generate_test` | 記録から Playwright のテストを書き出します(上記) |
| `export_evidence` | Excel / PDF / HTML の証跡を書き出します |

**行の値は既定では手元に残ります。** MCPサーバーの応答はAIに渡り、クラウドのAIならデータが社外に出ます。`--share-values` を付けて起動しない限り、AIに見えるのはテーブル名・列名・件数・どの列が変わったかだけで、行の値・URLのクエリ・クリックした要素の文字(ボタンの表記と入力欄のラベル以外。リンク・セル・チェックボックスのラベル・クリックできる行はデータを表示していることがあるため)・アプリやDBのエラーメッセージは渡しません。生成したテストと証跡はファイルに書き出し、AIにはその場所だけを返します。ashiato 自身はどこにも何も送りません。

**CLI**:スクリプトや、コマンドを実行するエージェント向けです。

```sh
npx ashiato checkpoint "取り込みを実行" [--recorder http://127.0.0.1:4100] [--json] [--no-values]
npx ashiato steps [session.json] [--since 3] [--full] [--json] [--no-values]
npx ashiato tables --db <url> --json
```

`checkpoint` と `steps` は起動中の `ashiato record`(既定 `http://127.0.0.1:4100`)と通信します。`steps` は保存済みのセッションも読めます。`--no-values` を付けない限り値を表示します。

### AIチャット向け(エージェントなし)

AIエージェントは使えないがチャット(Microsoft 365 Copilot Chat など)は使える環境では、チャットと手元のPCの間を人がテキストで運びます。次の2つのコマンドで、行き帰りとも1回の貼り付けで済みます。

```sh
npx ashiato schema --db <url> [--tables "M_*,T_ORDER"] [--no-views] [--out docs/db/schema.md]
npx ashiato query checks/order-totals.sql --db <url> [--max-rows 50] [--out <ファイル>] [--no-clip]
```

- **`schema`**:テーブルとビューの列・型・主キー・コメントを Markdown に書き出します(既定は `docs/db/schema.md`)。チャットのAIがこれを見て SQL を書きます。行の値は含みません。`--tables` には名前か `*`・`?` のパターンを指定します。チャットに1回で貼れるのは10万文字ほどなので、大きなDBではテーブルを絞ってください。
- **`query`**:`.sql` ファイル(フォルダーならその中の `.sql` を名前順)の文を順に実行し、結果を Markdown でクリップボードに入れます。文ごとに、直前のコメント・SQL・先頭 `--max-rows` 行が入ります。それをチャットに貼ります。エラーになった文はDBのエラーを表示し、残りの文はそのまま実行します。

```sql
-- 合計が明細の合計と一致しない受注(0 行なら OK)
SELECT o.order_no, o.total, SUM(l.qty * l.price) AS lines_total
FROM orders o JOIN order_lines l ON l.order_no = o.order_no
GROUP BY o.order_no, o.total
HAVING o.total <> SUM(l.qty * l.price);
```

**参照だけです。** `query` が実行するのは `SELECT` と `WITH` の文だけです。書き込む可能性のある文(`INSERT`・`UPDATE`・`SELECT ... INTO`・`FOR UPDATE`・`EXEC`・SQL Server のバッチに続けて書いた別の文など)が1つでもあれば1文も実行せず、どの文がなぜだめかをクリップボードに入れます(チャットに貼れば書き直してもらえます)。さらに、読み取り専用トランザクション(PostgreSQL・MySQL・Oracle)、必ずロールバックするトランザクション(SQL Server)、読み取り専用で開いたDB(SQLite)の中で実行します。それでも、接続には SELECT だけを許可したユーザーを使ってください(下記)。

**結果にはデータが入ります。** ashiato はクリップボードに入れるだけですが、チャットに貼るとそのサービスに送られます。対象のDB(本番ではなくテスト用)の値をチャットに貼ってよいか、社内の決まりを確かめてください。ファイルは UTF-8 か Shift_JIS で読みます。文の区切りは `;` か、`GO` または `/` だけの行です。SQL Server のドライバーは decimal を浮動小数点数で返すため、有効数字が15桁を超える列は `varchar` に `CAST` すると全桁を見られます。

### 大きなテーブル

全件を読むのは最初のスナップショットだけです。以降は、DB側で各テーブルを約256行ずつのバケットに分け、バケットごとの行数とチェックサムを返します。チェックサムが変わったバケットだけを読み直すので、何も変わっていないチェックポイントではほとんど通信しません。使うのは通常の `SELECT` だけで、設定変更も追加の権限も不要です。

| DB | 行のチェックサム | バケットの分け方 |
| --- | --- | --- |
| PostgreSQL | `xmin`(追加・更新のたびに変わる) | 主キーのハッシュ |
| SQL Server | テーブルに `rowversion` 列があればその値、なければ行をJSONにしたSHA-256(SQL Server 2016以降) | 主キーの `CHECKSUM` |
| Oracle | `ORA_ROWSCN`(データブロック単位) | データブロック単位。変更があると同じブロックの行も読み直します |
| MySQL / MariaDB | 行の値のMD5 | 主キーのCRC32 |
| SQLite | なし(ローカルファイルなので全件読みます) | |

主キーのないテーブルは1つのバケットとして扱い、中身が変わったときだけ読み直します。この方法で読めないテーブル(`FOR JSON` で扱えない列型を持つSQL Serverのテーブルなど)は、記録開始時にその旨を表示して全件読みます。`--full-read` を付けると、この仕組みを使わずに毎回全件読みます。

行はメモリに保持するので、`--max-rows` の上限はそのまま有効です。

### 記録中に作られたテーブル

チェックポイントのたびにテーブル一覧を取り直します。記録中に作られたテーブルは、それが見えた最初のチェックポイントから対象になり、そのステップでは新しいテーブルとして、中の行を追加として表示します。削除された(または読めなくなった)テーブルは一度だけ表示し、以降は対象から外します。作り直されたテーブルや `ALTER TABLE` で変更されたテーブルは、新しい列と主キーで全件読み直します。`--tables` を指定したときは、その名前のテーブルだけが対象です。

参照専用ユーザーには、読み取りを許可されたテーブルしか見えません。新しく作られるテーブルも対象にするには、テーブルごとではなくスキーマ全体の参照を許可してください。

| DB | |
| --- | --- |
| SQL Server | `GRANT SELECT ON SCHEMA::dbo TO ashiato`(または `db_datareader` ロール) |
| Oracle | `GRANT READ ANY TABLE ON SCHEMA app TO ashiato`(23ai)、または `GRANT READ ANY TABLE TO ashiato` |
| PostgreSQL | `ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON TABLES TO ashiato`(または `pg_read_all_data` ロール、14以降) |
| MySQL / MariaDB | `GRANT SELECT ON appdb.* TO 'ashiato'@'%'` |

### 参照専用スナップショットの制限

- チェックポイント間の比較なので、その間に同じ行が2回変わった場合は最終結果だけが見えます
- 共有の開発DBでは、同じ時間帯に他の人が行った変更も含まれます
- 主キーのないテーブルは行全体で比較するため、更新は「削除+追加」として表示されます
- 最初のスナップショットで対象テーブルを全件読んでメモリに保持し、以降は変わった部分だけを読み直します(「大きなテーブル」参照)。`--max-rows` を超えるテーブルはスキップし、比較できなかったテーブル(大きすぎる・読めない)は各ステップに表示します
- 2つのチェックポイントの間に作られて削除されたテーブルは見えません。記録中に作られたテーブルは、参照専用ユーザーが読める場合だけ対象になります(「記録中に作られたテーブル」参照)

### ロードマップ

1. ✅ 参照専用スナップショット差分・主要DB対応・CLI・タイムライン画面
2. ✅ Viteプラグイン:操作ごとに自動でチェックポイント(fetch / XHR / WebView2 `postMessage`)
3. ✅ タイムラインと同期した画面リプレイ(rrweb)・画面録画
4. ✅ 大きなテーブル向けの高速化:チェックサムが変わったバケットだけを読み直す(`xmin`・`rowversion`・`ORA_ROWSCN`・行ハッシュ)
5. ✅ テスト証跡の出力(Excel / PDF)。各ステップの画面キャプチャ付き
6. ✅ Playwright 向け `expectDbChanges()`、記録からのテストコード生成、AIエージェント向けの CLI / MCP サーバー

## License

MIT
