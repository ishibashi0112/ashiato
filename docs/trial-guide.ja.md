# 社内環境での試用手順(SQL Server / Oracle)

社内の SQL Server / Oracle と実際のアプリで ashiato を動かし、業務で使えるかを確かめるための手順です。社内ネットワークの PC で、上から順に進めてください。最後に、結果を報告するための書式があります。

> **データの扱い**
> ashiato が読んだ行の値、画面リプレイ、画面録画は、すべてこの PC の中(セッションファイルと同じフォルダー)に保存され、外部には送られません。レコーダーは `127.0.0.1` でだけ待ち受けるので、ほかの PC からも見えません。
> 結果を報告するときも、行の値・接続 URL・パスワード・セッションファイル・録画は貼らないでください([8. 結果の報告](#8-結果の報告))。

## 目次

1. [事前に確認しておくこと](#1-事前に確認しておくこと)
2. [ashiato を用意する](#2-ashiato-を用意する)
3. [DB への接続を確かめる](#3-db-への接続を確かめる)
4. [手動チェックポイントで記録する(どのアプリでも)](#4-手動チェックポイントで記録するどのアプリでも)
5. [Vite の画面・WebView2 アプリで自動記録する](#5-vite-の画面webview2-アプリで自動記録する)
6. [確認項目](#6-確認項目)
7. [困ったとき](#7-困ったとき)
8. [結果の報告](#8-結果の報告)

コマンドの例は Windows の PowerShell です。

---

## 1. 事前に確認しておくこと

試用日の前に確認・依頼しておくと、当日止まらずに進められます。

### PC

- [ ] **Node.js 22.5 以上**(`node -v` で確認)。古い場合は Node.js 22 LTS を入れてください。管理者権限がなければ、zip 版を展開して PATH に追加する方法でも動きます
- [ ] `npm install` で、社内から npm のパッケージ(`mssql`、`oracledb`)を取得できる。普段アプリ開発で使っている npm の設定(プロキシや社内レジストリ)のままで構いません
- [ ] 画面録画に使う **Microsoft Edge か Google Chrome**。社内のポリシーで画面共有が禁止されていると、録画はできません

### DB

- [ ] 使うのは **開発用・検証用の DB** にします(本番 DB では使わないでください)。記録を始めるときに監視するテーブルを全件読みます。その後もチェックポイントのたびに、DB の中で監視するテーブルの全行のチェックサムを計算します(手元に送られてくるのは変わった部分だけです)。監視するテーブルが大きいほど、DB に読み取りの負荷がかかります
- [ ] **参照(SELECT)だけの専用ユーザー**を用意します。既存の参照専用アカウントがあれば、それで構いません。なければ DBA に次のように依頼します

  SQL Server:

  ```sql
  -- SQL Server 認証のログイン(Windows 認証は未対応です。下の「注」を参照)
  CREATE LOGIN ashiato_ro WITH PASSWORD = '********';
  USE SalesDev;  -- 対象の DB
  CREATE USER ashiato_ro FOR LOGIN ashiato_ro;
  -- 対象のテーブルだけ読めるようにする場合
  GRANT SELECT ON dbo.Orders TO ashiato_ro;
  GRANT SELECT ON dbo.OrderDetails TO ashiato_ro;
  GRANT SELECT ON dbo.Stock TO ashiato_ro;
  -- DB のテーブルをすべて読めるようにする場合は、代わりにこちら
  -- ALTER ROLE db_datareader ADD MEMBER ashiato_ro;
  ```

  Oracle:

  ```sql
  CREATE USER ashiato_ro IDENTIFIED BY "********";
  GRANT CREATE SESSION TO ashiato_ro;
  -- 対象のテーブルごとに
  GRANT SELECT ON APP_OWNER.ORDERS TO ashiato_ro;
  GRANT SELECT ON APP_OWNER.STOCK TO ashiato_ro;
  ```

  ashiato が使うのは `SELECT` だけです。トリガーの作成、CDC、DB の設定変更は不要で、依頼する必要もありません。

- [ ] **接続情報**を控えておきます
  - SQL Server: ホスト名、ポート番号(既定は 1433)、名前付きインスタンスならインスタンス名、DB 名
  - Oracle: ホスト名、ポート番号(既定は 1521)、**サービス名**(tnsnames.ora の `SERVICE_NAME`。SID ではありません)、テーブルの**所有者(スキーマ)名**
- [ ] **DB のバージョン**を確認します
  - SQL Server: 2016 以降なら、変わった部分だけを読み直す高速な読み込みが使えます(`geography` / `geometry` / `hierarchyid` 型の列があり `rowversion` 列のないテーブルは除く)。2014 以前でも動きますが、`rowversion` 列のないテーブルは毎回全件読みます
  - Oracle: **12.1 以降**が必要です。11g 以前には接続できません

> **注:SQL Server の認証方式**
> 今の ashiato は、SQL Server には **SQL Server 認証**(ユーザー名とパスワード)でしか接続できません。Windows 認証しか許可されていない場合は接続できないので、試用の前に知らせてください。ドメインのアカウントとパスワードで接続する方式(NTLM)なら追加できます。

> **注:Oracle の接続方式**
> Oracle には Thin モード(Oracle Instant Client のインストールが不要な方式)で接続します。DB 側でネットワーク暗号化(Native Network Encryption)が必須になっている場合や、古い方式(10G)のパスワードのアカウントでは接続できません。そのときのエラーと対処は [7. 困ったとき](#7-困ったとき) にあります。

### アプリ

- [ ] 試すアプリの種類を確認します
  - **Vite で作った画面**(ブラウザで動く画面、または WebView2 で表示する WinForms / WPF アプリ):[5 章](#5-vite-の画面webview2-アプリで自動記録する)の自動記録と画面リプレイまで試せます。Vite 5 以降が必要です
  - **それ以外のアプリ**:[4 章](#4-手動チェックポイントで記録するどのアプリでも)の手動チェックポイントと画面録画で試します
- [ ] WebView2 アプリなら、画面から C# 側への呼び出し方を確認します。フロントエンドのソースで `chrome.webview.postMessage(` を検索し、送っている内容が次の形かを見てください(JSON-RPC 形式。webview2-bridge もこの形です)

  ```js
  // 画面 → C#(オブジェクトでも、JSON.stringify した文字列でも構いません)
  window.chrome.webview.postMessage({ id: 1, method: "orders.save", params: { ... } });
  // C# → 画面の返信は、同じ id を付けた { id: 1, result: ... } か { id: 1, error: ... }(method は付けない)
  ```

  - `id` のない `{ method, params }` は返信を待たない呼び出しとして扱い、送ってから 0.5 秒待ってチェックポイントを取ります。C# 側の処理がそれより長くかかる場合は、プラグインの `oneWayMs` で待ち時間を延ばせます([5 章](#5-vite-の画面webview2-アプリで自動記録する))
  - `method` を持たない形(例:`{ type: "save", data: ... }`)や、`chrome.webview.hostObjects` を使った呼び出しは、今は自動記録の対象外です。その場合も 4 章の手動記録は使えます。実際の形(値は伏せて構いません)を知らせてもらえれば、対応を追加します

---

## 2. ashiato を用意する

ashiato はまだ npm に公開していないので、パッケージファイル `ashiato-0.1.0.tgz` からインストールします。

### 2-1. パッケージファイルを手に入れる

次のどちらかで `ashiato-0.1.0.tgz` を用意します。

- **持ち込む**:社外で作った(または共有された)`ashiato-0.1.0.tgz` を、社内のルールに沿ってこの PC にコピーします
- **社内でビルドする**:社内から GitHub に接続できる場合は、ソースから作れます(pnpm を入れていなくても、`npx` 経由で動きます)

  ```powershell
  git clone https://github.com/ishibashi0112/ashiato.git
  cd ashiato
  npx -y pnpm@10.28.0 install
  npx -y pnpm@10.28.0 build
  git rev-parse --short HEAD   # 報告用に、ビルドしたコミットを控えておく
  cd packages\ashiato
  npm pack                     # このフォルダーに ashiato-0.1.0.tgz ができます
  ```

### 2-2. 作業フォルダーにインストールする

アプリとは別の作業フォルダーを作り、ashiato と DB のドライバーを入れます。アプリ本体には手を入れません(5 章で自動記録を試すときだけ、アプリにも入れます)。

```powershell
mkdir C:\ashiato-trial
cd C:\ashiato-trial
npm init -y
npm install -D C:\path\to\ashiato-0.1.0.tgz mssql oracledb   # 使う DB のドライバーだけでも構いません
npx ashiato --help
```

`ashiato — record what your app changes in the database` から始まる説明(`Usage:` を含む)が表示されれば準備完了です。

> PowerShell で「このシステムではスクリプトの実行が無効になっている」と出て `npx` が動かない場合は、`npx` の代わりに `npx.cmd` と入力するか、コマンドプロンプト(cmd)で実行してください。

---

## 3. DB への接続を確かめる

### 3-1. 接続 URL を作る

| DB | 接続 URL の例 |
| --- | --- |
| SQL Server | `mssql://ashiato_ro:パスワード@db-dev01:1433/SalesDev` |
| SQL Server(名前付きインスタンス) | `mssql://ashiato_ro:パスワード@db-dev01/SalesDev?instance=DEV` |
| SQL Server(通信の暗号化が必須の場合) | `mssql://ashiato_ro:パスワード@db-dev01:1433/SalesDev?encrypt=true` |
| Oracle | `oracle://ashiato_ro:パスワード@ora-dev01:1521/DEVPDB?schema=APP_OWNER` |

- パスワードなどに記号が入っているときは、URL 用の書き方に置き換えます。例:`p@ss#1` → `p%40ss%231`

  | 記号 | `@` | `:` | `/` | `#` | `?` | `&` | `%` | 空白 |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 置き換え | `%40` | `%3A` | `%2F` | `%23` | `%3F` | `%26` | `%25` | `%20` |

- **SQL Server の名前付きインスタンス**:`?instance=` を付けると、SQL Server Browser(UDP 1434)に問い合わせてポート番号を調べます(このとき URL のポート番号は使われません)。インスタンスのポート番号が分かっているなら、`?instance=` を付けずに `ホスト:ポート` で指定する方が確実です
- **SQL Server の暗号化**:`encrypt=true` のとき、サーバー証明書は検証しません(社内の自己署名証明書でもつながります)
- **Oracle**:`/` の後ろは**サービス名**です。`?schema=` には**テーブルの所有者**を指定します。付けないと、ログインしたユーザー自身のスキーマを見に行くので、参照専用ユーザーではテーブルが 0 件になります
- 1 回の記録で対象にできるのは、SQL Server は 1 つの DB(その中のすべてのスキーマ)、Oracle は 1 つのスキーマです

URL を毎回入力しなくて済むように、環境変数 `ASHIATO_DB_URL` に入れておきます。`--db` を省くと、この値が使われます。PowerShell では `'` で囲むと、`&` や `%` などの記号がそのまま渡ります。PowerShell の画面を閉じると消えます。

```powershell
$env:ASHIATO_DB_URL = 'mssql://ashiato_ro:p%40ss%231@db-dev01:1433/SalesDev'
```

コマンドプロンプトの場合は、全体を `"` で囲みます:`set "ASHIATO_DB_URL=mssql://..."`

### 3-2. テーブルの一覧を出す

```powershell
npx ashiato tables
```

```
dbo.OrderDetails                               5678 rows  key: OrderId, LineNo
dbo.Orders                                     1234 rows  key: OrderId
dbo.WorkLog                                     100 rows  key: (none)
```

確認すること:

- 試したい画面が使うテーブルが一覧にある。ない場合は、SELECT 権限と(Oracle なら)`?schema=` を確認します
- **行数**:10 万行を超えるテーブルは、既定では監視の対象から外れます(`--max-rows` で変えられます)
- **`key: (none)`**:主キーのないテーブルです。比較はできますが、更新が「削除+追加」として表示されます

> このコマンドはすべてのテーブルの行数を数えるので、テーブルが非常に多い DB では時間がかかることがあります。

---

## 4. 手動チェックポイントで記録する(どのアプリでも)

画面で 1 つ操作するたびに、自分で区切り(チェックポイント)を打つ方法です。WinForms、WPF、Web など、どのアプリでも使えます。

### 4-1. 記録を始める

`--tables` に、試したい画面が使うテーブルを指定します(最初は数テーブルから始めるのがおすすめです)。更新日時や更新者のように、操作のたびに必ず変わる列は `--ignore-columns` で比較から外すと、本当の変更だけが見やすくなります。

```powershell
cd C:\ashiato-trial
npx ashiato record --tables "dbo.Orders,dbo.OrderDetails,dbo.Stock" --ignore-columns "UpdatedAt,UpdatedBy"
```

- **カンマ区切りの値は必ず `"` で囲んでください。** PowerShell で囲まずに書くと、`npx` を通したときにカンマが空白に変わり、正しく渡りません
- テーブル名は `npx ashiato tables` の表示どおりに書きます(`Orders` のように名前だけでも構いません。大文字と小文字は区別しません)
- `--ignore-columns` は、監視するすべてのテーブルに共通の列名です
- 監視するテーブルは、記録を始めたときに決まります。記録を始めたあとに作られたテーブル(アプリが実行中に作る作業用テーブルなど)は監視されません

起動すると、次のように表示されます。

```
Watching 3 table(s) on mssql. Baseline snapshot taken.
Timeline: http://127.0.0.1:4100
Press Enter for a checkpoint (optionally type a label first). Ctrl+C to stop.
```

この間に `skipped ...` や `... is read in full at each checkpoint (...)` という行が出たら、内容を控えておいてください(報告に使います)。

### 4-2. タイムラインを開き、画面録画を始める

1. Edge か Chrome で <http://127.0.0.1:4100> を開きます
2. **● Record screen** を押し、試すアプリのウィンドウ(または画面全体)を選んで共有します
   - 録画は 1 秒ごとに PC 内のレコーダーへ保存されます。外部には送られません
   - 録画中はタイムラインのタブを閉じないでください。止めるときは **■ Stop recording** を押します

### 4-3. 操作して、操作ごとに区切る

1. アプリで 1 つ操作します(例:受注を入力して「保存」を押す)
2. ターミナルにラベル(例:`受注登録`)を入力して **Enter** を押します。ラベルを入れずに Enter だけでも構いません。タイムラインの **Checkpoint** ボタンでも同じことができます
3. その操作で変わった行が、ターミナルとタイムラインに表示されます

   ```
   #1 受注登録  (+1 ~1 -0, 85ms)
     dbo.Orders
       + OrderId=1042
     dbo.Stock
       ~ ItemId=3  Qty: 50 → 40
   ```

   `+` は追加、`~` は更新(変わった列の「前 → 後」)、`-` は削除です。括弧の中の最後の数字(この例では `85ms`)は、そのチェックポイントの読み込みにかかった時間です。

4. 変わるはずの行が、期待どおりに変わっているかを確認します。これを操作ごとに繰り返します

タイムラインでステップを選ぶと、変わった行の一覧と、そのときの録画が表示されます。手動のチェックポイントでは、録画は Enter を押した時刻に移動します。操作そのものを見るときは、録画の再生バーで少し巻き戻してください。

> 区切りと区切りの間に、ほかの人やバッチが同じテーブルを変更した場合は、その変更も同じステップに含まれます(手動記録では区別できません)。

### 4-4. 終える・見返す

- ターミナルで **Ctrl+C** を押すと終了します。「バッチ ジョブを終了しますか (Y/N)?」と出たら `Y` を押します。セッションは区切るたびに保存されているので、途中で止まっても記録は残ります
- 保存先は、作業フォルダーの `.ashiato\sessions\` です。`<開始日時>.json` がセッション、`<開始日時>.video-1.webm` などが録画、`<開始日時>.replay.ndjson` が画面リプレイ(5 章)です。開始日時は UTC(日本時間の 9 時間前)で、例えば日本時間 10:23 に始めると `2026-10-11T01-23-45-678Z.json` のようになります
- 見返すときは、レコーダーを止めてから次のコマンドを実行し、<http://127.0.0.1:4100> を開きます(記録中に見返すなら `--port 4101` を付けます)

  ```powershell
  npx ashiato show .ashiato\sessions\<ファイル名>.json
  ```

---

## 5. Vite の画面・WebView2 アプリで自動記録する

Vite で作った画面なら、ボタンのクリックなど通信を伴う操作ごとに、自動で区切りが入ります(操作の前と後に 1 回ずつチェックポイントを取ります)。ステップには、押したボタンと送った通信(fetch / XHR の URL、WebView2 の `postMessage` の `method`)が表示されます。操作の前後の画面を再生する画面リプレイも使えます。

### 5-1. アプリに ashiato を入れる(試用用のブランチで)

アプリのフロントエンドのフォルダー(`vite.config.ts` があるフォルダー)で実行します。

```powershell
git switch -c try-ashiato                     # 試用用のブランチ
npm install -D C:\path\to\ashiato-0.1.0.tgz   # yarn / pnpm のアプリは、それぞれの add コマンドで
```

`vite.config.ts`(または `vite.config.js`)にプラグインを追加します。

```ts
import ashiato from "ashiato/vite";

export default defineConfig({
  plugins: [react(), ashiato()], // 開発サーバーのときだけ動き、本番ビルドには入りません
});
```

- `package.json` に PC 上のファイルへの参照が入るので、このブランチは push やマージをしないでください
- DB のドライバーは、アプリ側には不要です(レコーダーは 2 章の作業フォルダーで動かします)

### 5-2. 起動する

次の順番で起動すると確実です。

1. 作業フォルダーで、[4-1](#4-1-記録を始める) と同じようにレコーダーを起動します
2. アプリのフロントエンドで、Vite の開発サーバーを起動します(`npm run dev` など)
3. 画面を開きます
   - ブラウザで動く画面:開発サーバーの URL(例:<http://localhost:5173>)を開きます
   - WebView2 アプリ:**Vite の開発サーバーの URL を読み込む設定**でアプリを起動します。ビルド済みのファイル(`dist`)を読み込む設定のままでは、ashiato は入りません
4. タイムライン <http://127.0.0.1:4100> を Edge か Chrome で開き、必要なら **● Record screen** で録画も始めます(WebView2 アプリなら、そのウィンドウを選びます)

### 5-3. ashiato が入ったことを確かめる

画面の開発者ツールを開き(ブラウザは F12。WebView2 は F12 か、右クリックのメニューから)、コンソールで次を入力します。

```js
window.__ashiatoInstalled   // true と出れば入っています
```

WebView2 アプリでは、続けて次も確認します。

```js
String(window.chrome.webview.postMessage).includes("[native code]")   // false と出れば、postMessage を追跡しています
```

- コンソールに `[ashiato] recorder not reachable` と出る場合は、レコーダーが起動していないか、ポート番号が違います
- アプリの設定で WebView2 の開発者ツールが無効になっている場合は、この確認は飛ばして、次の 5-4 の結果で判断します

### 5-4. 操作して確かめる

- 保存などの操作をすると、少しあとにステップが自動で追加されます。ステップの名前は操作(例:`#3 click button "保存"`)で、その下に送った通信(postMessage なら `method` の `orders.save`、fetch / XHR なら `POST /api/orders` のようにメソッドとパス)が表示されます
- 1 回の操作が 1 つのステップになっているか、変わった行が正しいかを確認します
- **`outside actions`** というステップは、操作と関係なく変わった行です(ほかの人、バッチ、アプリの定期処理による変更)
- **自分の操作による変更が `outside actions` や別のステップに入ってしまう場合**は、次のどちらかです。どの操作で起きたかを報告してください
  - その操作の通信を ashiato が追跡できていない(postMessage の形が違う、など)
  - 操作の前のチェックポイントが 5 秒以内に終わらなかった。このときは通信を先に送るので、変更が前のステップに入ることがあります。`--tables` を絞るか、プラグインの `syncTimeoutMs` を延ばします
- 通信を伴わないクリックはステップになりません。fetch / XHR の GET だけの操作(検索など)も、何も変わらなければステップになりません。postMessage を送った操作は、何も変わらなくても「変更なし」のステップになります。左上の **Hide steps without changes** で隠せます
- ステップを選ぶと、**Screen** 欄にそのときの画面が表示されます。**▶ Play this action** で、操作の直前からチェックポイントまでを再生します

プラグインの設定でよく使うもの:

| 設定 | 使う場面 |
| --- | --- |
| `ashiato({ replay: { maskAllInputs: true } })` | 入力した値を画面リプレイに残したくないとき(パスワード欄は設定しなくても常に伏せ字です) |
| `ashiato({ recorder: "http://127.0.0.1:4101" })` | レコーダーを `--port 4101` で起動したとき |
| `ashiato({ ignore: ["/api/poll"] })` | 定期的に通信する URL(ポーリング)があるとき。その通信のたびにチェックポイントを取らなくなるので、ステップがなかなか追加されない問題と、DB の負荷の両方が減ります |
| `ashiato({ oneWayMs: 2000 })` | `id` のない postMessage のあと、C# 側の処理が 0.5 秒で終わらないとき |
| `ashiato({ syncTimeoutMs: 15000 })` | 操作の前のチェックポイントが 5 秒を超え、変更が前のステップに入ってしまうとき(その分、通信が待たされます) |

---

## 6. 確認項目

試用では、次の項目を確かめてください。番号は報告のときに使います。

| # | 確認すること | 見るところ |
| --- | --- | --- |
| 1 | 参照専用ユーザーで接続できる | `npx ashiato tables` がテーブルの一覧を出す |
| 2 | 追加・更新・削除が正しく出る | 操作で変わるはずの行と、ステップの `+` `~` `-` を見比べる |
| 3 | 数値が正確 | 桁の多い金額や ID(SQL Server の `decimal` / `numeric` / `money`、Oracle の `NUMBER`)が丸められていない |
| 4 | 日付・時刻が正確 | 秒以下の桁まで合っている(注 1) |
| 5 | 日本語が文字化けしない | 漢字、半角カナ、記号を含む列 |
| 6 | 主キーのないテーブル | 更新が「削除+追加」として出る(仕様どおり) |
| 7 | 読み込みの速さ | ステップの所要時間(`ms`)。何も変わらない操作のとき、ふつうの操作のとき、大きなテーブルを含むとき |
| 8 | 起動時のメッセージ | `skipped` や `read in full` が出たテーブルと、その理由 |
| 9 | 操作ごとに 1 ステップになる(5 章) | 1 回の保存が 1 つのステップ。自分の変更が `outside actions` に混ざらない |
| 10 | WebView2 の postMessage を追跡できる(5 章) | ステップの下に `method` の名前が出る |
| 11 | 画面録画 | 録画でき、ステップを選ぶとその時刻の画面に移る(5 章では Screen 欄の **Video** に切り替えて確認) |
| 12 | 画面リプレイ(5 章) | **▶ Play this action** で操作の前後が再生される |
| 13 | 操作外の変更を分けられる(5 章) | ほかの人やバッチの変更が `outside actions` として出る |
| 14 | 長時間の記録 | 30 分以上・数十ステップ記録しても遅くならない。タスク マネージャーで Node.js のメモリが増え続けない |
| 15 | アプリへの影響 | 記録中もアプリの操作感が変わらない(注 2) |

- 注 1:SQL Server の日時は、末尾に `Z` の付いた形(例:`2026-10-11T10:00:00.000Z`)で表示されますが、数字は DB に入っている値そのままです。`datetimeoffset` 型だけは、UTC に直した時刻で表示されます。`date` 型は `2026-10-11T00:00:00.000Z`、`time` 型は `1970-01-01T10:00:00.000Z` のように表示されます。Oracle の `DATE` / `TIMESTAMP` は、DB の値をそのまま文字にしたもの(例:`2026-10-11 10:00:00`)です
- 注 2:5 章の自動記録では、操作の最初の通信を送る直前に一度チェックポイントを取るため、その分だけ通信が待たされます(最大 5 秒)。遅く感じたら、ステップの所要時間と合わせて報告してください

---

## 7. 困ったとき

| 症状 | 原因と対処 |
| --- | --- |
| `npx` が「スクリプトの実行が無効」で動かない | PowerShell の実行ポリシーによるものです。`npx.cmd` と入力するか、コマンドプロンプトで実行します |
| `SQL Server support needs the "mssql" package` / `Oracle support needs the "oracledb" package` | 作業フォルダーにドライバーが入っていません。`npm install -D mssql`(Oracle は `oracledb`) |
| `Could not read the user name or password in the URL`、`Invalid URL`、または `getaddrinfo ENOTFOUND`(`NJS-530`)でホスト名にパスワードの一部が出る | パスワードなどの記号を置き換えていません([3-1](#3-1-接続-url-を作る))。エラーの文にパスワードの一部が出ていることがあるので、報告するときは伏せてください |
| `Login failed for user ...`(SQL Server) | ユーザー名かパスワードが違うか、SQL Server 認証が無効(Windows 認証のみ)です。Windows 認証のみの場合は報告してください |
| `Failed to connect ...`(SQL Server) | ホスト名、ポート番号、ファイアウォールを確認します |
| `Failed to get response from SQL Server Browser ...` / `Port for ... not found ...`(SQL Server) | `?instance=` でインスタンスのポート番号を調べられません。インスタンス名を確認するか、`?instance=` を外してポート番号で指定します |
| `Server requires encryption, set 'encrypt' config option to true.`(SQL Server) | URL に `?encrypt=true` を付けます |
| `Cannot open database "..." requested by the login`(SQL Server) | DB 名が違うか、その DB にユーザーが作られていません(`CREATE USER`) |
| TLS / SSL に関するエラー(SQL Server) | 古い SQL Server(TLS 1.2 に未対応のもの)で起きることがあります。エラーの全文を報告してください |
| `ORA-01017`(Oracle) | ユーザー名かパスワードが違います |
| `ORA-28001`(Oracle) | パスワードの期限が切れています。ashiato からは変更できないので、SQL*Plus などで変更するか、DBA に依頼します |
| `ORA-01045`(Oracle) | `CREATE SESSION` 権限がありません |
| `NJS-503` / `NJS-510` / `NJS-511`(Oracle) | DB に届いていません。ホスト名、ポート番号、ファイアウォールを確認します |
| `NJS-138`(Oracle) | DB が 11g 以前で、Thin モードでは接続できません。報告してください |
| `NJS-116`(Oracle) | アカウントのパスワードが古い方式(10G)です。DBA にパスワードを設定し直してもらうと解消することがあります。だめなら報告してください |
| `NJS-533`(Oracle。`Native Network Encryption ... only supported in node-oracledb thick mode`) | DB 側でネットワーク暗号化(またはチェックサム)が必須になっていて、Thin モードでは接続できません。報告してください |
| `NJS-518`(Oracle。`Service ... is not registered with the listener`) | サービス名が違います。tnsnames.ora の `SERVICE_NAME` を使います |
| `Tables not found: ...`(または `--tables` なしで `Watching 0 table(s)`) | `--tables` のテーブル名が違うか、そのテーブルの SELECT 権限がないか、Oracle で `?schema=` を付けていません。`npx ashiato tables` の表示どおりに書き、全体を `"` で囲みます |
| `npx ashiato tables` が途中でエラーになって止まる | 読めないテーブルが 1 つあると、一覧はそこで止まります。エラーの全文を報告し、`record` は `--tables` で読めるテーブルを指定して進めてください |
| `Port 4100 is already in use` | 別の ashiato(またはほかのソフト)が使っています。`--port 4101` などに変えます。5 章ではプラグインにも `recorder` を指定します |
| `skipped ... rows > --max-rows` | 10 万行を超えるテーブルです。必要なら `--max-rows 300000` のように上げます(行はメモリに持つので、様子を見ながら) |
| `... is read in full at each checkpoint (...)` | 高速な読み込みが使えないテーブルです。動きますが、毎回全件読むので遅くなります。括弧の中の理由を報告してください |
| ステップの所要時間が数秒以上かかる | `--tables` を絞ります。どのテーブルで遅いかを報告してください |
| 5 章でステップがまったく追加されない | `window.__ashiatoInstalled` を確認します。ビルド済みのファイルを読み込んでいないか、コンソールに `[ashiato]` で始まる警告が出ていないかを見ます |
| 5 章でステップがなかなか追加されない | 短い間隔で通信し続ける URL(ポーリング)があると、操作が終わったと判断できません。その URL をプラグインの `ignore` に指定します |
| **● Record screen** を押しても何も起きない(共有する画面を選ぶ画面が出ない) | 社内のポリシーで画面共有が禁止されている可能性があります。別のブラウザでも試し、だめなら報告してください |
| 5 章で、postMessage の操作のステップが 30 秒たってから追加され、`no reply after 30s` と出る | C# からの返信を ashiato が対応づけられていません。返信に送ったときと同じ `id` が入っているか、返信に `method` が入っていないかを確認してください |

---

## 8. 結果の報告

試用が終わったら、次の書式を埋めてプロジェクトに貼ってください。

- **行の値、接続 URL、パスワード、セッションファイル、録画は貼らないでください**
- テーブル名や列名も社外に出せない場合は、`テーブルA`、`列B` のように置き換えて構いません
- エラーの全文に社外秘の情報が含まれる場合は、その部分を伏せてください

```
## 試用結果
- 日付:
- ashiato のコミット(分かれば):
- Node.js のバージョン:
- DB:(例:SQL Server 2019 / Oracle 19c)
- アプリの種類と試した範囲:(例:WPF + WebView2 + Vite、5 章まで)
- 監視したテーブルの数 / いちばん大きいテーブルの行数:
- 起動時のメッセージ(skipped / read in full の行):
- チェックポイントの所要時間:変更なしのとき __ms、ふつうの操作 __ms、最大 __ms
- 確認項目(6 章)の結果:1 OK / 2 OK / 3 NG(内容)/ ...
- エラー(全文。社外秘の部分は伏せる):
- 使ってみて不便だった点・欲しい機能:
```

試用が終わったら、作業フォルダーの `.ashiato\sessions\`(DB の値と画面の録画が入っています)は、社内のデータと同じ扱いで保管するか、不要なら削除してください。
