# 調査の記録と見える化（v0.3）

ai-research が「どの概念を、どの語で、どの出典に当たって、何を確かめ、何を取りこぼしたか」を、本人が会話の中の画面で追えるようにする。トークンを使うのは開く1回だけにする。

要件・制約・設計の検討と判断の経緯は claude.ai の文書「ai-research 探索の見える化：要件・制約・設計」（2026-10-26）にある。この文書はリポジトリに置く要約と、作ったものの記録。

## 1. 目的

1. **向きのずれに早く気づく**：実行中の調査が探している概念と当たった出典を見て、違えば steer する（W-01 と同じ動機）
2. **方針を直す材料にする**：打ち切りや照合失敗がどのホスト、どの出典の種類に偏っているかを見て、調査方針や頻度制限表を直す。直した前後で比べる

調べ方の癖（同じ概念を何度も start していないか）は目的に含めない。

## 2. 要件と制約

| ID | 要件 |
| --- | --- |
| V-01 | 見るのにトークンをほぼ使わない。開くときだけ、モデルが引数なしのツールを1回呼び、1行の結果を受け取る（目標：本人の一言を除いて 50 トークン以下）。開いたあとの操作ではモデルの呼び出しが0回 |
| V-02 | 1回の調査の流れが見える（目的 1） |
| V-03 | 1回の調査が探している概念とずれが見える（目的 1） |
| V-04 | 取りこぼしの偏りが見える：打ち切り（理由ごと）と照合失敗を、ホスト・tier・kind ごとに数える（目的 2） |
| V-05 | 実行中の調査も、start から1分以内に見える |
| V-06 | どの面から起こした調査も1か所に集まる |
| V-07 | スマートフォンで見られる |
| V-08 | 台帳と行き来できる |
| V-09 | 調査の記録を本人が消せる |
| V-10 | 手順の版・版の束の前後で V-04 の数を比べられる（目的 2） |

| ID | 制約 | もと |
| --- | --- | --- |
| C-01 | モデルに見せる追加は、開くツール `research_view` 1つ（引数なし、説明文1行）だけ。ほかは app 専用（`_meta.ui.visibility: ["app"]`）。既存のツールと説明文、`code` の返り値は変えない | V-01, R-01 |
| C-02 | 記録のためにモデルに書かせない。概念は、すでに送られている問い・検索語と、取得した題・見出しからコードで取り出す | V-01 |
| C-03 | 調査を遅くしない。記録の書き込みは待たず、失敗しても調査は失敗しない | W-01 |
| C-04 | 原文の全文を残さない。段落の本文の欄を持たない | E-01, INV-13 |
| C-05 | 本人だけが見られる。読み取りは既存のコネクタの認証を通す | E-01 |
| C-06 | 会話にデータを残さない。開く結果には件数程度しか入れない | E-01 |
| C-07 | 常駐サーバーを持たない | R-02 |
| C-08 | 記録は追記のみ、取り消しは墓標 | U-02 |
| C-09 | 取得した文字列はデータとして扱う（View は `textContent` だけ） | E-03 |
| C-10 | 保持期間を過ぎた記録は消す（既定 90 日） | U-02 |
| C-11 | View からモデルへ書き戻さない（`ui/update-model-context` とメッセージ送信を使わない） | V-01 |

## 3. 設計（案 C：MCP Apps の View を会話に出す）

```text
書く道（締め切りの外）
  会話の Claude ──code──▶ 入口 Worker ──▶ RunDO ──事象（waitUntil）──▶ TraceDO
                                             └──照合済みの追記──▶ LedgerDO
開く（モデルを通る1回）
  会話の Claude ──research_view──▶ 会話の中の View（ui://ai-research/view）
見る道（モデルの外）
  View ──trace_read（app 専用）──▶ TraceDO ＋ LedgerDO（墓標の確認）
```

- 部品と画面の詳細は claude.ai の文書の §設計（案 C）
- MCP Apps の仕様：`content` はモデルの文脈用、`structuredContent` は UI 用でモデルの文脈に足されない。app 専用ツールはモデルから見えない
- Claude 側の不具合（claude-code#103924 ほか）は直る前提で扱う。直るまでの手当ては claude.ai の文書の issue の表

### 3.1 事象（packages/core/src/trace.ts）

型に段落の本文の欄がない。保存の前に `sanitizeTraceEvent` を通し、種類ごとに許した欄だけを残して文字列を上限で切る（C-04）。

| 事象 | いつ | 中身 |
| --- | --- | --- |
| `run.started` | start | 解釈した問い、mode、sources、検索語、URL、手順の版、版の束のハッシュ（`procedureVersion`）、clientInfo |
| `run.steered` | steer | 問いの版、新しい問い、検索語、URL |
| `run.deepened` | deepen | 版 |
| `run.done` | 終わり | 理由（idle / limit / close / lookup）、進み具合の数、経過時間 |
| `search.sent` | 検索の応答 | 検索語、検索先（web / scholarly）、成否、件数 |
| `source.fetched` | 取得できた | sourceId、URL、ホスト、kind、tier、題、origin、所要時間、steer で使い回したか |
| `passage.selected` | 段落を届けた | passageId、sourceId、見出し、文字数、経路（bundle / around / find） |
| `ledger.hit` | 台帳の候補を届けた | recordId、URL、状態、理由 |
| `verify.done` | verify | 主張ごとの状態、理由、引いた段落 ID、記録された recordId（引用の文は台帳の側にある） |
| `cutoff` | 打ち切り | what、理由、ホスト、origin、説明 |

上限は `POLICY.trace`（問い 500 字、短い文字列 200 字、URL 2048 字、配列 50 件、調査ごとに事象 5,000 件）。

### 3.2 TraceDO（packages/hub/src/trace.ts）

1人に1つ（`idFromName("trace")`）。SQLite の表は3つ。

| 表 | 中身 |
| --- | --- |
| `events` | 事象（追記のみ）。`run_id`・`ev`（調査の中の順）・`at`・`type`・整形済みの JSON |
| `runs` | 調査ごとの集計。事象の追記と同じトランザクションで増分に更新する（問い、版、終わったか、出典・段落・打ち切り・照合の数） |
| `tombstones` | 取り消した調査。読み取りと、あとから届いた事象の追記で突き合わせる |

RPC：`append(json)`、`runs({limit, since})`、`events(runId)`、`exportJsonl({runId})`、`forget(runId, reason)`。保持期間（`POLICY.trace.retentionDays`）を過ぎた事象と集計は、追記のついでに1時間に1回消す。

### 3.3 送り方（RunDO）

`trace(type, data)` で事象を積み、`ctx.waitUntil` の中でまとめて `append` する。調査の応答は待たない。送れなかった数は `trace_dropped` として観測（observability）に1行残す。

### 3.4 開く・読む・画面（T1）

| 部品 | 置き場所 | 中身 |
| --- | --- | --- |
| `research_view` | hub/src/mcp.ts | モデルに見える唯一の追加。引数なし。説明文は「調査の記録を画面で開く。利用者が見たいと言ったときだけ呼ぶ」。`_meta.ui.resourceUri` で View を指す。返すのは `content` の「表示しました」と、`structuredContent` の件数（started・running）だけ |
| `trace_read` | hub/src/mcp.ts | app 専用（`_meta.ui.visibility: ["app"]`、`readOnlyHint`）。引数 `{view: "today" \| "runs" \| "run", id?, limit?}`。結果は `structuredContent` |
| `ui://ai-research/view` | hub/src/mcp.ts（resource） | mimeType `text/html;profile=mcp-app`。中身は packages/view の `viewHtml()` |
| View | packages/view/src/index.ts | 1枚の HTML。外部を読まない。MCP Apps の View の側の通信を手で書いた（公式の App クラスは依存込みで約 400KB あるため使わない） |
| TraceDO の読み取り | hub/src/trace.ts | `today()`（JST の今日に始まった数、実行中、最近 20 件）と `run(id)`（集計と事象） |

View の動き：

1. `ui/initialize`（protocolVersion `2026-01-26`、appInfo）を送り、応答の hostContext（theme、styles.variables、timeZone）を当てる。`ui/notifications/initialized` を送ってから `trace_read {view: "today"}` を呼ぶ
2. 「今日」：今日始まった数、実行中、最近の調査。押すと `trace_read {view: "run", id}` で「調査の流れ」へ
3. 「調査の流れ」：問いの版ごとに見出しを置き、事象を時刻順に並べる（検索・取得・段落・台帳・照合・打ち切り・終わり）。検索の失敗、照合失敗、打ち切りに色
4. 実行中の調査があるときだけ `pollMs`（15 秒）ごとに読み直す
5. 高さが変わるたびに `ui/notifications/size-changed` を送る
6. JSON-RPC でないメッセージと、親以外からのメッセージは捨てる。`ping` には答える

### 3.5 ずれの印と取りこぼし（T2）

**1回の調査の概念とずれの印**（packages/core/src/drift.ts、V-03、目的 1）。LLM を使わない純粋な関数で、`trace_read {view: "run"}` を読むたびに計算する。

1. 概念の種は、start・steer で渡された検索語そのもの。語の集合の Jaccard 係数が 0.5 以上の検索語は1つの概念にまとめる。検索語がなければ問いを1つの概念にする。表示名は検索語をそのまま使う（作文しない。C-02）
2. 語の分け方は段落選び（select.ts の `discriminativeTerms`：英語は単語、日本語は2文字ずつ、機能語とひらがなだけの語を除く）と同じ。だから `Intl.Segmenter` は使わない（未決事項 4 は不要になった）
3. 出典の語は、題・届けた段落の見出し・URL の道筋から取る（本文は記録にない。C-04）
4. 「未到達」：概念の語の半分以上を含む出典が、その版に1つもない。「外れ」：問いと検索語の語を1つも含まない出典
5. 問いの版ごとに付け直す。steer で使い回した出典も、その版の出典として数える

画面では、問いの版の見出しの下に概念を並べ、未到達の概念に印を付ける。外れの出典の行には「外れ」と出す。印は目安で、向きを決めるのは本人。

**取りこぼし**（TraceDO の `gaps(days)` と `gapRuns`、V-04・V-10、目的 2）。直近 7・30・90 日を選べる。

| 区分 | 中身 |
| --- | --- |
| 打ち切りの理由 | 理由（why）ごとの件数。押すとその理由のあった調査の一覧 |
| 取得先ごと | ホストごとの打ち切りと取得の数、打ち切りの割合、理由の内訳。打ち切りの多い順に 30 件。URL でない打ち切り（検索そのものの失敗など）は1行にまとめる。押すとその取得先の打ち切りがあった調査の一覧 |
| 出典の種類ごと | tier ごとの打ち切りと取得の数。打ち切りの事象に kind と tier を足した（T2） |
| 手順の版ごと | `procedureVersion` ごとの調査の数、打ち切りの割合、照合失敗。古い順。方針を直した前後で比べる（V-10） |
| 照合失敗の理由 | verify の理由ごとの件数 |

一覧から調査を押すと「調査の流れ」へ移り、「戻る」でたどってきた一覧に戻る。

## 4. 制約の守り方と試験

| 守るもの | 試験 |
| --- | --- |
| V-01 見る道が LLM・取得に依存しない | `scripts/check-deps.mjs` の規則 4：`hub/src/trace*.ts` と `core/src/trace.ts` は `cloudflare:workers`・core・policy・`./env.ts` 以外を import できず、fetch も呼べない |
| C-01 文脈を増やさない | `test/mcp.test.ts` の tools/list の固定（T0 では道具を足していない）。T1 で `research_view` を足すときに、差分がそれ1つであることと説明文の大きさを `check-budget` に足す |
| C-03 遅くしない | `test/tracedo.test.ts`：書き込みを失敗させても調査が束を返す |
| C-04 全文を残さない | `core/test/trace.test.ts` の性質 T1〜T3（許した欄だけ・上限を超えない・冪等）と、`tracedo.test.ts` の書き出しに段落の本文がないことの確認 |
| C-08 墓標 | `tracedo.test.ts`：取り消すと読み取りに出ない。遅れて届いた事象も捨てる |
| C-10 保持期間 | `tracedo.test.ts`：91 日前の事象と集計が消える |
| V-01 開く消費 | `check-budget`：開くツールの名前＋説明文＋返す1行が推定 50 トークン以下（今は 40）。`mcp.test.ts`：開く結果は1行と件数だけ |
| C-01 モデルに見える一覧 | `mcp.test.ts`：visibility に model を含むツールは既存の5つと `research_view` だけ。app 専用は `trace_read` だけ |
| C-09・C-11 View | `view/test/view.test.ts`：取得した文字列が要素にならない。View の処理に `ui/update-model-context`・`ui/message`・`innerHTML`・`eval`・`fetch` などがない。外部の読み込みがない |
| View の通信 | `view/test/view.test.ts`：ホストの代わりに handshake、今日 → 調査の流れ、実行中の読み直し、失敗ともう一度、JSON-RPC でないものを捨てる、を確かめる。ほかに headless Chromium でホストを模して画面を撮り、幅 700px・375px、明暗の両方で崩れないことを目で見た（T1、10/26） |
| V-02 規則 5 | `scripts/check-deps.mjs`：View は何にも依存しない |
| V-03 ずれの印 | `core/test/drift.test.ts`：性質 D1（事象を並べ替えても同じ結果）、D2（未到達・外れ・当たった出典が互いに食い違わない）、D3（概念の表示名は検索語そのもの）と例。`tracedo.test.ts`：実際の調査の流れに印が付く |
| V-04・V-10 取りこぼし | `tracedo.test.ts`：理由・取得先・種類・手順の版・照合失敗の理由ごとの数、使い回しを数えない、墓標の付いた調査を数えない、取得先と理由から調査をたどれる。`view.test.ts`：取りこぼし → 取得先ごとの調査 → 調査の流れ → 戻る、期間の切り替え。模擬のホストで幅 700px・375px、明暗の両方を撮って確かめた（T2、10/26） |

## 5. 進め方

- [x] T0：事象の型、TraceDO、RunDO からの送り出し（v0.1、2026-10-26）。画面はまだない。中身は試験と、Cloudflare の Data Studio（SQLite の Durable Object の中を見られる）で確かめる。モデルに見える道具は足していない（C-01）
- [x] T1（コード）：`research_view`、`trace_read`、`ui://ai-research/view`、View（今日と調査の流れ）。試験と模擬のホストでの描画まで（v0.2、2026-10-26）
- [x] T1（実機）：web・Desktop・モバイルのすべてで描かれ、承認は開くときの1回だけ。View の中の操作では承認もモデルの応答も出ない。会話を開き直しても描かれ、操作できる（利用者の確認、2026-10-26）
- [x] T2：1回の調査の概念とずれの印、取りこぼしの画面（v0.3、2026-10-26）。実機での確認は §8 の 1〜3 と同じ手順で、調査の流れと「取りこぼし」のタブを見る
- [ ] T3（必要なら）：調査をまたぐ概念の地図。会話の外で見るための案 B（Artifact）か案 A（ブラウザ）

## 6. 分かったこと

- RunDO は実行後も `meta`（問い・検索語・版・進み具合・段落のメタデータ）と、最大 500 件の内部の記録（`events`）を自分のストレージに残している。ただし調査ごとに別の Durable Object なので一覧できず、打ち切りの理由・ホスト・題を持たない。だから TraceDO を別に置いた
- ハブには LLM を呼ぶ部品がない。見る道が LLM に依存しないことは、今の構造でも満たされている（規則 4 はそれを固定する）

- ハブは要求ごとに MCP サーバーを作る（状態を持たない）。だから tools/list の時点で、相手が MCP Apps を宣言したかを知らない。app 専用ツールはいつも一覧に出し、モデルの一覧から外すのはホストに任せる（仕様ではホストの義務）。設計で考えていた「宣言した接続にだけ返す」設定は作らなかった（T1）

## 7. デプロイ

TraceDO は新しい Durable Object のクラス。`wrangler.jsonc` に移行 `v3`（`new_sqlite_classes: ["TraceDO"]`）と束縛 `TRACE` を、`cloudflare.config.ts` に `TraceDO` の export と束縛を足した。手順は docs/04 と同じ。

T1 では新しい束縛はない。packages/view はワークスペースのパッケージで、hub が TS のまま取り込む（core と同じ）。

## 8. 実機での確認（T1、利用者が行う）

デプロイのあと、次を確かめる。結果で未決事項 3・6・8 が決まる。

| # | 面 | すること | 見ること |
| --- | --- | --- | --- |
| 1 | claude.ai web の Chat | 「調査の記録を見せて」と頼む | View が描かれるか（未決事項 3）。ツールの承認を求められたら、`research_view` の1回だけか |
| 2 | 同じ | View の中で調査を押す。戻る | 会話に新しいモデルの応答が出ないこと（V-01）。`trace_read` のたびに承認が出ないか（未決事項 3） |
| 3 | 同じ | 調査を1つ走らせながら View を開いておく | 実行中の調査が 15 秒ほどで更新されるか（V-05） |
| 4 | Desktop の Chat、Desktop の Code | 1・2 と同じ | 描かれるか（claude-ai-mcp#165 の影響） |
| 5 | モバイルアプリ | 1・2 と同じ | 描かれるか、幅で崩れないか（未決事項 6、V-07） |
| 6 | 1 の会話 | 会話を開き直す | View がまた描かれ、押して読めるか（未決事項 8）。読めれば「見る用の会話」を1つ決めて使い回す |
| 7 | Chat | 「ai-research の道具の名前を全部挙げて」と頼む（確認のための1回） | `trace_read` が挙がらないこと（C-01） |

描かれなかった面があれば、そのときのブラウザの開発者ツールのコンソールと、ハブの観測（observability）の `resources/read` の有無を残す。どの面でも描かれなければ、ext-apps#671 の件が方針か不具合かを確かめ、方針なら案 B（Artifact）に切り替える（`trace_read` はそのまま使える）。

