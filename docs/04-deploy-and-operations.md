# ai-research：デプロイと運用

版 0.3（実装 v0.1 に対応。Cloudflare CLI `cf` でデプロイし、動作を確かめた）

この文書は、ハブを自分の Cloudflare アカウントに置き、claude.ai から使えるようにするまでの手順と、日々の運用をまとめる。設計は docs/02、詳細設計と検証は docs/03 を見る。

---

## 1. 前提

| 項目 | 内容 |
|---|---|
| Cloudflare | **Workers Paid** プラン。code mode の実行環境（Dynamic Workers / Worker Loader）は Workers Paid でだけ使える [1] |
| 手元の道具 | Node.js 22 以上、pnpm 10（`corepack enable` で入る）。Cloudflare CLI `cf`（ベータ）[3] は hub の devDependency に入っている |
| claude.ai | カスタムコネクタが使えるプラン（Free は1つまで）[2] |
| 検索 | Brave Search API か Tavily の API キー（どちらか1つ）。なければ検索なしで動く（URL を直接渡す使い方と、台帳の検索だけ） |
| GitHub | 任意。トークンがあると GitHub API の頻度制限が緩くなる |

### 1.1 `cf` と Wrangler の使い分け

デプロイと資源の操作は `cf` で行う。ただし `cf` はベータで、次の理由から Wrangler の設定（`wrangler.jsonc`）も残す。

| 理由 | 出典 |
|---|---|
| `cf dev`・`cf build`・`cf deploy` は `cloudflare.config.ts` だけを読む。Wrangler は `cloudflare.config.ts` を読まない | [4] |
| 結合試験（`@cloudflare/vitest-plugin`）は `wrangler.jsonc` を読む。`cf` の文書には Vitest の扱いが書かれていない | [4]、この repo の `packages/hub/vitest.config.ts` |
| 記録をその場で流す（`tail`）ことは、`cf` ではまだできない（秘密の値の入れ直しは `cf workers secrets update` でできる。§2.6） | [5] |

このため、束縛（DO・KV・Worker Loader・変数・互換性フラグ）を変えたときは、**`wrangler.jsonc` と `cloudflare.config.ts` の両方を直す**。

`cf` はベータなので、コマンドと設定の書き方は正式版までに変わりうる [6]。下の手順は 2026-10-24 時点の `cf` 1.0.0-beta.21 で確かめた。

---

## 2. デプロイ

2026-10-24 にこの手順で `cf` 1.0.0-beta.21 を使ってデプロイし、動くことを確かめた（§2.7）。

### 2.1 サインインする

`cf` は hub の devDependency に入っている（`pnpm install` で入る）。以下は `packages/hub` で行う。

```bash
pnpm install
cd packages/hub
pnpm exec cf auth login              # 手元にブラウザがなければ --no-browser（リンクとコードが出る。5分で切れる）
pnpm exec cf auth whoami
export CLOUDFLARE_ACCOUNT_ID=<whoami に出たアカウントの id>
```

- `cf` は Wrangler のサインインを使い回さないので、Wrangler でサインイン済みでも一度サインインする [3]。
- 承認の画面で求められる権限のうち「Account API Token Provisioning」は外してよい。外してもデプロイまでできた。
- サインインの有効期限は1時間ほど（`cf auth login` の表示に出る）。

### 2.2 OAuth の状態を置く KV を作る

```bash
pnpm exec cf kv namespaces create --title ai-research-oauth
```

返ってきた JSON の `id` を、`cloudflare.config.ts` の `OAUTH_KV` と `wrangler.jsonc` の `kv_namespaces` の両方に書く（この repo には作った名前空間の `id` が入っている。別のアカウントに置くときは書き換える）。同じ `title` の名前空間がすでにあると 400 で失敗する。

コマンドの名前は `cf cli search "<したいこと>"` で探せる（ローカルで動き、資格情報は要らない）[7]。

### 2.3 設定（`cloudflare.config.ts`）

`cf dev`・`cf build`・`cf deploy` は `packages/hub/cloudflare.config.ts` を読む。この設定は `cf migrate` で `wrangler.jsonc` から作り、次を手で直したもの [8]。

- **Durable Object**：`migrations` は変換されないので、3つのクラスを `exports` に SQLite で宣言した（`exports.durableObject({ storage: "sqlite" })`）。初回のデプロイで「Durable Object exports reconciliation: Created: HostLimiterDO, LedgerDO, RunDO」と出る。
- **秘密の値**：`OWNER_PASSPHRASE` と `BRAVE_API_KEY` を `bindings.secret()` で宣言した。**宣言した秘密の値がそろっていないと、新しい Worker はデプロイできない**（「required secrets have not been set」で止まる）。検索に Tavily を使うなら `BRAVE_API_KEY` を `TAVILY_API_KEY` に替え、`SEARCH_PROVIDER` を `tavily` にする。
- **Worker Loader**：`cf migrate` が `bindings.workerLoader()` に変換した。

### 2.4 秘密の値を用意する

秘密の値はデプロイと一緒にファイルから上げる（`.env` の形か JSON）[5][10]。`packages/hub/.secrets.env` を作る（`.gitignore` に入れてある。commit しない）。

```bash
umask 077
python3 -c 'import secrets;print("OWNER_PASSPHRASE="+secrets.token_urlsafe(32))' > .secrets.env   # 同意ページの合言葉
echo 'BRAVE_API_KEY=<Brave Search API のキー>' >> .secrets.env
```

### 2.5 常設の方針を自分用にする

`packages/policy/src/index.ts` の `POLICY` を見直す。

- `excludedHosts`：検索の結果から外す取得先（アフィリエイトや SEO 目的のサイトなど）。初期値は空。
- `preferredHosts`：前に並べる一次資料の取得先。
- `hosts`：取得先ごとの頻度制限。取得先の規約が変わったらここを直す。
- 中身を変えたら `revision` を上げる。`procedure_version` は中身のハッシュから自動で変わり、実行記録に残る。

### 2.6 確かめてからデプロイする

```bash
pnpm check                                          # 依存の規則・型・試験（wrangler.jsonc を使う）
pnpm exec cf build
pnpm exec cf deploy --prebuilt --dry-run            # API を呼ばず、資格情報も要らない [10]
pnpm exec cf deploy --prebuilt --secrets-file .secrets.env
```

最後に URL が出る（この repo の利用者のものは `https://ai-research.ryo-morimoto-dev.workers.dev`）。開いて `ai-research hub. MCP endpoint: /mcp` と出れば動いている。

2回目からのデプロイ：`--secrets-file` を付けずにデプロイしたとき、前の秘密の値が残るかはまだ確かめていない。毎回 `--secrets-file .secrets.env` を付ける。秘密の値を1つだけ替えるときは、デプロイ済みの Worker に対して次を使う（`cf` のエラー文に出たコマンド）。

```bash
pnpm exec cf workers secrets update --worker ai-research --type secret_text
```

### 2.7 デプロイ後の確認（2026-10-24 に実施）

| 確かめたこと | 結果 |
|---|---|
| `GET /` | `ai-research hub. MCP endpoint: /mcp` |
| トークンなしの `POST /mcp` | 401。`WWW-Authenticate` に `resource_metadata` |
| `/.well-known/oauth-authorization-server` | `client_id_metadata_document_supported: true`、DCR の登録先あり、PKCE は S256 |
| 動的登録 → 同意ページ（合言葉）→ トークン → `tools/list` | 4つの道具（code、ledger_search、ledger_forget、ledger_export） |
| `code` の道具で `research.start`（Brave の検索あり） | 9.2秒で最初の束。段落12件、出典4件（developers.cloudflare.com）、打ち切りなし、使用量 1,552 トークン |

本番でも Worker Loader（code mode の実行環境）と Brave の検索が動いた。

claude.ai のカスタムコネクタとしても接続できた（2026-10-24、§3 の手順。OAuth client は「Use Claude's published identity」）。コネクタ経由で、1回の調査（start → verify → next）と、2回目の同じ問いでの台帳の照らし直しを確かめた。

| 確かめたこと | 結果 |
|---|---|
| コネクタ経由の `research.start` | 段落12件。出典は developers.cloudflare.com と cloudflare-docs の GitHub |
| `research.verify`（原文どおりの引用4件と、数字を書き換えた引用1件） | 4件が確認済で台帳に入り、書き換えた1件は未確認（not_in_source）で入らない |
| 2回目の同じ問い | 台帳の4件が照らし直しで確認済になって返る |

この確認で見つけて直したこと：

- 同じ本文の段落（同じページの重複、cloudflare-docs の元の文書と公開ページ）が束に二重に入っていた → 同じ本文は1回だけ届けるようにした。
- 同じ取得先（developers.cloudflare.com）への取得が重なると、頻度制限の順番待ちが取得の時間上限（8秒）に数えられ、打ち切られていた → 時間上限は要求を出してから数え、順番待ちには別の上限（60秒、`deadlines.leaseWaitMs`）を設けた。直した後は打ち切りなしで、最初の束が 17 秒で返った。


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

### 3.1 頼まなくても ai-research を使わせる

設計は docs/02 §7.4〜7.8（制約 v0.6 の U-03・Q-07）。登録はアカウントに3つだけで、各機械では何もしない。

| 登録するもの | 状態 |
|---|---|
| カスタムコネクタ（§3） | 済み |
| プラグイン `ai-research`（スキル `ai-research-first` と、WebSearch / WebFetch を止めて案内する http のフック）。claude.ai の Customize > Plugins > Add > Add marketplace で `ryo-morimoto/ai-research` を追加し、`ai-research` を入れる | 実装済み（M5）。利用者が追加する |
| Instructions for Claude（Settings > General）に1行 | 利用者が追加する |

Instructions for Claude に足す1行：

```text
* 調べもの・事実確認・最新情報の確認には、ウェブ検索（web_search / web_fetch）ではなく ai-research コネクタの code を使う。ai-research が使えないときだけウェブ検索に戻し、結果に「経路外」と理由を書く
```

プラグインの中身と、フックがハブに送るものは `plugins/ai-research/README.md` にある。経路の計数は MCP の道具 `route_stats` で見られる。Claude Code での確認結果は docs/02 §7.6 の末尾。

ハブの道具の説明文（`packages/policy` の `INSTRUCTIONS`）にも同じ方針を書いてあるが、説明文だけでは足りなかった（2026-10-24 の作業の会話で、説明文が読み込まれていても組み込みのウェブ検索が使われた）。

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
| デプロイ用の束ね | `cd packages/hub && pnpm exec cf build && pnpm exec cf deploy --prebuilt --dry-run` | 束ねて検証するだけ。資格情報は要らない [10] |

GitHub Actions の定義は `ci/` にある（`.github/workflows/` に移すと動く。ci/README.md）。`ci.yml` が push と pull request ごとに `pnpm check`・`pnpm spec:check`・束ねの確認を、`nightly.yml` が毎晩、性質ベーステストを多めに回し、Apalache の検査を加える。

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
11. Claude Help Center「Claude Cowork and chat are one Claude」https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
12. Claude Help Center「Understanding Claude's personalization features」https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features
13. Claude Help Center「Use skills in Claude」https://support.claude.com/en/articles/12512180-use-skills-in-claude
