# ashiato セキュリティ説明資料(情報システム部門向け)

テスト用 DB の変化を記録・照合するコマンドラインツール ashiato の、導入審査用の資料です。
どのデータがどこへ出るか、ツールが何をして何をしないかを、コードで確かめられる形でまとめます。

- 対象: ashiato 0.2.0(npm)。main にある未公開の `pack` / `verify --auto` / `export-tests` / `schema --data` も書き、0.2.0 に無いものには「(0.3.0 予定)」と付ける
- ソース: <https://github.com/ishibashi0112/ashiato>(本体は `packages/ashiato/src`)
- ライセンス: MIT
- チャット AI で開発するための CLI [tazuna](https://github.com/ishibashi0112/tazuna) と組んで使えますが、別のパッケージです。
  tazuna は DB に接続しません。DB に接続するのは ashiato だけです。tazuna だけを導入する場合、この資料は要りません

## 1. 要約

| 観点 | 回答 |
|---|---|
| DB へのアクセス | 読み取り(SELECT)だけ。トリガー・CDC・一時テーブル・DB の設定変更は使わない。接続には SELECT だけを許可したユーザーを使う前提(§4) |
| AI が書いた SQL | 実行するのは `query` だけ。SELECT / WITH 以外の文が 1 つでもあれば 1 文も実行せず、さらに読み取り専用のトランザクション(SQL Server は必ずロールバックするトランザクション)の中で実行する(§4.2) |
| 外部への通信 | DB への接続だけ。ツールがほかへデータを送ることはない。チャット AI に渡るのは、利用者が自分で貼ったものだけ(§3, §5) |
| ポートの待ち受け | チャット向けの `schema` / `query` / `verify` は待ち受けない。`record` / `show` / `mcp` だけが 127.0.0.1 で待ち受ける(§2, §3) |
| 依存パッケージ | package.json の実行時依存は無し。DB ドライバーと Playwright は、使う人が入れる任意の依存。画面の記録と表示のために rrweb と React を同梱(§6) |
| 起動する外部コマンド | クリップボード(PowerShell / pbcopy / xclip)と、証跡の PDF・画面キャプチャ用の Chrome / Edge。どれもシェルを通さない(§7) |

## 2. コマンドと、審査で見るところ

チャット AI だけで使う運用(tazuna と組む運用)で打つのは `schema` / `query` / `verify` の 3 つです。
この 3 つは、ポートを開かず、ブラウザを起動せず、同梱物(§6)も実行しません。ほかのコマンドを使わないなら、
審査ではこの 3 つの行と、DB へのアクセス(§4)・チャットに貼る結果(§5.1)・DB ドライバー(§6)・クリップボード(§7)・
書き込むファイル(§8)を見れば足ります。

| コマンド | すること | DB | 待ち受け | ブラウザ | 書くファイル(§8) |
|---|---|---|---|---|---|
| `schema` | テーブル定義を Markdown に書く | カタログを読む(行の値は読まない) | なし | なし | `docs/db/schema.md` |
| `schema --data`(0.3.0 予定) | テーブル定義に件数・参照・列ごとのデータの姿を書き足す | テーブルを読む(集計の SELECT、§4.1) | なし | なし | `docs/db/schema.md` |
| `query` | AI が書いた SELECT を実行し、結果をクリップボードへ | SELECT(§4.2 の検査つき) | なし | なし | `--out` を付けたときだけ |
| `verify` | 人が操作するたびに変化を読み、手順ファイルの期待と照合 | テーブルを読む | なし | なし | `--out` / `--save-session` を付けたときだけ |
| `tables` | テーブルの一覧 | カタログを読む | なし | なし | なし |
| `record` | 操作ごとの変化を記録し、タイムライン画面で見せる | テーブルを読む | 127.0.0.1:4100(`--no-ui` で無し) | なし | `.ashiato/sessions/` |
| `show` | 保存した記録を画面で見る | なし | 127.0.0.1:4100 | なし | なし |
| `export` | 記録を Excel / PDF の証跡にする | なし | なし | PDF・画面キャプチャのときだけ Chrome / Edge(§7) | 記録の隣 |
| `codegen` | 記録から Playwright のテストを書く | なし | なし | なし | `.spec.ts` |
| `checkpoint` / `steps` | 起動中の `record` に問い合わせる | なし | なし(記録サーバーへ接続) | なし | なし |
| `mcp` | AI エージェント向けのサーバー(標準入出力) | テーブルを読む | 記録中は 127.0.0.1:4100(`--no-ui` で無し) | ツールによる | `.ashiato/` |
| `pack`(0.3.0 予定) | 画面の構成などをチャット向けにまとめる | カタログを読む | なし | Playwright で `--app` のページをたどる | `docs/ashiato/pack.md` |
| `verify --auto`(0.3.0 予定) | 手順ファイルの操作をブラウザで実行して照合 | テーブルを読む | なし | Playwright(§5.3) | `--login` のとき `.ashiato/login.json` |
| `export-tests`(0.3.0 予定) | 手順ファイルを Playwright のテストにする | なし | なし | なし | `tests/e2e/` |

## 3. 外部への通信

ashiato のコードが通信するのは次だけです。

- **DB への接続**: 各 DB のドライバー(§6)を通して、`--db` か環境変数 `ASHIATO_DB_URL` で指定した DB にだけ接続する
- **タイムライン画面のサーバー**(`record` / `show` / `mcp`): 127.0.0.1 でだけ待ち受ける(既定のポートは 4100)
  - Host ヘッダーが 127.0.0.1 / localhost 以外の要求は拒否する(DNS リバインディング対策)
  - 別のオリジンから受け付けるのは、アプリの開発用ページが操作を知らせる 2 つの送信(チェックポイントと画面リプレイ)だけで、その応答には記録の中身を入れない。ほかのサイトのページから記録を読むことはできない
  - 認証は無い。同じ PC にログインしている別の利用者(共有の端末サーバーなど)からは読める。そうした PC では `record` に `--no-ui` を付けるか、使い終わったらすぐ止める
- **記録サーバーへの問い合わせ**(`checkpoint` / `steps` / `mcp --recorder`): `--recorder` で指定した URL(既定 http://127.0.0.1:4100)にだけ送る
- **Vite プラグインがアプリの開発用ページに入れるスクリプト**: 記録サーバー(既定 http://127.0.0.1:4100)にだけ送る。開発サーバーのときだけ動き、本番のビルドには入らない
- **ブラウザ**: 証跡用の Chrome / Edge は localhost 以外へ届かない設定で起動する(§7)。`pack` / `verify --auto` のブラウザは、指定したアプリと手順ファイルの「開く:」の URL を開く(§5.3)

利用統計の送信や、更新の確認はしません。

確かめ方(ソースを取得して実行):

```sh
grep -rnE "from ['\"](node:)?(https?|net|tls|dgram|dns|http2)['\"]|fetch\(" ashiato/packages/ashiato/src --include=*.ts | grep -v "/src/client/"
```

`server/server.ts` の `node:http`(タイムライン画面のサーバー)、`cli/recording.ts` の型の読み込み、`agent/source.ts` の `fetch`(記録サーバーへの問い合わせ)だけが出ます。
`src/client/` はアプリの開発用ページで動くスクリプトで、送り先は記録サーバーだけです(`src/client/index.ts` の `recorder`)。

## 4. DB へのアクセス

### 4.1 使う SQL

- `schema` / `tables` / `record` / `verify` / `pack` が送る SQL は、ashiato のコードに書いた固定の SELECT です(カタログとテーブルの読み取り)。
  手順ファイルに書かれた表名は、DB から読んだ一覧と照らし合わせるだけで、SQL の文には入れません
- 大きなテーブルは、変わった部分だけを読み直すために、行のチェックサムを DB 側で計算する SELECT を使います
  (PostgreSQL の `xmin`、SQL Server の `rowversion` か `FOR JSON` + `HASHBYTES`、Oracle の `ORA_ROWSCN`、MySQL の `MD5`)。
  どれも通常の SELECT で、追加の権限や設定変更は要りません
- `schema --data`(0.3.0 予定)は、ashiato のコードが組み立てた集計の SELECT(件数・NULL の数・値の種類の数・最小と最大・文字数・区分の値ごとの件数・書式を調べるための値の一覧・見本の行・推定するつながりの照合)を、
  `query` と同じ読み取り専用の実行(§4.2 の 2.)で送ります。100 万行を超えるテーブルは先頭 10 万行だけを集計します(件数は全件)。
  表名・列名は DB のカタログから読んだものだけを、DB ごとの引用符で囲んで使います
- AI(チャット)が書いた SQL を実行するのは `query` だけです(§4.2)

### 4.2 `query` の守り

1. `.sql` を文に分け(`;`、または `GO` / `/` だけの行)、**すべての文**が次を満たすときだけ実行する。1 文でも満たさなければ 1 文も実行せず、
   どの文がなぜだめかをクリップボードに入れる(`src/chat/sql.ts` の `readOnlyProblem`)
   - SELECT か WITH で始まる
   - 書き込み・ロック・外部参照の語を含まない: INSERT・UPDATE・DELETE・MERGE・TRUNCATE・CREATE・ALTER・DROP・GRANT・EXEC・CALL・
     SELECT ... INTO・DECLARE・BEGIN・COMMIT・SET・FOR UPDATE / FOR SHARE・NEXT VALUE FOR・OPENROWSET・OPENQUERY・UPDLOCK など
   - 文字列やコメントに隠れた `;` で 2 文目が続いていない
   - これを DB ごとの引用符・コメントの書き方(SQL Server の `[...]`、PostgreSQL の `$$...$$`、Oracle の `q'[...]'`、MySQL の `#` など)すべてで確かめる
2. 実行は DB 側でも読み取りに限る: 読み取り専用トランザクション(PostgreSQL・MySQL・Oracle)、必ずロールバックするトランザクション(SQL Server)、
   読み取り専用で開いた DB(SQLite)
3. それでも、ツール側の検査は一次の防御で、最後の防御ではありません。接続には SELECT だけを許可したユーザーを使ってください(§4.3)

### 4.3 接続するユーザー

テスト用 DB に、SELECT だけを許可したユーザーを作ってください。記録中に作られたテーブルも読むには、スキーマ全体の参照を許可します。

| DB | 例 |
|---|---|
| SQL Server | `GRANT SELECT ON SCHEMA::dbo TO ashiato`(または `db_datareader` ロール) |
| Oracle | `GRANT READ ANY TABLE ON SCHEMA app TO ashiato`(23ai)、または `GRANT READ ANY TABLE TO ashiato` |
| PostgreSQL | `ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON TABLES TO ashiato`(または `pg_read_all_data` ロール) |
| MySQL / MariaDB | `GRANT SELECT ON appdb.* TO 'ashiato'@'%'` |

- 接続文字列(パスワードを含む)は、コマンド履歴に残らないよう環境変数 `ASHIATO_DB_URL` で渡すことを勧めます。記録ファイルには接続先を書きません(DB の種類だけ)
- 本番の DB には向けないでください。接続先を許可リストで止める仕組みは、まだありません(§9)

## 5. AI に渡るデータ

### 5.1 チャット AI(エージェントなし)

ashiato はチャットに何も送りません。結果をクリップボードかファイルに出し、それを貼るかどうかは利用者が決めます。

| コマンド | 結果に入るもの | 行の値 |
|---|---|---|
| `schema` | 表とビューの名前・列・型・Null・主キー・コメント | 入らない |
| `schema --data`(0.3.0 予定) | 上に加えて、件数・参照・列ごとの NULL の割合・値の種類の数・文字数・書式(`C999` のような形) | **一部入る**: 区分とみなした列の値と件数(20 種以下で、1 つの値が平均 5 行以上で使われている列)、数値と日付の最小と最大、`--samples` を付けたときの見本の行。列名かコメントが個人の情報・秘密・自由記述に見える列(氏名・電話・メール・住所・生年月日・パスワード・備考など)は値を書かず、見本の行では同じ形の別の値に置き換える(実行ごとに作って捨てる鍵の HMAC。元の値には戻せない)。隠す列・出す列は `docs/db/data-rules.json` で足し引きする |
| `query` | 文ごとに、直前のコメント・SQL・先頭 50 行(`--max-rows` で 1〜10,000) | **入る** |
| `verify` | 手順ごとの OK / NG・メモ・期待との違い・変わった行 | **入る** |
| `pack`(0.3.0 予定) | 各画面のアクセシビリティ木・記録で変わった表と列・テーブル定義 | 入らない。画面の文字のうち DB の値が出ていそうなもの(表のセル・選択肢・入力欄の値・1 件のデータへのリンクなど)は `…` に置き換える。`--page-text` を付けたときだけ残す |

`query` と `verify` の結果、`schema --data` の区分の値・範囲・見本の行を貼ると、DB の値がチャットのサービスに送られます。本番ではなくテスト用の DB で使い、
その値をチャットに貼ってよいかを社内の決まりで決めてください。

### 5.2 AI エージェント(`mcp`)

MCP サーバーの応答はエージェントの AI に渡ります。`--share-values` を付けて起動しない限り、渡すのはテーブル名・列名・件数・
どの列が変わったかだけで、行の値・URL のクエリ・クリック先の文字(ボタンの表記と入力欄のラベル以外)・アプリや DB のエラー文は渡しません。
書き出したテストと証跡はファイルに書き、AI にはその場所だけを返します。

### 5.3 手順ファイルの実行(`verify --auto`、0.3.0 予定)

`verify --auto` は、チャットが書いた手順ファイルの「操作:」の行を、Playwright でブラウザ操作して実行します。

- 書けるのは決まった操作だけです: 開く・入力・選ぶ・チェック / チェックを外す・押す・キー・待つ・確認・ダイアログ。
  要素は画面に出ている名前(アクセシビリティ木の名前)で指し、CSS・XPath・JavaScript は書けません
- 操作はアプリの画面を通るので、アプリが DB に書き込みます(それを照合するための機能です)。テスト用の DB で使ってください
- 「開く:」は書かれた URL をそのまま開きます。`--app` と別のサイトも開けるので、実行の前に手順ファイルに目を通してください
- `--login` で保存するログイン(`.ashiato/login.json`)には Cookie が入ります。バージョン管理に入れないでください

手動の `verify` は手順ファイルの文章を表示するだけで、何も実行しません。期待する DB の変化は SQL ではなく、照合にだけ使います。

## 6. 依存パッケージと同梱物

- **実行時依存**: package.json の `dependencies` はありません。Node.js 22.5 以上の標準機能で動きます(SQLite は組み込みの `node:sqlite`)
- **任意の依存**(`peerDependencies`。使う機能の分だけ利用者が入れる)

| パッケージ | 要る場面 | 備考 |
|---|---|---|
| `mssql` | SQL Server | 依存を含めて約 75 パッケージ(tedious と Azure の認証ライブラリなど。2026-11-03 に確認) |
| `oracledb` | Oracle | 1 パッケージ。Thick モードには別に Oracle Instant Client が要る |
| `pg` / `mysql2` | PostgreSQL / MySQL・MariaDB | |
| `@playwright/test` | `pack` / `verify --auto` / `expectDbChanges` / 生成したテストの実行 | |
| `vite` | Vite プラグイン | |

- **同梱しているサードパーティ**(すべて MIT。ビルド時に 1 つのファイルにまとめたもの)

| 同梱物 | 中身 | 動く場所 |
|---|---|---|
| `dist/client.global.js` | rrweb 2.1.6 とその依存(rrweb-snapshot・rrdom・@rrweb/types・@rrweb/utils・@xstate/fsm・base64-arraybuffer・mitt)| Vite プラグインがアプリの開発用ページに入れる(画面リプレイの記録) |
| `dist/capture.global.js` | rrweb の再生部分 | 証跡の画面キャプチャを撮るヘッドレスブラウザの中 |
| `dist/ui/` | React 19.3.0・react-dom・scheduler・rrweb | タイムライン画面(`record` / `show` のサーバーが配る) |

Node.js で動く部分(`dist/bin.js` などの CLI と各モジュール)は ashiato 自身のコードだけです。DB ドライバーと Playwright は、
使うときに初めて読み込みます(`src/adapters/load.ts`、`src/chat/browser.ts`)。チャット向けの 3 コマンドは同梱物を実行しません。

## 7. 起動する外部コマンド

どれも配列引数で起動し、シェルを通しません。

- **クリップボード**(`src/chat/clipboard.ts`): Windows は PowerShell の `Set-Clipboard`(一時フォルダに UTF-8 のファイルを書いて読ませ、
  終わったら消す。結果に DB の値が入るため)、macOS は `pbcopy`、Linux は `xclip`。`--no-clip` で使わない
- **Chrome / Edge**(`export` の PDF と画面キャプチャ。`src/export/browser.ts`): PC にある Chrome / Edge(`--browser` か `ASHIATO_BROWSER` で指定も可)を、
  ヘッドレス・使い捨てのプロファイル(終わったら消す)・拡張機能と同期とバックグラウンド通信の無効化・localhost 以外へは届かない設定
  (存在しないプロキシと、名前解決の無効化)で起動する。操作はパイプ(`--remote-debugging-pipe`)で行い、ポートは開かない
- **Playwright のブラウザ**(`pack` / `verify --auto` / `--login`、0.3.0 予定): Playwright の Chromium があればそれ、無ければ PC の Chrome / Edge。
  `--cdp` を付けたときは、起動中のブラウザ(リモートデバッグを有効にして起動した WebView2 アプリなど)に接続する

## 8. 書き込むファイル

| ファイル | 書くコマンド | 中身 |
|---|---|---|
| `.ashiato/sessions/*.json`(と隣の `.replay.ndjson`・`.video-<n>.webm`) | `record`・`mcp`・`verify --save-session` | 変わった行の値。画面リプレイ(入力値を含み得る。パスワード欄は伏せる)・画面録画 |
| `docs/db/schema.md` | `schema` | テーブル定義(値なし。`--data` のときは §5.1 の値を含む) |
| `--out` で指定した先 | `query`・`verify`・`schema` | 結果(`query` / `verify` は値を含む) |
| 記録の隣の `.xlsx` / `.pdf` / `.html` | `export` | 変わった行の値・画面キャプチャ |
| `.spec.ts` | `codegen`・`export-tests` | テストのコード。記録の値を含み得る(パスワード・トークンらしい列は値を書き写さない) |
| `docs/ashiato/pack.md` | `pack` | 画面の構成(値は `…`) |
| `.ashiato/login.json` | `--login` | ログインの Cookie |
| `.ashiato/verify/*.md` | MCP の `verify_auto` | 照合の結果(値を含む) |

`.ashiato/` は `.gitignore` に入れてください。ほかに書くのは一時フォルダ(クリップボード用のファイル・ブラウザのプロファイル)だけで、使い終わったら消します。

## 9. まだ無いもの・制限

- **テスト DB の許可リスト**: 許可していない接続先では止まる仕組みは、まだありません。今の守りは「読み取りだけ実行する」ことと「参照専用のユーザー」です
- **記録サーバーの認証**: 127.0.0.1 の画面に認証はありません(§3)
- **`verify --auto` の「開く:」**: `--app` 以外のサイトも開けます(§5.3)
- 共有の開発 DB では、同じ時間帯に他の人が行った変更も記録・照合に入ります
- **`schema --data` の隠す列**(0.3.0 予定): 列名とコメントの語で決めます。名前から分からない列(`COL01` に氏名を入れているなど)は、区分・範囲・見本に値が出ます。
  書いた `docs/db/schema.md` を読んでから渡し、足りなければ `docs/db/data-rules.json` の `hide` に足してください(コマンドの終わりに隠した列の数と、この確認の案内を出します)
- **`schema --data` の負荷**: テーブルごとに集計の SELECT を数本送ります。100 万行を超えるテーブルは先頭 10 万行だけを読みますが、件数は全件を数えます。本番の DB には使わないでください
