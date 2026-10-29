<!-- 生成物（scripts/check-constraints.mjs が pkspec の出力から作る）。手で編集しない -->

# Test SPEC

144 tests across 2 module(s) — 72 pending, 72 active

1 outstanding question(s) across 1 scenario(s) — see "Outstanding questions" at the end.

## `./`

### `Spec.pkl`

- [ ] **1回の依頼の消費トークンに上限があり、超える前に止めて知らせる** (critical) — verifies: R-01 — tags: spec, strength:MUST, area:budget
  - contributes to: GOAL-BOUNDED-COST
  - body: _not yet implemented_

- [ ] **1回の調査の流れが見える** (critical) — verifies: V-02 — tags: spec, strength:MUST, area:view
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **4分を超える調査は、利用者が求めたとき（deepen）だけ行う** (critical) — verifies: W-04 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST, GOAL-BOUNDED-COST
  - body: _not yet implemented_

- [ ] **View からモデルへ書き戻さない** (critical) — verifies: C-11 — tags: spec, strength:MUST-NOT, area:view
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **「引用確認済」の印は、その回に原文と照合できたものにだけ付く** (critical) — verifies: INV-5 — tags: spec, strength:MUST, area:verify
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **どの面から起こした調査も1か所に集まる** (critical) — verifies: V-06 — tags: spec, strength:MUST, area:trace, ops
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **コードの実行環境からの外への通信は、取得の出口を通るものだけ** (critical) — verifies: INV-12 — tags: spec, strength:MUST, area:sandbox
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **システムが作った文（要約・解釈・結論）を、次の調査の根拠として持ち込まない** (critical) — verifies: Q-03 — tags: spec, strength:MUST-NOT, area:ledger/core
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **システムの失敗は、種別・再試行の可否・次の手と一緒に値で返す** (critical) — verifies: P-05 — tags: spec, strength:MUST, area:boundary
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **スマートフォンで見られる** (critical) — verifies: V-07 — tags: spec, strength:MUST, area:view, ops
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **フックがハブに送るもの・ハブが残すものは用途に要る最小で、README で確かめられる** (critical) — verifies: E-05 — tags: spec, strength:MUST, area:route/plugin
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **プラグインとハブの版のずれ、会話の途中の手順の変更が、その場で分かる** (critical) — verifies: U-05 — tags: spec, strength:MUST, area:route/policy
  - contributes to: GOAL-NO-BURDEN, GOAL-SAME-EVERYWHERE
  - body: _not yet implemented_

- [ ] **モデルに見せる追加は research_view 1つだけ。ほかは app 専用** (critical) — verifies: C-01 — tags: spec, strength:MUST, area:mcp
  - contributes to: GOAL-OBSERVABLE, GOAL-BOUNDED-COST
  - body: _not yet implemented_

- [ ] **並行する作業のうち遅いものが、他の結果の提示を止めない** (critical) — verifies: P-01 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **主張ごとに出典と照合の状態が分かる。状態は「引用が原文にあるか」だけを表す。ラベルの一覧は1か所で決める** (critical) — verifies: Q-01 — tags: spec, strength:MUST, area:verify/policy
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **事実・手順・道具の版・取得条件が機械ごとに分かれていない** (critical) — verifies: Q-05 — tags: spec, strength:MUST, area:hub, ops
  - contributes to: GOAL-SAME-EVERYWHERE
  - body: _not yet implemented_

- [ ] **以前に確かめた事実は、出典が変わっていなければ読み直しに時間を使わない（機械・会話をまたいで）** (critical) — verifies: W-03 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-FAST, GOAL-SAME-EVERYWHERE
  - body: _not yet implemented_

- [ ] **休憩やセッションの区切りを挟んでも、再開が大きく遅くならない** (critical) — verifies: S-02 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **会話で回るターン数と流し込む量が、会話の長さや作業場所によって増えない** (critical) — verifies: S-05 — tags: spec, strength:MUST, area:mcp/budget
  - contributes to: GOAL-FAST, GOAL-SAME-EVERYWHERE
  - body: _not yet implemented_

- [ ] **会話に流し込むのは、問いに関係する段落と最小の説明だけ。言語が違っても関係段落に届き、届かなければ理由が分かる** (critical) — verifies: S-06 — tags: spec, strength:MUST, area:select/policy
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **会話の文脈に由来する内容を、確かめた事実として保存・持ち込みしない。会話から補った問いは結果に示す** (critical) — verifies: Q-06 — tags: spec, strength:MUST, area:verify
  - contributes to: GOAL-VERIFIED, GOAL-SAME-EVERYWHERE
  - body: _not yet implemented_

- [ ] **作業が尽きたら待たせず終わる。0件のときは理由（見つからない/取れない/検索していない）が分かる** (critical) — verifies: P-06 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **使用量は段階の上限を超えない** (critical) — verifies: INV-9 — tags: spec, strength:MUST, area:budget
  - contributes to: GOAL-BOUNDED-COST
  - body: _not yet implemented_

- [ ] **依頼から60秒以内に、向きを確かめられる最初の結果を出す** (critical) — verifies: W-01 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **依頼の難しさに対して思考量を過大にしない** (minor) — verifies: S-04 — tags: spec, strength:SHOULD, area:conversation
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **依頼内容や私的な情報を、調査に必要な範囲を超えて外部に送らない** (critical) — verifies: E-04 — tags: spec, strength:MUST, area:gateway, ops
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **保持期間（既定90日）を過ぎた記録は消す** (critical) — verifies: C-10 — tags: spec, strength:MUST, area:trace
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **利用者が保守し続ける常駐サーバーを必要としない** (minor) — verifies: R-02 — tags: spec, strength:SHOULD, area:ops
  - contributes to: GOAL-NO-BURDEN
  - body: _not yet implemented_

- [ ] **利用者が向きを変えたら以降の作業に反映し、外れた作業を続けない** (critical) — verifies: W-02 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **利用者への問いは結果と一緒に出し、返事を待って作業を止めない** (critical) — verifies: P-04 — tags: spec, strength:MUST, area:policy, ops
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **原文の全文はどのストレージにも書かれない（メモリだけ）** (critical) — verifies: INV-13 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **原文の全文・段落の本文を記録に残さない** (critical) — verifies: C-04 — tags: spec, strength:MUST-NOT, area:trace
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **原文の取得は、選べる経路のうち最も速いものに近い（要約を挟まない）** (critical) — verifies: S-03 — tags: spec, strength:MUST, area:gateway
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **取りこぼしの偏り（打ち切り・照合失敗をホスト・tier・kind ごとに）が見える** (critical) — verifies: V-04 — tags: spec, strength:MUST, area:trace
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **取れない出典は時間上限で打ち切り、結果に示す。同じ失敗を同じ調査で繰り返さない** (critical) — verifies: P-02 — tags: spec, strength:MUST, area:gateway
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **取得した内容に含まれる指示に従わない** (critical) — verifies: E-03 — tags: spec, strength:MUST-NOT, area:sandbox/view
  - contributes to: GOAL-RESPECT, GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **取得した文字列はデータとして扱う（View は textContent だけ）** (critical) — verifies: C-09 — tags: spec, strength:MUST, area:view
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **取得できた出典は、段落が選ばれなくても行き止まりにしない（find か経路外で読める）** (critical) — verifies: P-07 — tags: spec, strength:MUST, area:run/route
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **取得先の規約と頻度制限を全機械の合計で守る。拒まれたら Retry-After だけ空ける** (critical) — verifies: E-02 — tags: spec, strength:MUST, area:limiter
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **台帳から持ち込んだ事実を使った結果は、その場で取り直した場合と同じになる** (critical) — verifies: Q-02 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **台帳と行き来できる** (minor) — verifies: V-08 — tags: spec, strength:SHOULD, area:view
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **台帳のどのレコードも、抜き書きは確かめた時点の原文（正規化後）の部分文字列である** (critical) — verifies: INV-1 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **台帳は追記のみ。既存レコードは変わらない（物理消去を除く）** (critical) — verifies: INV-2 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **同じホストへの取得の開始時刻は、全機械を通して最小間隔以上あく** (critical) — verifies: INV-6 — tags: spec, strength:MUST, area:limiter
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **同じホストへの同時の取得は上限以下** (critical) — verifies: INV-7 — tags: spec, strength:MUST, area:limiter
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **同じ実行の中で失敗した URL には、再び取得を始めない** (critical) — verifies: INV-14 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **墓標の付いたレコード・出典は、以後のどの実行にも候補として返らない** (critical) — verifies: INV-3 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-NO-BURDEN
  - body: _not yet implemented_

- [ ] **外の事実が要る調べものは、道具を指定しなくてもこの経路を通る。明示か届かないときだけ経路外。否定の言い方は明示ではない** (critical) — verifies: U-03 — tags: spec, strength:MUST, area:route
  - contributes to: GOAL-ON-PATH
  - body: _not yet implemented_

- [ ] **実行は、開始時の台帳の番号より後のレコードを読まない** (critical) — verifies: INV-4 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-SAME-EVERYWHERE
  - body: _not yet implemented_

- [ ] **実行中の調査も start から1分以内に見える** (critical) — verifies: V-05 — tags: spec, strength:MUST, area:view
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **往復の回数と結果の形式は、問いの重さに合う（1つの事実は呼び出し2回以内・短い答え）** (minor) — verifies: U-04 — tags: spec, strength:SHOULD, area:modes
  - contributes to: GOAL-NO-BURDEN, GOAL-FAST
  - body: _not yet implemented_

- [ ] **手順の版の前後で取りこぼしの数を比べられる** (critical) — verifies: V-10 — tags: spec, strength:MUST, area:trace
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **持ち込まれる事実を、利用者が直接読めて、消せる（1台で消せばどこからも消える）** (critical) — verifies: U-02 — tags: spec, strength:MUST, area:ledger
  - contributes to: GOAL-NO-BURDEN
  - body: _not yet implemented_

- [ ] **残す原文は確かめるのに必要な短い範囲に限り、出典を明示し、第三者に配布しない** (critical) — verifies: E-01 — tags: spec, strength:MUST, area:ledger/core
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **決まった依頼形式・習慣・整理・機械ごとの設定を求めない。機械を足す作業はアカウント登録1回** (critical) — verifies: U-01 — tags: spec, strength:MUST, area:ops, ops
  - contributes to: GOAL-NO-BURDEN
  - body: _not yet implemented_

- [ ] **深掘りでなければ、続きの上限（4分）を過ぎて作業を始めない** (critical) — verifies: INV-11 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-BOUNDED-COST
  - body: _not yet implemented_

- [ ] **現在の結果として返すのは、現在の版の作業の結果だけ** (critical) — verifies: INV-10 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **答えに影響した喪失は1件ずつ、それ以外は件数と URL で分かる。進行中は喪失と区別する** (critical) — verifies: Q-04 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-VERIFIED
  - body: _not yet implemented_

- [ ] **経路を通らずに得た内容は、結果の上でそれと分かり、理由が示される。確認済の印は付かず台帳にも入らない** (critical) — verifies: Q-07 — tags: spec, strength:MUST, area:route
  - contributes to: GOAL-ON-PATH
  - body: _not yet implemented_

- [ ] **締め切りで終わっていない現在の版の作業は、done でなければ pending に、done なら cutoffs（gave_up）に必ず現れる** (critical) — verifies: INV-8 — tags: spec, strength:MUST, area:run
  - contributes to: GOAL-VERIFIED, GOAL-FAST
  - body: _not yet implemented_

- [ ] **見える化のために常駐サーバーを持たない** (critical) — verifies: C-07 — tags: spec, strength:MUST, area:ops, ops
  - contributes to: GOAL-NO-BURDEN
  - body: _not yet implemented_

- [ ] **記録のためにモデルに書かせない（概念はコードで取り出す）** (critical) — verifies: C-02 — tags: spec, strength:MUST, area:drift
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **記録の書き込みは調査を遅くせず、失敗しても調査は失敗しない** (critical) — verifies: C-03 — tags: spec, strength:MUST, area:trace
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **記録は本人だけが見られる（既存のコネクタの認証を通す）** (critical) — verifies: C-05 — tags: spec, strength:MUST, area:mcp/auth
  - contributes to: GOAL-RESPECT
  - body: _not yet implemented_

- [ ] **記録は追記のみ、取り消しは墓標** (critical) — verifies: C-08 — tags: spec, strength:MUST, area:trace
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **記録を見るのにトークンをほぼ使わない（開く1回・50トークン以下。見る道は LLM・取得に依存しない）** (critical) — verifies: V-01 — tags: spec, strength:MUST, area:view
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **読み取りだけの操作で、承認待ちのために止まらない** (critical) — verifies: P-03 — tags: spec, strength:MUST, area:ops, ops
  - contributes to: GOAL-FAST, GOAL-NO-BURDEN
  - body: _not yet implemented_

- [ ] **調査が探している概念とのずれが見える** (critical) — verifies: V-03 — tags: spec, strength:MUST, area:view/drift
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **調査が長くなっても、1ステップあたりの時間と流入量が増え続けない** (critical) — verifies: S-01 — tags: spec, strength:MUST, area:run/budget
  - contributes to: GOAL-FAST
  - body: _not yet implemented_

- [ ] **調査の記録を本人が消せる** (critical) — verifies: V-09 — tags: spec, strength:MUST, area:trace
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

- [ ] **論文・研究の知見を問う調査は一次資料（書誌・抄録、読めれば本文）に届く。届かない一次資料は理由つきで分かる** (critical) — verifies: Q-08 — tags: spec, strength:MUST, area:scholarly
  - contributes to: GOAL-PRIMARY
  - body: _not yet implemented_

- [ ] **開く結果に件数程度しか入れない（会話にデータを残さない）** (critical) — verifies: C-06 — tags: spec, strength:MUST, area:mcp
  - contributes to: GOAL-OBSERVABLE
  - body: _not yet implemented_

### `Test.pkl`

- [x] **C-01 の検査が実在する** — verifies: C-01
  - body: `cmd` (exit 0 expected)

- [x] **C-02 の検査が実在する** — verifies: C-02
  - body: `cmd` (exit 0 expected)

- [x] **C-03 の検査が実在する** — verifies: C-03
  - body: `cmd` (exit 0 expected)

- [x] **C-04 の検査が実在する** — verifies: C-04
  - body: `cmd` (exit 0 expected)

- [x] **C-05 の検査が実在する** — verifies: C-05
  - body: `cmd` (exit 0 expected)

- [x] **C-06 の検査が実在する** — verifies: C-06
  - body: `cmd` (exit 0 expected)

- [x] **C-07 の検査が実在する** — verifies: C-07
  - body: `cmd` (exit 0 expected)

- [x] **C-08 の検査が実在する** — verifies: C-08
  - body: `cmd` (exit 0 expected)

- [x] **C-09 の検査が実在する** — verifies: C-09
  - body: `cmd` (exit 0 expected)

- [x] **C-10 の検査が実在する** — verifies: C-10
  - body: `cmd` (exit 0 expected)

- [x] **C-11 の検査が実在する** — verifies: C-11
  - body: `cmd` (exit 0 expected)

- [x] **E-01 の検査が実在する** — verifies: E-01
  - body: `cmd` (exit 0 expected)

- [x] **E-02 の検査が実在する** — verifies: E-02
  - body: `cmd` (exit 0 expected)

- [x] **E-03 の検査が実在する** — verifies: E-03
  - body: `cmd` (exit 0 expected)

- [x] **E-04 の検査が実在する** — verifies: E-04
  - body: `cmd` (exit 0 expected)

- [x] **E-05 の検査が実在する** — verifies: E-05
  - body: `cmd` (exit 0 expected)

- [x] **INV-1 の検査が実在する** — verifies: INV-1
  - body: `cmd` (exit 0 expected)

- [x] **INV-10 の検査が実在する** — verifies: INV-10
  - body: `cmd` (exit 0 expected)

- [x] **INV-11 の検査が実在する** — verifies: INV-11
  - body: `cmd` (exit 0 expected)

- [x] **INV-12 の検査が実在する** — verifies: INV-12
  - body: `cmd` (exit 0 expected)

- [x] **INV-13 の検査が実在する** — verifies: INV-13
  - body: `cmd` (exit 0 expected)

- [x] **INV-14 の検査が実在する** — verifies: INV-14
  - body: `cmd` (exit 0 expected)

- [x] **INV-2 の検査が実在する** — verifies: INV-2
  - body: `cmd` (exit 0 expected)

- [x] **INV-3 の検査が実在する** — verifies: INV-3
  - body: `cmd` (exit 0 expected)

- [x] **INV-4 の検査が実在する** — verifies: INV-4
  - body: `cmd` (exit 0 expected)

- [x] **INV-5 の検査が実在する** — verifies: INV-5
  - body: `cmd` (exit 0 expected)

- [x] **INV-6 の検査が実在する** — verifies: INV-6
  - body: `cmd` (exit 0 expected)

- [x] **INV-7 の検査が実在する** — verifies: INV-7
  - body: `cmd` (exit 0 expected)

- [x] **INV-8 の検査が実在する** — verifies: INV-8
  - body: `cmd` (exit 0 expected)

- [x] **INV-9 の検査が実在する** — verifies: INV-9
  - body: `cmd` (exit 0 expected)

- [x] **P-01 の検査が実在する** — verifies: P-01
  - body: `cmd` (exit 0 expected)

- [x] **P-02 の検査が実在する** — verifies: P-02
  - body: `cmd` (exit 0 expected)

- [x] **P-03 の検査が実在する** — verifies: P-03
  - body: `cmd` (exit 0 expected)

- [x] **P-04 の検査が実在する** — verifies: P-04
  - body: `cmd` (exit 0 expected)

- [x] **P-05 の検査が実在する** — verifies: P-05
  - body: `cmd` (exit 0 expected)

- [x] **P-06 の検査が実在する** — verifies: P-06
  - body: `cmd` (exit 0 expected)

- [x] **P-07 の検査が実在する** — verifies: P-07
  - body: `cmd` (exit 0 expected)

- [x] **Q-01 の検査が実在する** — verifies: Q-01
  - body: `cmd` (exit 0 expected)

- [x] **Q-02 の検査が実在する** — verifies: Q-02
  - body: `cmd` (exit 0 expected)

- [x] **Q-03 の検査が実在する** — verifies: Q-03
  - body: `cmd` (exit 0 expected)

- [x] **Q-04 の検査が実在する** — verifies: Q-04
  - body: `cmd` (exit 0 expected)

- [x] **Q-05 の検査が実在する** — verifies: Q-05
  - body: `cmd` (exit 0 expected)

- [x] **Q-06 の検査が実在する** — verifies: Q-06
  - body: `cmd` (exit 0 expected)

- [x] **Q-07 の検査が実在する** — verifies: Q-07
  - body: `cmd` (exit 0 expected)

- [x] **Q-08 の検査が実在する** — verifies: Q-08
  - body: `cmd` (exit 0 expected)

- [x] **R-01 の検査が実在する** — verifies: R-01
  - body: `cmd` (exit 0 expected)

- [x] **R-02 の検査が実在する** — verifies: R-02
  - body: `cmd` (exit 0 expected)

- [x] **S-01 の検査が実在する** — verifies: S-01
  - body: `cmd` (exit 0 expected)

- [x] **S-02 の検査が実在する** — verifies: S-02
  - body: `cmd` (exit 0 expected)

- [x] **S-03 の検査が実在する** — verifies: S-03
  - body: `cmd` (exit 0 expected)

- [x] **S-04 の検査が実在する** — verifies: S-04
  - body: `cmd` (exit 0 expected)

- [x] **S-05 の検査が実在する** — verifies: S-05
  - body: `cmd` (exit 0 expected)

- [x] **S-06 の検査が実在する** — verifies: S-06
  - body: `cmd` (exit 0 expected)

- [x] **U-01 の検査が実在する** — verifies: U-01
  - body: `cmd` (exit 0 expected)

- [x] **U-02 の検査が実在する** — verifies: U-02
  - body: `cmd` (exit 0 expected)

- [x] **U-03 の検査が実在する** — verifies: U-03
  - body: `cmd` (exit 0 expected)

- [x] **U-04 の検査が実在する** — verifies: U-04
  - body: `cmd` (exit 0 expected)

- [x] **U-05 の検査が実在する** — verifies: U-05
  - body: `cmd` (exit 0 expected)

- [x] **V-01 の検査が実在する** — verifies: V-01
  - body: `cmd` (exit 0 expected)

- [x] **V-02 の検査が実在する** — verifies: V-02
  - body: `cmd` (exit 0 expected)

- [x] **V-03 の検査が実在する** — verifies: V-03
  - body: `cmd` (exit 0 expected)

- [x] **V-04 の検査が実在する** — verifies: V-04
  - body: `cmd` (exit 0 expected)

- [x] **V-05 の検査が実在する** — verifies: V-05
  - body: `cmd` (exit 0 expected)

- [x] **V-06 の検査が実在する** — verifies: V-06
  - body: `cmd` (exit 0 expected)

- [x] **V-07 の検査が実在する** — verifies: V-07
  - body: `cmd` (exit 0 expected)

- [x] **V-08 の検査が実在する** — verifies: V-08
  - body: `cmd` (exit 0 expected)

- [x] **V-09 の検査が実在する** — verifies: V-09
  - body: `cmd` (exit 0 expected)

- [x] **V-10 の検査が実在する** — verifies: V-10
  - body: `cmd` (exit 0 expected)

- [x] **W-01 の検査が実在する** — verifies: W-01
  - body: `cmd` (exit 0 expected)

- [x] **W-02 の検査が実在する** — verifies: W-02
  - body: `cmd` (exit 0 expected)

- [x] **W-03 の検査が実在する** — verifies: W-03
  - body: `cmd` (exit 0 expected)

- [x] **W-04 の検査が実在する** — verifies: W-04
  - body: `cmd` (exit 0 expected)

## Spec implementation index

- **C-01** — モデルに見せる追加は research_view 1つだけ。ほかは app 専用
  - test: `Test.pkl` — C-01 の検査が実在する
- **C-02** — 記録のためにモデルに書かせない（概念はコードで取り出す）
  - test: `Test.pkl` — C-02 の検査が実在する
- **C-03** — 記録の書き込みは調査を遅くせず、失敗しても調査は失敗しない
  - test: `Test.pkl` — C-03 の検査が実在する
- **C-04** — 原文の全文・段落の本文を記録に残さない
  - test: `Test.pkl` — C-04 の検査が実在する
- **C-05** — 記録は本人だけが見られる（既存のコネクタの認証を通す）
  - test: `Test.pkl` — C-05 の検査が実在する
- **C-06** — 開く結果に件数程度しか入れない（会話にデータを残さない）
  - test: `Test.pkl` — C-06 の検査が実在する
- **C-07** — 見える化のために常駐サーバーを持たない
  - test: `Test.pkl` — C-07 の検査が実在する
- **C-08** — 記録は追記のみ、取り消しは墓標
  - test: `Test.pkl` — C-08 の検査が実在する
- **C-09** — 取得した文字列はデータとして扱う（View は textContent だけ）
  - test: `Test.pkl` — C-09 の検査が実在する
- **C-10** — 保持期間（既定90日）を過ぎた記録は消す
  - test: `Test.pkl` — C-10 の検査が実在する
- **C-11** — View からモデルへ書き戻さない
  - test: `Test.pkl` — C-11 の検査が実在する
- **E-01** — 残す原文は確かめるのに必要な短い範囲に限り、出典を明示し、第三者に配布しない
  - test: `Test.pkl` — E-01 の検査が実在する
- **E-02** — 取得先の規約と頻度制限を全機械の合計で守る。拒まれたら Retry-After だけ空ける
  - test: `Test.pkl` — E-02 の検査が実在する
- **E-03** — 取得した内容に含まれる指示に従わない
  - test: `Test.pkl` — E-03 の検査が実在する
- **E-04** — 依頼内容や私的な情報を、調査に必要な範囲を超えて外部に送らない
  - test: `Test.pkl` — E-04 の検査が実在する
- **E-05** — フックがハブに送るもの・ハブが残すものは用途に要る最小で、README で確かめられる
  - test: `Test.pkl` — E-05 の検査が実在する
- **INV-1** — 台帳のどのレコードも、抜き書きは確かめた時点の原文（正規化後）の部分文字列である
  - test: `Test.pkl` — INV-1 の検査が実在する
- **INV-10** — 現在の結果として返すのは、現在の版の作業の結果だけ
  - test: `Test.pkl` — INV-10 の検査が実在する
- **INV-11** — 深掘りでなければ、続きの上限（4分）を過ぎて作業を始めない
  - test: `Test.pkl` — INV-11 の検査が実在する
- **INV-12** — コードの実行環境からの外への通信は、取得の出口を通るものだけ
  - test: `Test.pkl` — INV-12 の検査が実在する
- **INV-13** — 原文の全文はどのストレージにも書かれない（メモリだけ）
  - test: `Test.pkl` — INV-13 の検査が実在する
- **INV-14** — 同じ実行の中で失敗した URL には、再び取得を始めない
  - test: `Test.pkl` — INV-14 の検査が実在する
- **INV-2** — 台帳は追記のみ。既存レコードは変わらない（物理消去を除く）
  - test: `Test.pkl` — INV-2 の検査が実在する
- **INV-3** — 墓標の付いたレコード・出典は、以後のどの実行にも候補として返らない
  - test: `Test.pkl` — INV-3 の検査が実在する
- **INV-4** — 実行は、開始時の台帳の番号より後のレコードを読まない
  - test: `Test.pkl` — INV-4 の検査が実在する
- **INV-5** — 「引用確認済」の印は、その回に原文と照合できたものにだけ付く
  - test: `Test.pkl` — INV-5 の検査が実在する
- **INV-6** — 同じホストへの取得の開始時刻は、全機械を通して最小間隔以上あく
  - test: `Test.pkl` — INV-6 の検査が実在する
- **INV-7** — 同じホストへの同時の取得は上限以下
  - test: `Test.pkl` — INV-7 の検査が実在する
- **INV-8** — 締め切りで終わっていない現在の版の作業は、done でなければ pending に、done なら cutoffs（gave_up）に必ず現れる
  - test: `Test.pkl` — INV-8 の検査が実在する
- **INV-9** — 使用量は段階の上限を超えない
  - test: `Test.pkl` — INV-9 の検査が実在する
- **P-01** — 並行する作業のうち遅いものが、他の結果の提示を止めない
  - test: `Test.pkl` — P-01 の検査が実在する
- **P-02** — 取れない出典は時間上限で打ち切り、結果に示す。同じ失敗を同じ調査で繰り返さない
  - test: `Test.pkl` — P-02 の検査が実在する
- **P-03** — 読み取りだけの操作で、承認待ちのために止まらない
  - test: `Test.pkl` — P-03 の検査が実在する
- **P-04** — 利用者への問いは結果と一緒に出し、返事を待って作業を止めない
  - test: `Test.pkl` — P-04 の検査が実在する
- **P-05** — システムの失敗は、種別・再試行の可否・次の手と一緒に値で返す
  - test: `Test.pkl` — P-05 の検査が実在する
- **P-06** — 作業が尽きたら待たせず終わる。0件のときは理由（見つからない/取れない/検索していない）が分かる
  - test: `Test.pkl` — P-06 の検査が実在する
- **P-07** — 取得できた出典は、段落が選ばれなくても行き止まりにしない（find か経路外で読める）
  - test: `Test.pkl` — P-07 の検査が実在する
- **Q-01** — 主張ごとに出典と照合の状態が分かる。状態は「引用が原文にあるか」だけを表す。ラベルの一覧は1か所で決める
  - test: `Test.pkl` — Q-01 の検査が実在する
- **Q-02** — 台帳から持ち込んだ事実を使った結果は、その場で取り直した場合と同じになる
  - test: `Test.pkl` — Q-02 の検査が実在する
- **Q-03** — システムが作った文（要約・解釈・結論）を、次の調査の根拠として持ち込まない
  - test: `Test.pkl` — Q-03 の検査が実在する
- **Q-04** — 答えに影響した喪失は1件ずつ、それ以外は件数と URL で分かる。進行中は喪失と区別する
  - test: `Test.pkl` — Q-04 の検査が実在する
- **Q-05** — 事実・手順・道具の版・取得条件が機械ごとに分かれていない
  - test: `Test.pkl` — Q-05 の検査が実在する
- **Q-06** — 会話の文脈に由来する内容を、確かめた事実として保存・持ち込みしない。会話から補った問いは結果に示す
  - test: `Test.pkl` — Q-06 の検査が実在する
- **Q-07** — 経路を通らずに得た内容は、結果の上でそれと分かり、理由が示される。確認済の印は付かず台帳にも入らない
  - test: `Test.pkl` — Q-07 の検査が実在する
- **Q-08** — 論文・研究の知見を問う調査は一次資料（書誌・抄録、読めれば本文）に届く。届かない一次資料は理由つきで分かる
  - test: `Test.pkl` — Q-08 の検査が実在する
- **R-01** — 1回の依頼の消費トークンに上限があり、超える前に止めて知らせる
  - test: `Test.pkl` — R-01 の検査が実在する
- **R-02** — 利用者が保守し続ける常駐サーバーを必要としない
  - test: `Test.pkl` — R-02 の検査が実在する
- **S-01** — 調査が長くなっても、1ステップあたりの時間と流入量が増え続けない
  - test: `Test.pkl` — S-01 の検査が実在する
- **S-02** — 休憩やセッションの区切りを挟んでも、再開が大きく遅くならない
  - test: `Test.pkl` — S-02 の検査が実在する
- **S-03** — 原文の取得は、選べる経路のうち最も速いものに近い（要約を挟まない）
  - test: `Test.pkl` — S-03 の検査が実在する
- **S-04** — 依頼の難しさに対して思考量を過大にしない
  - test: `Test.pkl` — S-04 の検査が実在する
- **S-05** — 会話で回るターン数と流し込む量が、会話の長さや作業場所によって増えない
  - test: `Test.pkl` — S-05 の検査が実在する
- **S-06** — 会話に流し込むのは、問いに関係する段落と最小の説明だけ。言語が違っても関係段落に届き、届かなければ理由が分かる
  - test: `Test.pkl` — S-06 の検査が実在する
- **U-01** — 決まった依頼形式・習慣・整理・機械ごとの設定を求めない。機械を足す作業はアカウント登録1回
  - test: `Test.pkl` — U-01 の検査が実在する
- **U-02** — 持ち込まれる事実を、利用者が直接読めて、消せる（1台で消せばどこからも消える）
  - test: `Test.pkl` — U-02 の検査が実在する
- **U-03** — 外の事実が要る調べものは、道具を指定しなくてもこの経路を通る。明示か届かないときだけ経路外。否定の言い方は明示ではない
  - test: `Test.pkl` — U-03 の検査が実在する
- **U-04** — 往復の回数と結果の形式は、問いの重さに合う（1つの事実は呼び出し2回以内・短い答え）
  - test: `Test.pkl` — U-04 の検査が実在する
- **U-05** — プラグインとハブの版のずれ、会話の途中の手順の変更が、その場で分かる
  - test: `Test.pkl` — U-05 の検査が実在する
- **V-01** — 記録を見るのにトークンをほぼ使わない（開く1回・50トークン以下。見る道は LLM・取得に依存しない）
  - test: `Test.pkl` — V-01 の検査が実在する
- **V-02** — 1回の調査の流れが見える
  - test: `Test.pkl` — V-02 の検査が実在する
- **V-03** — 調査が探している概念とのずれが見える
  - test: `Test.pkl` — V-03 の検査が実在する
- **V-04** — 取りこぼしの偏り（打ち切り・照合失敗をホスト・tier・kind ごとに）が見える
  - test: `Test.pkl` — V-04 の検査が実在する
- **V-05** — 実行中の調査も start から1分以内に見える
  - test: `Test.pkl` — V-05 の検査が実在する
- **V-06** — どの面から起こした調査も1か所に集まる
  - test: `Test.pkl` — V-06 の検査が実在する
- **V-07** — スマートフォンで見られる
  - test: `Test.pkl` — V-07 の検査が実在する
- **V-08** — 台帳と行き来できる
  - test: `Test.pkl` — V-08 の検査が実在する
- **V-09** — 調査の記録を本人が消せる
  - test: `Test.pkl` — V-09 の検査が実在する
- **V-10** — 手順の版の前後で取りこぼしの数を比べられる
  - test: `Test.pkl` — V-10 の検査が実在する
- **W-01** — 依頼から60秒以内に、向きを確かめられる最初の結果を出す
  - test: `Test.pkl` — W-01 の検査が実在する
- **W-02** — 利用者が向きを変えたら以降の作業に反映し、外れた作業を続けない
  - test: `Test.pkl` — W-02 の検査が実在する
- **W-03** — 以前に確かめた事実は、出典が変わっていなければ読み直しに時間を使わない（機械・会話をまたいで）
  - test: `Test.pkl` — W-03 の検査が実在する
- **W-04** — 4分を超える調査は、利用者が求めたとき（deepen）だけ行う
  - test: `Test.pkl` — W-04 の検査が実在する

## Outstanding questions

- **S-05** — 目標値 10秒の妥当性は未計測。テストに S-05 の ID タグがない
