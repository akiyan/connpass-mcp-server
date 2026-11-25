# Cloudflare Workers にデプロイする

`akiyan` ブランチでは、Workers に `POST /mcp`（Streamable HTTP、JSON 応答）と `GET /health` をデプロイできます。Node.js の stdio / HTTP とは別のエントリーポイントです。

## 準備

Node.js 22 以上と pnpm 10 を用意し、リポジトリのルートで実行します。

```bash
corepack pnpm@10.34.9 install --frozen-lockfile
corepack pnpm@10.34.9 build
corepack pnpm@10.34.9 --filter @kajidog/connpass-mcp-server worker:check
```

## 本番にデプロイ

1. `cd apps/mcp-server` で移動し、`corepack pnpm@10.34.9 exec wrangler login` で認証します。`wrangler whoami` でアカウントを確認してください。複数アカウントにアクセスできる場合は、対象の `CLOUDFLARE_ACCOUNT_ID` を指定します。CI では Workers のデプロイ権限に限定した API トークンを `CLOUDFLARE_API_TOKEN` に設定できます。
2. 初回は `.dev.vars.production` をローカルに作り、権限を `0600` にします。次の値は Git やチャットに貼らず、実際の値に置き換えてください。`MCP_API_KEY` は `openssl rand -hex 32` などで生成した、connpass のキーとは別の値です。

   ```dotenv
   CONNPASS_API_KEY=<connpass API のキー>
   MCP_API_KEY=<MCP クライアントに渡す専用のトークン>
   ```

3. アカウント内に `connpass-mcp-server` という別の Worker がないことを確認し、初回は secret を含めてデプロイします。公開先は `wrangler.jsonc` の名前やルート設定で変更できます。

   ```bash
   corepack pnpm@10.34.9 worker:deploy --secrets-file .dev.vars.production
   ```

   以降は `corepack pnpm@10.34.9 worker:deploy` で既存の secret を保持したまま更新できます。ローカルの本番 secret ファイルはデプロイ後に安全に取り扱ってください。キーのローテーションには Wrangler の `secret put` も使えます。
4. デプロイ先の `/health` が HTTP 200 を返すことを確認します。MCP クライアントには `https://<Worker のホスト名>/mcp` と `Authorization: Bearer <MCP_API_KEY>` を設定します。`X-API-Key` も使えます。クライアントに connpass のキーを渡す必要はありません。

## ChatGPT で使う（OAuth）

既存の Worker に OAuth を追加する手順です。`MCP_API_KEY` は 32 文字以上のランダム値を使用してください。単に `/health` が 200 であるだけでは OAuth の有効化は確認できません。

1. `apps/mcp-server` に移動し、次のコマンドで初回だけ専用の KV とローカル設定を用意します。

   ```bash
   cp -n wrangler.jsonc wrangler.oauth.local.jsonc
   corepack pnpm@10.34.9 exec wrangler kv namespace create connpass-mcp-server-oauth \
     --config wrangler.oauth.local.jsonc --binding OAUTH_KV --update-config
   ```

2. `wrangler.oauth.local.jsonc` の `vars` に `MCP_OAUTH_ORIGIN` を設定します。値は Worker の公開 HTTPS オリジン（例: `https://your-worker.workers.dev`）のみで、`/mcp` や末尾の `/` は付けません。このファイルは Git 管理外です。以降も `OAUTH_KV` が失われないよう **同じ設定ファイル**で更新してください。共通の `wrangler.jsonc` に変更が入った場合は、必要な設定をローカル側にも反映します。

   ```bash
   corepack pnpm@10.34.9 worker:deploy --config wrangler.oauth.local.jsonc --keep-vars
   ```

   既存の Worker secret は保持されます。デプロイ後、`/.well-known/oauth-protected-resource/mcp` と `/.well-known/oauth-authorization-server` が 200 を返すことを確認します。
3. ChatGPT の「カスタム MCP サーバーを追加」でサーバー URL に `https://<Worker のホスト名>/mcp`、認証に **OAuth** を選びます。登録方式を聞かれた場合は **動的クライアント登録（DCR）** を選び、クライアント ID やシークレットは手入力しません。
4. 自分で接続を始めたときだけ、**自分の Worker のオリジン**に表示される承認画面で既存の `MCP_API_KEY` を入力します。ChatGPT の設定画面やチャットには貼りません。承認後は ChatGPT に戻り、`search_events` を実行して確認します。

認可は ChatGPT のコールバック URL に限定されます。`MCP_API_KEY` を変更すると、過去に発行した OAuth トークンも利用できなくなり、再接続が必要になります。

## 運用上の注意

- `/mcp` は固定トークン認証、または上記で有効にした OAuth で利用できます。認証なしの MCP アクセスと GET の SSE ストリームは提供しません。`/health` は公開ですが、キーが欠けている場合に 503 を返す以外、設定値は返しません。
- Origin ヘッダーがある場合は同一オリジンのみ許可します。別オリジンのブラウザクライアントが必要なら、`MCP_ALLOWED_ORIGINS` に `https://app.example.com` のような正確な origin をカンマ区切りで設定します。`CONNPASS_DEFAULT_USER_ID` や `CONNPASS_DISABLE_TOOLS` も通常の Worker 変数として設定できます。
- MCP の transport セッションは作りません。`search_events` の結果は Durable Objects に最長 10 分間保持され、別リクエストの `browse_events` から参照できます。SQLite のバインディングは初回デプロイで作成されます。
- connpass API クライアントの待機間隔は一つの MCP リクエスト内に限って適用されます。アカウント全体のクォータ制御ではありません。個人利用の想定で、MCP のキーを公開しないでください。ファイルを使う発表情報キャッシュは Workers では無効です。

## ローカル検証

ルートから、ダミー値で Worker を起動します。

```bash
corepack pnpm@10.34.9 --filter @kajidog/connpass-mcp-server worker:dev \
  --var MCP_API_KEY:local-test-token --var CONNPASS_API_KEY:dummy
node apps/mcp-server/scripts/worker-smoke.mjs # 別ターミナル
```

`worker:check` の後で次を実行できます。本番のキーは不要です。

- `node apps/mcp-server/scripts/worker-search-test.mjs`：模擬 connpass API に対する検索と、別リクエストからの Durable Objects 経由の検索結果取得。
- `node apps/mcp-server/scripts/worker-oauth-test.mjs`：OAuth の発見、クライアント登録、所有者承認、PKCE、対象リソースの照合、トークン更新と既存の固定トークン認証。
