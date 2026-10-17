# e2e × ashiato 試行(手元の PC で回す手順)

tester-army/e2e の `agent.act`(自然文の手順を AI が実行)と ashiato の `watchDb`(DB の変化を SELECT だけで照合)を同じテストで使う試行です。
モデルなしの手順(ロケーター)はクラウド環境で通ることを確認済み。モデルありの手順を手元の PC で確かめます。

## 要るもの
- Node.js 24.8 以降(22 なら 22.22.3 以降)。e2e がそれ未満では起動しません
- Ollama と、ツール呼び出しに対応したモデル。e2e は画面を「役割・名前・テキスト」の文字列にして渡すので、画像対応は必須ではありません
  - まず `ollama pull qwen3:4b`(約 2.5GB、文字のみ)。足りなければ `qwen3-vl:4b`(約 3GB)か `qwen3:8b`(約 5GB)

## 手順
```sh
cd trial
npm install            # e2e, @e2e-dev/web, ai, @ai-sdk/openai-compatible, vite, ashiato
npx playwright install chromium   # @e2e-dev/web が使う playwright-core 1.63 用(初回のみ)

node server.mjs        # サンプルアプリ http://127.0.0.1:3000 と SQLite(./app.db)。別ターミナルで

# モデルなし(動作確認)
npx e2e run tests/orders.e2e.ts --grep 'ロケーター' --no-cache

# モデルあり
LLM_MODEL=qwen3:4b npx e2e run tests/orders.e2e.ts --grep 'agent' --no-cache --debug
```
Windows の PowerShell では `$env:LLM_MODEL="qwen3:4b"; npx e2e run ...`。

環境変数: `LLM_URL`(既定 `http://127.0.0.1:11434/v1`)、`LLM_MODEL`(既定 `qwen3-vl:4b`)、`APP_URL`、`APP_DB`。
テレメトリを切るなら `E2E_TELEMETRY_DISABLED=1`。

## 見るところ
- `--debug` の最後に出る手順ごとの表:モデル呼び出しの回数と時間
- `.e2e/results/<test>/trace.md`:モデルが見た画面と選んだ操作
- 2 回目は `--no-cache` を外すと、通った手順はモデルなしで再生される
