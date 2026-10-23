# ai-research：デプロイと運用

版 0.1（実装 v0.1 に対応）

この文書は、ハブを自分の Cloudflare アカウントに置き、claude.ai から使えるようにするまでの手順と、日々の運用をまとめる。設計は docs/02、詳細設計と検証は docs/03 を見る。

---

## 1. 前提

| 項目 | 内容 |
|---|---|
| Cloudflare | **Workers Paid** プラン。code mode の実行環境（Dynamic Workers / Worker Loader）は Workers Paid でだけ使える [1] |
| 手元の道具 | Node.js 22 以上、pnpm 10（`corepack enable` で入る） |
| claude.ai | カスタムコネクタが使えるプラン（Free は1つまで）[2] |
| 検索 | Brave Search API か Tavily の API キー（どちらか1つ）。なければ検索なしで動く（URL を直接渡す使い方と、台帳の検索だけ） |
| GitHub | 任意。トークンがあると GitHub API の頻度制限が緩くなる |

---

## 2. デプロイ

```bash
pnpm install
cd packages/hub
npx wrangler login
```

### 2.1 OAuth の状態を置く KV を作る

```bash
npx wrangler kv namespace create OAUTH_KV
```

表示された `id` を `packages/hub/wrangler.jsonc` の `REPLACE_WITH_OAUTH_KV_ID` と置き換える。

### 2.2 秘密の値を入れる

```bash
# 同意ページで聞く合言葉。自分だけが知る長い文にする（E-01：公開の経路を作らない）
npx wrangler secret put OWNER_PASSPHRASE

# 検索（どちらか1つ）
npx wrangler secret put BRAVE_API_KEY
npx wrangler secret put TAVILY_API_KEY

# 任意
npx wrangler secret put GITHUB_TOKEN
```

検索に使うものを `wrangler.jsonc` の `vars.SEARCH_PROVIDER` に書く（`brave` / `tavily` / `none`）。

### 2.3 常設の方針を自分用にする

`packages/policy/src/index.ts` の `POLICY` を見直す。

- `excludedHosts`：検索の結果から外す取得先（アフィリエイトや SEO 目的のサイトなど）。初期値は空。
- `preferredHosts`：前に並べる一次資料の取得先。
- `hosts`：取得先ごとの頻度制限。取得先の規約が変わったらここを直す。
- 中身を変えたら `revision` を上げる。`procedure_version` は中身のハッシュから自動で変わり、実行記録に残る。

### 2.4 デプロイする

```bash
pnpm check            # 依存の規則・型・試験
npx wrangler deploy
```

デプロイ先の URL（例 `https://ai-research.<アカウント>.workers.dev`）を開き、`ai-research hub. MCP endpoint: /mcp` と出れば動いている。

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

- `wrangler.jsonc` で observability を有効にしてある。Cloudflare のダッシュボードの Workers > ai-research > Logs で見る。
- その場で見るなら `npx wrangler tail`。
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
| デプロイ用の束ね | `cd packages/hub && npx wrangler deploy --dry-run --outdir dist` | 束ねられるかだけを見る |

GitHub Actions の定義は `ci/` にある（`.github/workflows/` に移すと動く。ci/README.md）。`ci.yml` が push と pull request ごとに `pnpm check`・`pnpm spec:check`・束ねの確認を、`nightly.yml` が毎晩、性質ベーステストを多めに回し、Apalache の検査を加える。

---

## 出典

1. Cloudflare Docs「Dynamic Workers: Pricing」https://developers.cloudflare.com/dynamic-workers/pricing
2. Claude Help Center「Get started with custom connectors using remote MCP」https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
