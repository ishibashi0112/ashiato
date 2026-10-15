# AIチャットから E2E テストを作る(構想メモ)

> 2026-10-15、「作るもの探し」プロジェクトでの検討から ashiato に引き継いだもの。ロードマップの 7。

## ねらい

AIエージェントが使えない環境でも、チャット(Microsoft 365 Copilot Chat など)にアプリの全体像を見せて意図を読み取らせ、E2E テストを**チャットに書かせて、手元で実行し、直し、Playwright のテストとして残す**ところまでを、人がファイルを運ぶだけで回せるようにする。

既存の `schema` / `query` / `verify`(AIチャット向け)の延長。`verify` は今、チャットが書いた手順を**人がなぞって**DBの変化を照合する。この段階では、なぞる役を Playwright に置き換え、チャットに渡す材料をそろえる。

## 調べたこと(2026-10 時点の E2E ツール)

- Playwright 自身に AI 対応が入った:公式 MCP サーバー、v1.56 からの Test Agents(計画 → 生成 → 修復)
- 実行時に AI が操作するもの(Stagehand の `act()`、Midscene の画像認識)は便利だが、成功率は 8〜9 割台とされ、実行のたびに LLM を呼ぶ
- テストを書かない方向(Meticulous:実ユーザーの操作から回帰テスト、Shiplight:コーディング AI の確認操作をテストとして保存)
- どれも画面で完結し、**DB の変化は見ない**。多くはクラウド前提で、チャットしか使えない現場に合うものはなかった

## 今あるもの(流用する)

| 部品 | 場所 | この段階での役割 |
|---|---|---|
| `ashiato verify` と `*.verify.md` の形式 | `src/chat/verify.ts`, `verifyFile.ts` | チャットが書く手順ファイル。そのまま使う |
| `ashiato schema` | `src/chat/schema.ts` | 材料の一部(テーブル定義) |
| 記録セッション(操作 → 通信 → DB 変化) | `src/core`, `.ashiato/sessions` | 画面 → テーブルの対応表の元 |
| `expectDbChanges()`・変更が落ち着くのを待つ watcher | `src/playwright`, `src/testing` | 自動実行時の DB 照合 |
| 記録からのテスト生成 | `src/codegen/playwright.ts` | `.spec.ts` の書き出し |
| MCP サーバー | `src/agent` | エージェントがある環境向けの入口 |

## 作るもの

### 1. `ashiato pack`(仮):チャットに渡す材料を 1 ファイルに

```sh
npx ashiato pack --db <url> --app http://localhost:5173 [--pages /orders,/orders/new] [--max-chars 100000] [--out docs/ashiato/pack.md]
```

入れるもの(上から優先。`--max-chars` を超えたら下から削る):

1. **チャットへの指示文**:出力は `verify.md` 形式、手順の書き方(下記の操作行)、値は材料にある実在のものから選ぶ、分からないことは推測せず「確認したいこと」に書く
2. **画面一覧と各画面のアクセシビリティ木**:dev サーバーを Playwright で巡回し、`ariaSnapshot` を取る。ボタン名・項目のラベルがテキストで入るので、チャットが押すもの・入れる欄を正しい名前で書ける。これが一番効く部分(repomix のコードだけだと、画面に何があるかを推測で書いて外す)
3. **画面 → 通信 → テーブルの対応表**:記録済みセッションから集計。「受注画面の『登録』→ `POST /api/orders` → ORDERS +1 行、STOCK 更新」。記録がない画面は空欄で、チャットに推測させるか、先に `ashiato record` で一周する
4. **テーブル定義**:`schema` と同じ内容
5. **既存テストの一覧**:`tests/**/*.spec.ts` のタイトルだけ(重複を避ける)
6. repomix などのコードは**任意**で後ろに結合(`--code repomix-output.xml`)。残りの文字数に入る分だけ

テストに使える既存データ(「未出荷で在庫不足の注文」など)は、`query` で別に取ってチャットに貼る。pack には行の値を入れない(既存の方針どおり)。

ログインが要るアプリ:`ashiato record` 中、または `pack --login` で一度人が操作して Playwright の `storageState` を保存し、巡回と自動実行で使う。

### 2. `ashiato verify --auto`:手順を Playwright が実行する

`verify.md` の各手順に、自由文の「すること」に加えて機械が実行できる**操作行**を書いてもらう:

```md
## 1. 受注を登録する
受注画面で得意先 C001・品目 A001・数量 3 を入れて「登録」を押す

操作:
- 開く: /orders/new
- 選ぶ: 得意先 = C001
- 入力: 品目 = A001
- 入力: 数量 = 3
- 押す: 登録
- 確認: 「登録しました」が表示される

期待する DB の変化:
- ORDERS: 追加 1 行 (CUSTOMER_CODE=C001, STATUS=10)
- STOCK: 更新 1 行 (ITEM_CODE=A001) → (QTY-=3, UPD_DATE=*)
- ほかの表: 変化なし
```

- 語彙は少数に絞る:開く・入力・選ぶ・チェック・押す・待つ・確認(英語も同じ語彙:`open` / `fill` / `select` / `check` / `click` / `wait` / `expect`)。`期待する DB の変化:` / `Expected changes:` と同じ二言語対応
- 名前はアクセシビリティ木にあるラベルとボタン名をそのまま使う → `getByLabel` / `getByRole("button", { name })` に機械的に変換できる。CSS や XPath は書かせない。見つからないときは似た名前の候補を結果に出す
- `操作:` がある手順は自動、ない手順は今までどおり人に任せる(混在可)。Web 画面は自動、WinForms やバッチは人、という分担が同じファイルでできる
- 操作のあとは既存の watcher で DB の変化が落ち着くのを待ってから照合する(`expectDbChanges` と同じ)
- 結果は今の `verify` と同じ Markdown に、NG の手順ごとに「見つからなかった要素と候補 / 期待した画面の文言と実際のアクセシビリティ木(該当部分)/ 期待した DB の変化と実際の差分」を加える。チャットに貼れば、どの行をどう直すかが分かる形にする(`problems` と同じ流儀)
- 結果にはデータが入る:既存の `verify` と同じ注意書き(テスト用 DB で使う)

### 3. `ashiato export-tests`(仮):安定した手順を Playwright のテストに

```sh
npx ashiato export-tests checks/ --out tests/e2e/
```

`verify.md` の操作行と期待する DB の変化を `.spec.ts` にする(`src/codegen/playwright.ts` の生成を流用、`expectDbChanges` 付き)。以後は普通の Playwright テストとして CI で回る。`verify.md` を正にして生成し直すか、`.spec.ts` を正にして手で育てるかは使う側が選ぶ。

## 往復の流れ

```
$ ashiato pack --db <url> --app http://localhost:5173
  → チャットに貼る:「このアプリの意図を読み取り、主要なユースケースの検証手順を verify.md 形式で書いて」
  → チャットの出力を checks/*.verify.md に保存
$ ashiato verify checks/ --db <url> --auto --app http://localhost:5173
  → 結果(クリップボード)をチャットに貼る → 直した verify.md を保存 → もう一度(2〜3 周)
$ ashiato export-tests checks/ --out tests/e2e/
```

## 決めごと(提案)

- **チャットにはコードを書かせない。** Copilot チャットは実行できないので、生成コードのデバッグ往復が一番時間を食う。手順データなら ashiato 側で検証でき、誤りを「何行目をどう直すか」で返せる
- **ファイル往復を正にし、MCP はその上に乗せる。** エージェント(Claude Code など)がある環境では `pack` と `verify --auto` を MCP ツール(`src/agent/tools.ts`)として公開し、エージェントが自分で往復する。値を返す扱いは既存の `--share-values` に従う
- 本番 DB では使わない前提は既存どおり

## 段階

- 7a. `pack`:画面のアクセシビリティ木 + 画面 → テーブル対応 + テーブル定義 + 指示文
- 7b. `verify --auto`:操作行の実行、NG の画面差分、`storageState`
- 7c. `export-tests`
- 検証:`test/vite.e2e.test.ts` のサンプルアプリで pack → チャット(Claude で可)→ `verify --auto` を 1 周回し、AI がどこで外すかを見てから指示文と語彙を直す

## 未決

- 画面一覧の取り方:リンクをたどる巡回を先に作り、`--pages` で明示もできるようにする。ルート定義(react-router など)の静的解析は後回し
- pack が `--max-chars` に収まらないとき:画面ごとに分けて複数回貼る案内を出す
- `操作:` の `確認:` で見る対象:テキストの有無のほかに、表の行数や入力欄の値まで要るか
- 同じ `verify.md` を人がなぞるときの `操作:` の扱い:表示するだけ(人への案内文としてそのまま読める形にしておく)
