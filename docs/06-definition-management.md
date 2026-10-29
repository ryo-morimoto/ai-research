# 06 意図・制約の定義管理（理想形の提案） v0.1

2026-10-29。knowledge:「意図を書くための仕様・制約の記述手段」（2026-10-26）の6層をこのリポジトリに割り付け、定義管理の到達点と移行順を決める。

## 0. 原則

仕様が正。実装は仕様側の検査で受け入れる（SDD [40][41]）。そのために、すべての定義を次の4つの性質に寄せる。

1. **宣言は1か所**：同じ値・同じ語彙を2か所に書かない。
2. **参照は導出**：他の場所が要るときは、正から計算して埋める（手で写さない）。
3. **判定は機械**：制約には「何が検査するか」が必ず付く。文型・スキーマ・テスト・モデル検査・計測のどれか。
4. **判定できない MUST は CI で目立つ**：未検査の制約は「ない」のではなく「未検査」と列挙される。

現状の主な違反（issues/002、docs/03 §2.3 の漂流、Q-01 のラベル散在、wrangler.jsonc と cloudflare.config.ts の手動同期）は、すべて 1〜2 の違反が原因。3〜4 の仕組みがないため、違反してもすぐには気づけなかった。

## 1. 層の割り付け

| 層（knowledge） | このリポジトリでの正 | 判定 | 現状とのギャップ |
|---|---|---|---|
| 0 目的 | docs/01 §1（散文のまま） | 制約の `serves` で参照される | リンクなし |
| 1 要件文 | **specs/constraints.yaml（新設）**：W-/S-/P-/Q-/U-/E-/R-/V-/C-/INV- | scripts/check-constraints.mjs（新設） | docs の表×テスト名×コメントの三重管理 |
| 2 定量目標 | POLICY.slo（新設、Planguage の Scale/Meter/Goal [9][10]） | bench/ とログ分析（フィットネス関数 [13]） | 【要計測】が放置可能 |
| 3 設計 | specs/*.qnt（既存の Quint） | spec:check を **pnpm check に組み込む** | 任意実行のまま |
| 4 コード | 境界の Zod（契約 [24]）、fast-check（性質 [29]）、型の強制 | typecheck・test（既存） | 上限の直書き（P1 で解消） |
| 5 ルール・データ | packages/policy の POLICY | **PolicySchema（新設）** で parse | POLICY 自身は無検査 |

形式手法を増やす範囲は knowledge の推奨どおり「間違えると高くつく部分」だけに絞る：並行（RunDO=済・Quint）、台帳への追記（LedgerDO）、経路の判断（RouteDO）。View・文言・整形はテストで十分。全面の TLA+/Dafny 化はしない。

## 2. L1：制約レジストリ（最優先）

docs/01 の制約表・docs/05 の「制約→試験」対応表・テスト名の `[C-01]`・run.ts の INV コメントは、同じ事実の4つの写し。正を1つにする。

```yaml
# specs/constraints.yaml（抜粋）
- id: C-01
  layer: view
  strength: MUST
  statement: "モデルに見せるのは openTool だけとする"   # EARS 風 [4]：条件＋主体＋義務
  serves: [Q-05]
  checks:
    - test: "packages/hub/test/mcp.test.ts :: C-01"
- id: INV-8
  layer: run
  strength: MUST
  statement: "締め切りで終わっていなかった現在の版の作業は、その束の cutoffs に必ず現れる"
  checks:
    - spec: "specs/run.qnt#INV-8"
    - test: "packages/hub/test/run.test.ts :: INV-8"
- id: S-05
  strength: SHOULD
  statement: "…"
  checks: []            # ← check-constraints が「未検査の制約」として列挙する
```

`scripts/check-constraints.mjs` が CI で検査する：

1. **MUST で checks が空なら FAIL**（期限つき waiver でのみ猶予）。SHOULD は警告として列挙。
2. **checks の参照先が実在する**：`test:` はテスト名の grep、`spec:` は qnt 内の定義、`bench:`/`measure:` はスクリプトの存在。
3. **docs の表はレジストリから生成**（または照合）。docs/03 §2.3 のような漂流は、生成に切り替えた時点で起きなくなる。
4. 逆引き：テスト名にある ID がレジストリにない場合も FAIL（孤児の検出）。

これで「S-05 に試験がない」「【要計測】が1年放置」が、人の記憶ではなく CI の出力になる。NASA FRET [5] の思想（制限言語＋検査への変換）の軽量版であり、新しい言語は導入しない。

## 3. L5：POLICY のスキーマ化と導出の固定

**POLICY 自身に Zod スキーマを与える**（JSON Schema 系 [36][39]）。構造だけでなく、値の間の不変条件を書く：

- `backoff.minMs <= defaultMs <= maxMs`
- `routing.cutoffAllowReasons ⊆ CUTOFF_REASONS`（P1 で satisfies により型レベルで実施済み）
- `relevance.minCoverage ∈ (0,1)`、`modes.*.passagesPerBundle <= limits.passagesPerBundle`
- `deadlines.nextMaxWaitMs < leaseWaitMs` のような順序関係

CUE の「制約の単一化で矛盾を検出する」[33] と同じ効果を、既存依存（Zod）だけで得る。テストで `PolicySchema.parse(POLICY)` を回し、procedureVersion（内容ハッシュ）に versioned なまま載せる。

**導出の向きを固定する**（P1 で実施済み、このブランチ）：

```
POLICY（正）
  → INPUT_BOUNDS（境界の上限）
      → boundary.ts の Zod（受け入れ契約）
      → sandboxTypes(bounds)（モデルが読む型定義の文）
```

残りの二重化も同じ型で解消する：

- **wrangler.jsonc と cloudflare.config.ts**：cloudflare.config.ts を正にして wrangler.jsonc を生成（スクリプト＋照合チェック）。手動同期のコメントを消す。
- **Env**：Zod スキーマ化。`SEARCH_PROVIDER` は `z.enum(["brave","tavily","none"])`、`TEST_*` の `Number()` 黙殺フォールバックは起動時の1か所に集約。`readHookInput` の `as HookInput` も Zod で置換（境界は P-05 の対象）。
- **版の比較**：`compareVersions`（check-budget.mjs）と `pluginOutdated`（route.ts）を1つに。
- **Q-01 のラベル**：「経路外（…）」「引用確認済…」の語彙を `LABELS` として policy に1か所定義し、ROUTE_DENY_REASON・ROUTE_ALLOW_CONTEXT・EMPTY_NEXT・boundary の NEXT・SKILL.md はテンプレートで参照。check-budget に「ラベル文字列の直書き禁止」の placement 検査を足す。これで Q-01（ラベル一覧は1か所）が初めて機械判定になる。

## 4. L4：契約の規約と検査の置き換え

- **境界の受け入れ規約を明文化**（P1 で実装済み）：型・形の誤りだけ bad_input で拒む。直し方が自明な数値の超過は丸めて `clamped` で知らせる（設計 v1.5 §8.3.7 の一般化）。issue 002 の 30 日 35 件のうち waitMs 13・maxPassages 2・around 16 件相当がこの規約で消える。
- **性質ベーステスト [29] の対象を広げる**：`sanitizeTraceEvent` の冪等性、`clampMax` の単調性、`presentCutoffs` が URL を失わないこと。fast-check は導入済みなので追加コストは小さい。
- **regex 検査を構造的検査に置き換える**：check-deps.mjs の import 規則は dependency-cruiser（公式の依存グラフ検査）へ。`VerifiedExcerpt` の生成特権は、regex ではなく branded type ＋ コンストラクタ非公開のモジュール設計で型が強制する（regex は防御の2枚目に降格）。動的 import の見逃しがなくなる。

## 5. L2：定量目標と観測の形式化（issues 001–008 の根本対応）

issues/ の 8 件のうち 001・003・004・005 は「観測が場当たり」という同じ原因を持つ。ログを仕様にする：

1. **ObsEvent（Zod union）を1つ定義**：`code_error`・`hub_error`・`slow_storage`・`trace_dropped`・`mcp_bad_request`（issue 003 の 400 に理由を付ける）…。`console.log(JSON.stringify(...))` の直書き（sandbox.ts・run.ts・obs.ts）を `obs.emit()` に集約し、スキーマ外の事象はテストで落ちる。
2. **目標を Planguage で書く** [9][10]。POLICY.slo に版つきで持つ：

   | 目標 | Scale（単位） | Meter（測り方） | Tolerable / Goal |
   |---|---|---|---|
   | 境界の検証失敗率 | bad_input ÷ code 呼び出し | Cloudflare logs 30日 | ≤1% / ≤0.1% |
   | 束の初回応答 | p95 ms（W-01） | trace の run.started→bundle | 25s / 15s |
   | 記録の欠落 | trace_dropped ÷ 事象数（C-03） | obs 集計 | ≤0.1% / 0 |

3. **Meter を自動化**：bench/ と、ログを引いて SLO と突き合わせるスクリプト（OpenSLO の YAML 化 [12] は Cloudflare 側の集計が揃ってからでよい）。これはアーキテクチャのフィットネス関数 [13][14] に当たる。issue 002 型の問題は、次からは SLO 違反として検知される。

## 6. L3：設計検証の運用化

- `spec:check` を `pnpm check` に入れる（壊した仕様を検出する broken variants の仕組みは既にあるので、残りは実行の義務化だけ）。
- INV-n はレジストリに登録し、run.ts のコメントは ID の参照だけにする（本文の重複をやめる）。
- 新規の形式化は RouteDO（会話ごとの明示・cutoff の TTL つき状態）を候補とする。権限・経路の判断は「間違えると高くつく」側で、かつ状態機械なので P/Quint 向き [18]。

## 7. 移行計画

| 段 | 内容 | 規模 |
|---|---|---|
| P1（済・このブランチ） | INPUT_BOUNDS 単一正、丸め＋clamped の統一、sandboxTypes 導出、trace SCHEMA 一元化（REQUIRED 導出・型との一致強制・trace() の型付け）、CutoffOrigin=TraceOrigin | 8 files |
| P2 | constraints.yaml ＋ check-constraints.mjs、docs の表を生成に、spec:check を check へ | 中 |
| P3 | PolicySchema、ObsEvent ＋ obs.emit 集約、Env/hook 入力の Zod 化、POLICY.slo | 中 |
| P4 | dependency-cruiser 置換、wrangler.jsonc 生成、LABELS 一元化（Q-01 の機械判定）、compareVersions 統一 | 中 |

P2 が要（かなめ）。レジストリができると、P3・P4 の各項目は「checks が空の制約」として CI に列挙され、進捗そのものが機械判定になる。

## 8. 入れないもの

- 全面の TLA+/Alloy/Dafny 化・証明（費用対効果が合わない。knowledge の推奨どおり核心のみ）。
- docs の散文の廃止。理由・経緯・トレードオフ（docs/01 §4）は散文が正のまま。レジストリに入るのは判定される事実だけ。
- 新しい仕様言語の導入（EARS/FRET の思想は使うが、記法は今の日本語の要件文＋YAML に留める）。

## 出典

番号は knowledge:「意図を書くための仕様・制約の記述手段」（2026-10-26）の出典一覧に対応する。
