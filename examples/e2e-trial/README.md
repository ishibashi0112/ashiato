# e2e × ashiato 試行(手元の PC で回す手順)

tester-army/e2e の `agent.act`(自然文の手順を AI が実行)と ashiato の `watchDb`(DB の変化を SELECT だけで照合)を同じテストで使う試行です。
結果は末尾に。結論は「ローカルの小さいモデルでは動くが遅く不安定。`verify --auto` の決め打ちの操作行を主にし、e2e は任意の出力形式の候補に留める」。

## 要るもの
- Node.js 24.8 以降(22 なら 22.22.3 以降)。e2e がそれ未満では起動しません
- Ollama と、ツール呼び出しに対応したモデル。e2e は画面を「役割・名前・テキスト」の文字列にして渡すので、画像対応は必須ではありません
  - まず `ollama pull qwen3:4b`(約 2.5GB、文字のみ)。足りなければ `qwen3:8b`(約 5GB)
- **Ollama の文脈長を広げる**:既定の 4096 トークンでは e2e の最初のプロンプト(指示 + ツール 23 個 + 画面、約 4400 トークン)が切れて、モデルが操作を返せません。`OLLAMA_CONTEXT_LENGTH=16384 ollama serve` で起動してください

## 手順
```sh
cd examples/e2e-trial
npm install            # e2e, @e2e-dev/web, ai, @ai-sdk/openai-compatible, vite, ashiato
npx playwright install chromium   # @e2e-dev/web が使う playwright-core 1.63 用(初回のみ)

OLLAMA_CONTEXT_LENGTH=16384 ollama serve   # 別ターミナルで
node server.mjs        # サンプルアプリ http://127.0.0.1:3000 と SQLite(./app.db)。別ターミナルで

export E2E_TELEMETRY_DISABLED=1 LLM_MODEL=qwen3:4b
npx e2e run tests/orders.e2e.ts --grep 'ロケーター' --no-cache      # モデルなし(動作確認)
npx e2e run tests/orders.e2e.ts --grep 'agent' --no-cache --debug  # モデルあり 2 本
npx e2e run tests/orders.e2e.ts --grep 'agent' --debug             # 記録を作る(--no-cache の回は記録しない)
npx e2e run tests/orders.e2e.ts --grep 'agent' --debug             # 再生: モデル呼び出し 0 回
```
Windows の PowerShell では `$env:LLM_MODEL="qwen3:4b"; npx e2e run ...`。

環境変数: `LLM_URL`(既定 `http://127.0.0.1:11434/v1`)、`LLM_MODEL`(既定 `qwen3-vl:4b`)、`APP_URL`、`APP_DB`。
各テストの前に `POST /api/reset` で DB を初期状態(在庫 3 = 50、4 = 20)に戻すので、順番や回数によらず期待値は同じです。

## 見るところ
- `--debug` の最後に出る手順ごとの表:モデル呼び出しの回数と時間
- `.e2e/results/<test>/trace.md`:モデルが見た画面と選んだ操作
- 2 回目以降、通った手順はモデルなしで再生される

## 結果(2026-10-17、MacBook Air / Apple M5 / 24GB、Ollama 0.40.5 + qwen3:4b、e2e 0.21.2)

| テスト | 結果 | モデル呼び出し | 時間 |
|---|---|---|---|
| 保存(ロケーター、モデルなし) | 合格 | 0 | 0.8 秒 |
| 保存(agent.act「「保存」ボタンを押す」) | 操作は 5 回とも正しい(当時の期待値の誤りで NG、修正済み) | 2 | 17〜30 秒 |
| 注文(agent.act「品目にナットを選び、数量に 5 を入れて「注文」ボタンを押す」) | 4 回中 2 回合格 | 1〜2 | 56〜120 秒 |
| 再生(2 回目以降) | 保存 合格 / 注文 合格 | 0 | 0.25 秒 / 0.37 秒(全体 6.5 秒) |

- 注文が失敗するとき:4B のモデルが「ナット」の選択肢(`option`)を直接タップして(セレクトの `select` を使わず)15 秒待ちで止まる。1 回は「成功」と報告したのに、実際は別の品目(ボルト、item 3)の在庫が 40→35 になっていた。**これを ashiato の DB 照合が捕まえて NG にした**
- 時間の内訳:1 回のモデル呼び出しが 8〜20 秒、注文の最初の呼び出しだけ 40〜95 秒(2〜3.5 千トークン考え込む)
- 文脈長 4096 のまま:最初の呼び出しが 103 秒かかって操作を返さず、両テストとも 120 秒で打ち切り
- 文言の変更:なし(指示が曖昧なのではなく、モデルが道具を選び違えた)
