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
- Requests with no click (page load, polling) are recorded only when they changed something. Clicks that send nothing are not recorded.

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
| Oracle | `oracle://user:pass@host:1521/service?schema=OWNER` | `oracledb` (Thin mode, no Instant Client) |
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
5. Evidence export (Excel / PDF)
6. `expectDbChanges()` for Playwright, export recordings as tests, CLI / MCP server for AI agents

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
- クリックを伴わない通信(画面表示時、ポーリング)は、変更があったときだけ記録します。通信のないクリックは記録しません

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
5. テスト証跡の出力(Excel / PDF)
6. Playwright 向け `expectDbChanges()`、記録からのテストコード書き出し、AIエージェント向けの CLI / MCP サーバー

## License

MIT
