# ai-research：デプロイと運用

版 0.2（実装 v0.1 に対応。デプロイを Cloudflare CLI `cf` に替えた）

この文書は、ハブを自分の Cloudflare アカウントに置き、claude.ai から使えるようにするまでの手順と、日々の運用をまとめる。設計は docs/02、詳細設計と検証は docs/03 を見る。

---

## 1. 前提

| 項目 | 内容 |
|---|---|
| Cloudflare | **Workers Paid** プラン。code mode の実行環境（Dynamic Workers / Worker Loader）は Workers Paid でだけ使える [1] |
| 手元の道具 | Node.js 22 以上、pnpm 10（`corepack enable` で入る）、Cloudflare CLI `cf`（ベータ）[3] |
| claude.ai | カスタムコネクタが使えるプラン（Free は1つまで）[2] |
| 検索 | Brave Search API か Tavily の API キー（どちらか1つ）。なければ検索なしで動く（URL を直接渡す使い方と、台帳の検索だけ） |
| GitHub | 任意。トークンがあると GitHub API の頻度制限が緩くなる |

### 1.1 `cf` と Wrangler の使い分け

デプロイと資源の操作は `cf` で行う。ただし `cf` はベータで、次の3つの理由から Wrangler の設定（`wrangler.jsonc`）も残す。

| 理由 | 出典 |
|---|---|
| `cf dev`・`cf build`・`cf deploy` は `cloudflare.config.ts` だけを読む。Wrangler は `cloudflare.config.ts` を読まない | [4] |
| 結合試験（`@cloudflare/vitest-plugin`）は `wrangler.jsonc` を読む。`cf` の文書には Vitest の扱いが書かれていない | [4]、この repo の `packages/hub/vitest.config.ts` |
| 記録をその場で流す（`tail`）と、秘密の値を1つだけ入れ直すことは、`cf` ではまだできない | [5] |

このため、束縛（DO・KV・Worker Loader・変数・互換性フラグ）を変えたときは、**`wrangler.jsonc` と `cloudflare.config.ts` の両方を直す**。

`cf` はベータなので、コマンドと設定の書き方は正式版までに変わりうる [6]。下の手順は 2026-10-24 時点の文書に沿う。

---

## 2. デプロイ

### 2.1 `cf` を入れて、サインインする

```bash
npm install --global cf
cf --version
cf auth login          # 手元にブラウザがなければ cf auth login --no-browser
cf auth whoami
```

`cf` は Wrangler のサインインを使い回さないので、Wrangler でサインイン済みでも一度サインインする [3]。

```bash
pnpm install
cd packages/hub
```

### 2.2 OAuth の状態を置く KV を作る

`cf` は Cloudflare の公開 API の操作を一通り持つ。KV 名前空間を作るコマンドの名前は、ローカルの検索で確かめる（資格情報は要らない）[7]。

```bash
cf cli search "create a KV namespace"
cf <見つかったコマンド> --help      # 引数を確かめる
cf schema <見つかったコマンド>       # API に送る項目（KV 名前空間は title）
```

`title` を `ai-research-oauth` などにして作り、返ってきた JSON の `id` を `wrangler.jsonc` の `REPLACE_WITH_OAUTH_KV_ID` と置き換えて、**commit する**（次の `cf migrate` は作業ツリーが汚れていると何も書かない [8]）。

### 2.3 設定を `cloudflare.config.ts` に変換する

```bash
cf migrate --dry-run     # 何が書かれるかを見る
cf migrate               # cloudflare.config.ts と wrangler.config.ts を書く。cf を devDependency に足す
```

この repo には `@cloudflare/vite-plugin` がないので、束ねには Wrangler が選ばれる [8]。`cf migrate` は既存のファイル（`wrangler.jsonc`、`package.json` のスクリプト、ソース）を書き換えない [8]。

変換のあと、手で直すところ：

1. **Durable Object の宣言**。`migrations` は変換されない [8]。まだ一度もデプロイしていないので、3つのクラスを SQLite で宣言するだけでよい。

   ```ts
   import { bindings, defineConfig, exports } from "cf/config";
   // worker の中
   exports: {
     LedgerDO: exports.durableObject({ storage: "sqlite" }),
     RunDO: exports.durableObject({ storage: "sqlite" }),
     HostLimiterDO: exports.durableObject({ storage: "sqlite" }),
   },
   ```

   `env` の `LEDGER`・`RUNS`・`LIMITER` は `bindings.durableObject({ worker: "ai-research", exportName: "LedgerDO" })` の形になっているかを見る [9]。
2. **秘密の値の宣言**。`.dev.vars` と `.env` は読まれないので、`env` に `bindings.secret()` で宣言する [8]：`OWNER_PASSPHRASE`、使うものだけ `BRAVE_API_KEY` / `TAVILY_API_KEY` / `GITHUB_TOKEN`。
3. **変数**。`SEARCH_PROVIDER: bindings.text("brave")`（`tavily` / `none`）[9]。
4. **変換できなかった項目**。`TODO(@cloudflare)` の注記と `throw` が残っていると `cf build`・`cf deploy` は失敗する [8]。特に `worker_loaders`（`LOADER`）の変換は文書に書かれていないので、`bindings.workerLoader(...)` になっているかを必ず見る [9]。`compatibilityFlags` に `nodejs_compat` と `global_fetch_strictly_public` の両方があること、`observability` が有効なことも見る。
5. **後片付け**。`.cloudflare/` は `.gitignore` に入れてある。生成された型を使うなら `cf workers types` を走らせ、`.cloudflare/types` を `tsconfig.json` に足す [8]。`package.json` の `dev` / `deploy` を `cf dev` / `cf deploy` に替える。

### 2.4 秘密の値を用意する

`cf` では、秘密の値をデプロイと一緒に、ファイルから上げる（JSON か `.env` の形）[5][10]。`packages/hub/.secrets.env` を作る（`.gitignore` に入れてある。commit しない）。

```bash
# 同意ページで聞く合言葉。自分だけが知る長い文にする（E-01：公開の経路を作らない）
OWNER_PASSPHRASE=...
# 検索（使うほうだけ）
BRAVE_API_KEY=...
# 任意
GITHUB_TOKEN=...
```

### 2.5 常設の方針を自分用にする

`packages/policy/src/index.ts` の `POLICY` を見直す。

- `excludedHosts`：検索の結果から外す取得先（アフィリエイトや SEO 目的のサイトなど）。初期値は空。
- `preferredHosts`：前に並べる一次資料の取得先。
- `hosts`：取得先ごとの頻度制限。取得先の規約が変わったらここを直す。
- 中身を変えたら `revision` を上げる。`procedure_version` は中身のハッシュから自動で変わり、実行記録に残る。

### 2.6 確かめてからデプロイする

```bash
pnpm check                                   # 依存の規則・型・試験（wrangler.jsonc を使う）
cf build
cf deploy --dry-run                          # API を呼ばず、資格情報も要らない [10]
cf deploy --secrets-file .secrets.env
```

デプロイ先の URL（例 `https://ai-research.<アカウント>.workers.dev`）を開き、`ai-research hub. MCP endpoint: /mcp` と出れば動いている。

2回目からも `cf deploy --secrets-file .secrets.env` で上げる。`--secrets-file` を付けずにデプロイしたとき、前の秘密の値が残るかどうかは文書に書かれていない。秘密の値を1つだけ替えたいときは、今は Wrangler で `npx wrangler secret put OWNER_PASSPHRASE --name ai-research` とする [5]。

---

## 3. claude.ai に登録する

ヘルプセンターの手順 [2] に沿う（Pro / Max の場合）。

1. **Customize > Connectors** を開く。
2. **+ Add** → **Add custom connector**。
3. 名前（例 `ai-research`）と、URL `https://ai-research.<アカウント>.workers.dev/mcp` を入れて **Continue**。
4. 認証は **Sign in now**、OAuth client は **Use Claude's published identity**（推奨）のままでよい。ハブは Client ID Metadata Document（CIMD）と動的登録（DCR）の両方を受け付ける。
5. 開いた同意ページで合言葉を入れて **許可** を押す。

登録したコネクタは、claude.ai のウェブ・デスクトップ・スマートフォンのアプリから同じように使える（接続は Anthropic のクラウドから出る [2]）。

確かめ方：会話で「ai-research で、arXiv の API の頻度制限を調べて」のように頼む。Claude が `code` の道具で `research.start` を呼び、最初の束が返れば動いている。

---

## 4. 運用

### 4.1 台帳

| したいこと | 方法 |
|---|---|
| 中身を見る | 会話で `ledger_search` の道具、または `ledger_export`（JSONL） |
| 誤った抜き書きを取り消す | `ledger_forget`（record_id か URL）。墓標が追記され、以後の検索に出なくなる。消しはしない |
| 退避（バックアップ） | `ledger_export` の結果を保存する |
| 物理的に消す | MCP の道具にはしていない（INV-2 の唯一の例外なので）。必要なら `LedgerDO.purge` を呼ぶ小さな管理用の Worker を一時的に置く |

### 4.2 記録と障害の調べ方

- observability を有効にしてある。Cloudflare のダッシュボードの Workers > ai-research > Logs で見る。
- その場で見るなら `npx wrangler tail ai-research`。`cf` はまだ記録を流せない [5]。
- 1つの調査の経過は RunDO の実行記録（events）に残る。束を返したとき・作業の開始と終了・方向の変更・照合の記録で、不変条件の検査（docs/03 §3.3）にもそのまま使える。

### 4.3 費用の目安の見方

- 1回の調査が使うトークンは束の `budget.usedTokens` に出る。段階ごとの上限は `POLICY.caps`（最初 10万、続き 60万、深掘り 140万）。
- Dynamic Workers は code の道具を呼ぶたびに作られる。料金は [1] を見る。

---

## 5. 試験の動かし方

| 何を | コマンド | 中身 |
|---|---|---|
| 全部（CI と同じ） | `pnpm check` | 依存の規則、型、core の単体・性質ベーステスト、hub の結合試験（workerd の上で、偽の取得先に対して） |
| 性質ベーステストを多く | `FC_RUNS=20000 pnpm --filter @ai-research/core test` | 失敗したら出力の seed を `FC_SEED` に入れて再現する |
| 形式仕様（速い） | `pnpm spec:check` | Quint のシミュレーション。正しい版は通り、わざと壊した版は違反が見つかること |
| 形式仕様（重い） | `SPEC_MODE=full pnpm spec:check` | Apalache による上限付きのモデル検査を加える。Java 17 以上が要る |
| デプロイ用の束ね | `cd packages/hub && cf build && cf deploy --dry-run` | 束ねて検証するだけ。資格情報は要らない [10]。`cf migrate` の前は `npx wrangler deploy --dry-run --outdir dist` |

GitHub Actions の定義は `ci/` にある（`.github/workflows/` に移すと動く。ci/README.md）。`ci.yml` が push と pull request ごとに `pnpm check`・`pnpm spec:check`・束ねの確認を、`nightly.yml` が毎晩、性質ベーステストを多めに回し、Apalache の検査を加える。`ci.yml` の束ねの確認は、`cloudflare.config.ts` を commit したら `npx cf build` と `npx cf deploy --dry-run` に替える。

CI からデプロイするときは、`cf auth login` の代わりに `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数で渡す。トークンには、その作業に要る権限だけを付ける [10]。

---

## 出典

1. Cloudflare Docs「Dynamic Workers: Pricing」https://developers.cloudflare.com/dynamic-workers/pricing
2. Claude Help Center「Get started with custom connectors using remote MCP」https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
3. Cloudflare CLI docs「Get started」https://developers.cloudflare.com/cf/get-started/
4. Cloudflare CLI docs「Coming from Wrangler」https://developers.cloudflare.com/cf/wrangler/
5. Cloudflare CLI docs「Wrangler to cf reference」https://developers.cloudflare.com/cf/wrangler/reference/
6. Cloudflare Changelog「Cloudflare CLI is now in beta」（2026-09-28）https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/
7. Cloudflare CLI docs「Manage resources」https://developers.cloudflare.com/cf/get-started/resources/
8. Cloudflare CLI docs「Migrate a project」https://developers.cloudflare.com/cf/wrangler/migrate/
9. Cloudflare CLI docs「cloudflare.config.ts」https://developers.cloudflare.com/cf/projects/cloudflare-config/
10. Cloudflare CLI docs「Develop, build, and deploy」https://developers.cloudflare.com/cf/projects/ と「CI and automation」https://developers.cloudflare.com/cf/ci/
