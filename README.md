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

npx ashiato tables --db "mssql://user:pass@localhost:1433/devdb?encrypt=false"
npx ashiato record --db "mssql://user:pass@localhost:1433/devdb?encrypt=false" --tables orders,stock --ignore-columns updated_at
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

## Connection URLs

| Database | URL | Driver |
| --- | --- | --- |
| SQL Server | `mssql://user:pass@host:1433/db?encrypt=false&instance=SQLEXPRESS` | `mssql` |
| Oracle | `oracle://user:pass@host:1521/service?schema=OWNER` | `oracledb` (Thin mode, no Instant Client) |
| PostgreSQL | `postgres://user:pass@host:5432/db` | `pg` |
| MySQL / MariaDB | `mysql://user:pass@host:3306/db` | `mysql2` |
| SQLite | `sqlite:./dev.db` | built in (Node.js 22.5+) |

The URL can also come from the `ASHIATO_DB_URL` environment variable.

## Options

| Option | |
| --- | --- |
| `--tables a,b` | Tables to watch (default: all). `name` or `schema.name`, case-insensitive |
| `--ignore-columns updated_at` | Columns ignored when detecting updates |
| `--max-rows 100000` | Tables larger than this are skipped (reported, not read) |
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

This is what the upcoming browser integration (Vite plugin, WebView2 `postMessage` hooks) uses to take checkpoints automatically around each user action.

## Limits of read-only snapshots

- Changes are compared between checkpoints, so a row changed twice between two checkpoints shows only the final result.
- On a shared development database, other people's changes during the same moment are included.
- Tables without a primary key are compared row by row, so an update appears as a delete plus an insert.
- Each checkpoint reads the watched tables in full. Use `--tables` to keep it fast; large tables are skipped above `--max-rows`.

## Roadmap

1. ✅ Read-only snapshot diff, all major databases, CLI, timeline UI
2. Vite plugin: record user actions (rrweb) and API / WebView2 `postMessage` calls, checkpoint automatically around each one
3. Faster diffs for large tables (range hashing, `rowversion` / `ORA_ROWSCN`)
4. Screen video synced with the timeline, evidence export (Excel / PDF)
5. `expectDbChanges()` for Playwright, export recordings as tests, CLI / MCP server for AI agents

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

npx ashiato tables --db "mssql://user:pass@localhost:1433/devdb?encrypt=false"
npx ashiato record --db "mssql://user:pass@localhost:1433/devdb?encrypt=false" --tables orders,stock --ignore-columns updated_at
```

アプリを操作し、操作ごとにターミナルで **Enter** を押します(先にラベルを入力しても構いません)。タイムライン画面 <http://127.0.0.1:4100> の **Checkpoint** ボタンでも記録できます。**Ctrl+C** で終了すると、セッションが `.ashiato/sessions/` に保存されます。あとから `ashiato show <ファイル>` で見返せます。

### 参照専用スナップショットの制限

- チェックポイント間の比較なので、その間に同じ行が2回変わった場合は最終結果だけが見えます
- 共有の開発DBでは、同じ時間帯に他の人が行った変更も含まれます
- 主キーのないテーブルは行全体で比較するため、更新は「削除+追加」として表示されます
- チェックポイントのたびに対象テーブルを全件読みます。`--tables` で対象を絞ってください。`--max-rows` を超えるテーブルはスキップします

### ロードマップ

1. ✅ 参照専用スナップショット差分・主要DB対応・CLI・タイムライン画面
2. Viteプラグイン:画面操作(rrweb)とAPI / WebView2 `postMessage` を記録し、操作ごとに自動でチェックポイントを打つ
3. 大きなテーブル向けの高速化(範囲ハッシュ比較、`rowversion` / `ORA_ROWSCN`)
4. タイムラインと同期した画面録画、テスト証跡の出力(Excel / PDF)
5. Playwright 向け `expectDbChanges()`、記録からのテストコード書き出し、AIエージェント向けの CLI / MCP サーバー

## License

MIT
