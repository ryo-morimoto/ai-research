# 制約の一覧（生成物）

このファイルは scripts/check-constraints.mjs が spec/constraints.ts から生成する。**手で編集しない。**

## 目的（Goal）

| ID | 内容 | 優先度 |
|---|---|---|
| GOAL-FAST | 調査にかかる時間を短くする（無駄・遅さ・停滞を減らす） | 90 |
| GOAL-SAME-EVERYWHERE | どの機械・どの会話から依頼しても、同じ依頼には同じ結果が同じ速さで返る | 90 |
| GOAL-VERIFIED | 答えの根拠は、原文と照合された引用である（確かさを人が追える） | 85 |
| GOAL-PRIMARY | 論文・研究の知見を問う調査は一次資料に届く | 80 |
| GOAL-ON-PATH | 調べものは、指定がなくてもこのシステムの経路を通る | 80 |
| GOAL-NO-BURDEN | 利用者に習慣・設定・保守を求めない | 70 |
| GOAL-RESPECT | 出典・外部サービス・第三者に配慮する（規約・頻度・著作権・送信の最小化） | 70 |
| GOAL-BOUNDED-COST | 費用と資源に上限があり、超える前に止まる | 60 |
| GOAL-OBSERVABLE | 調査の記録を、トークンをほぼ使わずに本人が見られる | 50 |

## 制約

### boundary

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| P-05 | **MUST** | システムの失敗は、種別・再試行の可否・次の手と一緒に値で返す | test: packages/hub/test/boundary.test.ts |

### budget

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| R-01 | **MUST** | 1回の依頼の消費トークンに上限があり、超える前に止めて知らせる | spec: specs/run.qnt<br>test: packages/core/test/properties.test.ts |
| INV-9 | **MUST** | 使用量は段階の上限を超えない | spec: specs/run.qnt<br>test: packages/core/test/properties.test.ts、packages/hub/test/run.test.ts、packages/hub/test/trace.ts |

### conversation

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| S-04 | SHOULD | 依頼の難しさに対して思考量を過大にしない | measure: 依頼の種類ごとの応答開始時間 |

### drift

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| C-02 | **MUST** | 記録のためにモデルに書かせない（概念はコードで取り出す） | test: packages/hub/test/gateway.test.ts、packages/hub/test/run.test.ts |

### gateway

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| S-03 | **MUST** | 原文の取得は、選べる経路のうち最も速いものに近い（要約を挟まない） | test: packages/hub/test/gateway.test.ts<br>measure: 出典種別ごとの取得時間 |
| P-02 | **MUST** | 取れない出典は時間上限で打ち切り、結果に示す。同じ失敗を同じ調査で繰り返さない | test: packages/hub/test/gateway.test.ts |
| E-04 | **MUST** | 依頼内容や私的な情報を、調査に必要な範囲を超えて外部に送らない | manual: 送信内容の記録（outbound_log）の点検 |

### hub

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| Q-05 | **MUST** | 事実・手順・道具の版・取得条件が機械ごとに分かれていない | manual: 棚卸し（docs/design/architecture.md の表）と2台試験 |

### ledger

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| W-03 | **MUST** | 以前に確かめた事実は、出典が変わっていなければ読み直しに時間を使わない（機械・会話をまたいで） | test: packages/hub/test/run.test.ts<br>measure: 2台試験 |
| Q-02 | **MUST** | 台帳から持ち込んだ事実を使った結果は、その場で取り直した場合と同じになる | test: packages/core/test/examples.test.ts、packages/hub/test/run.test.ts<br>spec: specs/ledger.qnt |
| U-02 | **MUST** | 持ち込まれる事実を、利用者が直接読めて、消せる（1台で消せばどこからも消える） | spec: specs/ledger.qnt<br>test: packages/hub/test/ledger.test.ts |
| INV-1 | **MUST** | 台帳のどのレコードも、抜き書きは確かめた時点の原文（正規化後）の部分文字列である | spec: specs/ledger.qnt<br>test: packages/core/test/properties.test.ts、packages/hub/test/mcp.test.ts<br>script: scripts/check-deps.mjs |
| INV-2 | **MUST** | 台帳は追記のみ。既存レコードは変わらない（物理消去を除く） | spec: specs/ledger.qnt<br>test: packages/hub/test/ledger.test.ts |
| INV-3 | **MUST** | 墓標の付いたレコード・出典は、以後のどの実行にも候補として返らない | spec: specs/ledger.qnt<br>test: packages/hub/test/ledger.test.ts |
| INV-4 | **MUST** | 実行は、開始時の台帳の番号より後のレコードを読まない | spec: specs/ledger.qnt<br>test: packages/hub/test/ledger.test.ts、packages/hub/test/run.test.ts |

### ledger/core

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| Q-03 | **MUST NOT** | システムが作った文（要約・解釈・結論）を、次の調査の根拠として持ち込まない | script: scripts/check-deps.mjs<br>file: specs/ledger.qnt（INV-1 の抽象形） |
| E-01 | **MUST** | 残す原文は確かめるのに必要な短い範囲に限り、出典を明示し、第三者に配布しない | test: packages/core/test/properties.test.ts、packages/hub/test/mcp.test.ts |

### limiter

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| E-02 | **MUST** | 取得先の規約と頻度制限を全機械の合計で守る。拒まれたら Retry-After だけ空ける | test: packages/hub/test/limiter.test.ts、packages/hub/test/policy.test.ts、packages/hub/test/route.test.ts<br>spec: specs/limiter.qnt |
| INV-6 | **MUST** | 同じホストへの取得の開始時刻は、全機械を通して最小間隔以上あく | spec: specs/limiter.qnt<br>test: packages/hub/test/limiter.test.ts |
| INV-7 | **MUST** | 同じホストへの同時の取得は上限以下 | spec: specs/limiter.qnt<br>test: packages/hub/test/limiter.test.ts |

### mcp

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| C-01 | **MUST** | モデルに見せる追加は research_view 1つだけ。ほかは app 専用 | test: packages/hub/test/mcp.test.ts |
| C-06 | **MUST** | 開く結果に件数程度しか入れない（会話にデータを残さない） | test: packages/hub/test/mcp.test.ts |

### mcp/auth

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| C-05 | **MUST** | 記録は本人だけが見られる（既存のコネクタの認証を通す） | test: packages/hub/test/mcp.test.ts |

### mcp/budget

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| S-05 | **MUST** | 会話で回るターン数と流し込む量が、会話の長さや作業場所によって増えない | file: bench/run_cases.py（計測の道具（依頼セット））<br>measure: 長い会話と新しい会話の差 10秒以内【要計測】 |

### modes

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| U-04 | SHOULD | 往復の回数と結果の形式は、問いの重さに合う（1つの事実は呼び出し2回以内・短い答え） | test: packages/hub/test/modes.test.ts<br>measure: bench: 依頼の種類ごとの呼び出し回数と答えの長さ |

### ops

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| P-03 | **MUST** | 読み取りだけの操作で、承認待ちのために止まらない | manual: 点検表：読み取りの道具に承認が要らない設定（各アプリの権限設定） |
| U-01 | **MUST** | 決まった依頼形式・習慣・整理・機械ごとの設定を求めない。機械を足す作業はアカウント登録1回 | manual: 点検表：新しい機械で行う作業が0件（登録手順は docs/runbook.md） |
| R-02 | SHOULD | 利用者が保守し続ける常駐サーバーを必要としない | manual: 点検表：保守が要る常駐プロセス0 |
| C-07 | **MUST** | 見える化のために常駐サーバーを持たない | manual: 点検表 |

### policy

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| P-04 | **MUST** | 利用者への問いは結果と一緒に出し、返事を待って作業を止めない | manual: 説明文の指示（PROCEDURE）。呼び出し器での半自動試験は未着手 |

### route

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| Q-07 | **MUST** | 経路を通らずに得た内容は、結果の上でそれと分かり、理由が示される。確認済の印は付かず台帳にも入らない | test: packages/hub/test/route.test.ts |
| U-03 | **MUST** | 外の事実が要る調べものは、道具を指定しなくてもこの経路を通る。明示か届かないときだけ経路外。否定の言い方は明示ではない | test: packages/hub/test/route.test.ts<br>measure: 経路率：強制できる面 100%、チャット 90% 以上【値は要計測】 |

### route/plugin

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| E-05 | **MUST** | フックがハブに送るもの・ハブが残すものは用途に要る最小で、README で確かめられる | script: scripts/check-budget.mjs<br>file: plugins/ai-research/README.md（ハブに送るものの表） |

### route/policy

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| U-05 | **MUST** | プラグインとハブの版のずれ、会話の途中の手順の変更が、その場で分かる | test: packages/hub/test/route.test.ts<br>script: scripts/check-budget.mjs |

### run

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| W-01 | **MUST** | 依頼から60秒以内に、向きを確かめられる最初の結果を出す | test: packages/hub/test/run.test.ts<br>measure: bench: 最初の結果まで P95 60秒 |
| W-02 | **MUST** | 利用者が向きを変えたら以降の作業に反映し、外れた作業を続けない | spec: specs/run.qnt<br>test: packages/hub/test/run.test.ts |
| W-04 | **MUST** | 4分を超える調査は、利用者が求めたとき（deepen）だけ行う | test: packages/hub/test/run.test.ts<br>spec: specs/run.qnt |
| S-02 | **MUST** | 休憩やセッションの区切りを挟んでも、再開が大きく遅くならない | test: packages/hub/test/run.test.ts<br>measure: 休憩後の最初の応答時間（時間そのものは bench で測る） |
| P-01 | **MUST** | 並行する作業のうち遅いものが、他の結果の提示を止めない | test: packages/hub/test/run.test.ts<br>file: specs/run.qnt（有界応答のモデル） |
| P-06 | **MUST** | 作業が尽きたら待たせず終わる。0件のときは理由（見つからない/取れない/検索していない）が分かる | test: packages/hub/test/modes.test.ts |
| Q-04 | **MUST** | 答えに影響した喪失は1件ずつ、それ以外は件数と URL で分かる。進行中は喪失と区別する | test: packages/hub/test/modes.test.ts |
| INV-8 | **MUST** | 締め切りで終わっていない現在の版の作業は、done でなければ pending に、done なら cutoffs（gave_up）に必ず現れる | spec: specs/run.qnt<br>test: packages/hub/test/run.test.ts、packages/hub/test/trace.ts |
| INV-10 | **MUST** | 現在の結果として返すのは、現在の版の作業の結果だけ | spec: specs/run.qnt<br>test: packages/hub/test/run.test.ts、packages/hub/test/trace.ts |
| INV-11 | **MUST** | 深掘りでなければ、続きの上限（4分）を過ぎて作業を始めない | spec: specs/run.qnt<br>test: packages/hub/test/trace.ts |
| INV-13 | **MUST** | 原文の全文はどのストレージにも書かれない（メモリだけ） | test: packages/hub/test/run.test.ts |
| INV-14 | **MUST** | 同じ実行の中で失敗した URL には、再び取得を始めない | test: packages/hub/test/gateway.test.ts |

### run/budget

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| S-01 | **MUST** | 調査が長くなっても、1ステップあたりの時間と流入量が増え続けない | test: packages/core/test/properties.test.ts<br>measure: ステップ数に対する時間の推移 |

### run/route

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| P-07 | **MUST** | 取得できた出典は、段落が選ばれなくても行き止まりにしない（find か経路外で読める） | test: packages/hub/test/modes.test.ts |

### sandbox

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| INV-12 | **MUST** | コードの実行環境からの外への通信は、取得の出口を通るものだけ | test: packages/hub/test/mcp.test.ts |

### sandbox/view

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| E-03 | **MUST NOT** | 取得した内容に含まれる指示に従わない | test: packages/view/test/view.test.ts<br>manual: 注入試験（半自動、M3） |

### scholarly

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| Q-08 | **MUST** | 論文・研究の知見を問う調査は一次資料（書誌・抄録、読めれば本文）に届く。届かない一次資料は理由つきで分かる | test: packages/hub/test/scholarly.test.ts<br>measure: 学術の依頼セット：一次資料に届いた割合 80% 以上【要計測】 |

### select/policy

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| S-06 | **MUST** | 会話に流し込むのは、問いに関係する段落と最小の説明だけ。言語が違っても関係段落に届き、届かなければ理由が分かる | test: packages/hub/test/modes.test.ts<br>script: scripts/check-budget.mjs<br>measure: bench: 依頼セットの流入量と精度（目標 1,500 以下【要計測】） |

### trace

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| V-04 | **MUST** | 取りこぼしの偏り（打ち切り・照合失敗をホスト・tier・kind ごとに）が見える | test: packages/hub/test/tracedo.test.ts、packages/view/test/view.test.ts |
| V-06 | **MUST** | どの面から起こした調査も1か所に集まる | manual: TraceDO は1人に1つ（設計で満たす）。実機確認済 2026-10-26 |
| V-09 | **MUST** | 調査の記録を本人が消せる | test: packages/hub/test/tracedo.test.ts |
| V-10 | **MUST** | 手順の版の前後で取りこぼしの数を比べられる | test: packages/hub/test/tracedo.test.ts |
| C-03 | **MUST** | 記録の書き込みは調査を遅くせず、失敗しても調査は失敗しない | test: packages/hub/test/tracedo.test.ts |
| C-04 | **MUST NOT** | 原文の全文・段落の本文を記録に残さない | test: packages/core/test/trace.test.ts、packages/hub/test/tracedo.test.ts |
| C-08 | **MUST** | 記録は追記のみ、取り消しは墓標 | test: packages/hub/test/tracedo.test.ts |
| C-10 | **MUST** | 保持期間（既定90日）を過ぎた記録は消す | test: packages/hub/test/tracedo.test.ts |

### verify

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| Q-06 | **MUST** | 会話の文脈に由来する内容を、確かめた事実として保存・持ち込みしない。会話から補った問いは結果に示す | test: packages/core/test/examples.test.ts、packages/core/test/properties.test.ts、packages/hub/test/run.test.ts |
| INV-5 | **MUST** | 「引用確認済」の印は、その回に原文と照合できたものにだけ付く | spec: specs/ledger.qnt<br>test: packages/hub/test/run.test.ts |

### verify/policy

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| Q-01 | **MUST** | 主張ごとに出典と照合の状態が分かる。状態は「引用が原文にあるか」だけを表す。ラベルの一覧は1か所で決める | test: packages/core/test/properties.test.ts、packages/hub/test/policy.test.ts<br>script: scripts/check-budget.mjs |

### view

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| V-01 | **MUST** | 記録を見るのにトークンをほぼ使わない（開く1回・50トークン以下。見る道は LLM・取得に依存しない） | test: packages/hub/test/mcp.test.ts<br>script: scripts/check-budget.mjs、scripts/check-deps.mjs |
| V-02 | **MUST** | 1回の調査の流れが見える | test: packages/hub/test/tracedo.test.ts、packages/view/test/view.test.ts |
| V-05 | **MUST** | 実行中の調査も start から1分以内に見える | test: packages/view/test/view.test.ts |
| V-07 | **MUST** | スマートフォンで見られる | manual: 実機確認済（2026-10-26。幅 375px の描画は headless Chromium の手元確認） |
| V-08 | SHOULD | 台帳と行き来できる | manual: 実機確認 |
| C-09 | **MUST** | 取得した文字列はデータとして扱う（View は textContent だけ） | test: packages/view/test/view.test.ts |
| C-11 | **MUST NOT** | View からモデルへ書き戻さない | test: packages/view/test/view.test.ts |

### view/drift

| ID | 強さ | 制約 | 検査 |
|---|---|---|---|
| V-03 | **MUST** | 調査が探している概念とのずれが見える | test: packages/core/test/drift.test.ts、packages/hub/test/tracedo.test.ts、packages/view/test/view.test.ts |

