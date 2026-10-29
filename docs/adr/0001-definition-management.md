# ADR-0001 意図・制約の定義管理 v1.0 — docs の再構成を含む理想形と、その適用

2026-10-29。v0.1 からの変更：(1) 外部調査（mizchi/pkspec、moinsen-dev/speckit-xref、useblocks/sphinx-needs ほか）を反映し、自作レジストリ案を撤回。(2)「docs の現構造は維持する」という前提を外し、docs 自体の再構成を提案の中心に据えた。v1.0：適用した（§適用の記録）。

## 適用の記録（2026-10-29）

- **M1（pkspec 導入試験）は実施済み（spec/pkspec-trial/）**：当初は外部コードの実行が権限で止まり、撤退線（データは pkspec 互換のまま、検査は自作の薄い mjs）を先に実装した。利用者が実行を許可した後、pkspec@0.4.2（sha256 照合済みの公式 tarball）で完走：5件の Spec.pkl 化、`pkspec check` green、壊した変種で exit 1、exec 5/5、coverage 100%。vitest overlay（Adapter.pkl）は4鍵を同梱シムの discover の実ケース ID と照合して一致を確かめ、`pkspec-adapter-vitest run --manifest` で**4ケースすべて実行して passed**（core は discover がコアダンプ、run は動く）。当初の判定は「constraints.ts ＋ mjs を維持」だったが、下記の決定で上書きされた。
- **決定（2026-10-30、利用者）：「正を constraints.ts のままにする二重管理は意味がない。pkspec だけで良い」— pkspec を唯一の正として全面移行した。**
  - 正は `spec/Spec.pkl`（Goal 9・制約 72。強さ・持ち場・ops は tags）。実装ポインタは `spec/Test.pkl`、vitest への接続は `spec/Adapter.pkl`、スキーマは `spec/pkl/`（pkspec@0.4.2 から vendoring）。
  - `spec/constraints.ts`・自作の照合ロジック・併走用の生成スクリプトは削除。`scripts/check-constraints.mjs` は pkspec の実行役（check＋exec＋孤児検出＋ビュー生成）に書き換え、**pkspec を必須の検査器**にした。公式 tarball（sha256 つき）を `tools/pkspec/` に vendoring し、PATH にないときは照合して自動展開するので、**素の環境でも `pnpm check` が通る**（linux-amd64。他は PATH / PKSPEC_BIN）。
  - 移行時の全件実測：`pkspec check` 72 件 green、`pkspec exec` 72/72 passed、孤児 0。overlay は `scripts/run-overlays.mjs` が discover の実 ID と照合して実行し 4/4 passed（core の discover は issues/009 の上流不具合のため run のみ）。
  - 試験ディレクトリ spec/pkspec-trial は役目を終えて削除（利用者の指示）。M1 の証跡はこの節と git 履歴（コミット e63982e〜a7bb5ea）にある。
  - 残る依存：pkspec は experimental（v0.4.2）。CLI の変動と issues/009 は上流に追随する。PATH への導入（chezmoi）は任意になった：リポジトリの vendoring が既定で効く（~/.local/bin への配置はエージェント権限で不可だったため、この形にした）。
- **M2（済）**：`spec/constraints.ts`（Goal 9 件・制約 72 件）＋ `scripts/check-constraints.mjs`。検査の内容：承認済みの MUST に機械検査（ID の grep かファイルの実在）があるか／宣言した grep の空振り／孤児の ID／`docs/generated/` のビューが台帳と一致するか。`pnpm check` に `lint:constraints` と `spec:check` を組み込んだ。CI で判定できない運用系の MUST（P-03・Q-05 など）は `verifiedOutsideRepo` として coverage に列挙する（draft への偽装をしないため）。
- **M3（済）**：docs を再編した。旧 01・02・03・05 は `docs/adr/archive/` に凍結（コードコメントの「docs/02 §8.3.2」はそこを指す）。現在形の設計は `docs/design/`、目的と緊張関係は `docs/product.md`、運用は `docs/runbook.md`、地図は `docs/README.md`。旧 docs/01 §2・docs/05 §2 の制約表と docs/03 §3.5〜3.6 の対応表は削除し、生成物（`docs/generated/`）に置き換えた。
- **P3・P4 相当（済、2026-10-29 同日）**：
  - 弱い検査の ID タグ付与：既存テスト・仕様の見出しに ID を足し、grep 検査へ格上げ（弱い検査は 12 → 4 件。残りは bench の道具・モデルファイル・README の表で、タグの置き場がないもの）。S-02・S-03 も該当テストにタグを付けて approved に。
  - **Q-01 のラベル一元化**：policy に `OFF_PATH_REASONS`（経路外の理由の一覧）を置き、ROUTE_DENY_REASON・ROUTE_ALLOW_CONTEXT・EMPTY_NEXT・boundary の NEXT を導出に変えた。check-budget が「一覧にない経路外ラベルの直書き」を packages・plugins 全体で落とす。
  - **PolicySchema**：hub のテスト（test/policy.test.ts）で POLICY を Zod で parse し、値の間の不変条件（backoff の順序、締め切りの順序、modes ≤ limits、tierWeight の順序、cutoffAllowReasons ⊆ CUTOFF_REASONS、VERIFY_NEXT = CLAIM_REASONS、INPUT_BOUNDS の導出）を検査。
  - **ObsEvent**：観測の事象を obs.ts の1つの union に宣言し、`emit()` に集約（hub_error・code_error・slow_storage・trace_dropped）。code の失敗の記録（issue 001）もここで足した。
- （解消済み）pkspec の実行許可は利用者が与え、M1 は上記のとおり完走した。
- **環境の注意**：/tmp（tmpfs）のクォータ超過時、workerd のテストがまれに落ちる（一時ファイルの書き込み失敗）。`TMPDIR` を別ボリュームに向ければ安定する。

## 0. 診断 — 今の docs はなぜ読みにくいか

1. **番号＝執筆順で、読者の問いと軸が合っていない。** 「C-01 は何に守られているか」「run の仕様はどこか」に一発で答える場所がなく、01（制約表）→ 03（検証戦略）→ 05（view の制約と対応表）→ テスト名、と渡り歩く必要がある。
2. **同じ事実の写しが4か所にある。** docs/01 の表、docs/05 §の対応表、テスト名の ID タグ、run.ts の INV コメント。写しは必ずどれかが腐る。docs/03 §2.3 の漂流（古い状態ラベル、cutoff 理由の欠落）は人の怠慢ではなく構造の帰結。
3. **判定されるべき事実が散文に埋まっている。** 設計文書は v1.3→v1.6 の追記で地層化し（§8.1〜§8.4）、「今の仕様」を知るには歴史を読み通すしかない。
4. **ID 体系（W/S/P/Q/U/E/R/V/C/INV）に地図がない。** 接頭辞の意味がどこにも一覧されていない。

原因はすべて同じ：**人が読む文書に、機械が照合すべき事実を書いている**こと。

## 1. 原則 — 「正・注釈・ビュー」の三分離

> The build is the oracle, not grep or regex. — useblocks/spec-kit-preset-useblocks-vmodel

| 区分 | 中身 | 形式 | 変更のされ方 |
|---|---|---|---|
| **正** | 目的（Goal）、制約（Scenario）、検査への参照、数値目標 | データ（機械可読） | 編集すると CI が整合を検査 |
| **注釈** | 理由・経緯・トレードオフ・却下した代替案 | 散文（ADR、追記型） | 追記のみ。書き直さない |
| **ビュー** | 制約一覧表、制約→検査の対応、カバレッジ、未検査の列挙 | 生成物 | **手書き禁止**。CI が再生成・照合 |

v0.1 の4原則（宣言は1か所・参照は導出・判定は機械・未検査の MUST は列挙される）はこの三分離の系になる。

## 2. 道具の選定 — 調査結果と決定

要件「制約 ID ↔ 検査の照合を CI で」を満たす既製品は2系統あった（調査 2026-10-29、GitHub README 直接取得）。

| 候補 | 強み | このリポジトリとの適合 | 判定 |
|---|---|---|---|
| **mizchi/pkspec** | Goal/Scenario/specRef の常設グラフ、`check`（実装テストのない spec で exit 1）、`orphans`、`coverage`、`docs` 生成、decision log | 常設の不変条件が主のこのリポジトリに語彙がそのまま合う。vitest は adapter+overlay で接続 | **採用** |
| moinsen-dev/speckit-xref | `@spec` アンカー、xref.json、漂流測定、GitHub Action | feature/変更単位が前提（Spec Kit の specs/NNN- 形）。常設制約の台帳には軸違い | 見送り（変更フローを導入するとき再考） |
| useblocks/sphinx-needs | 最成熟。trace graph を `sphinx-build -W` が検証 | Python+Sphinx 一式が pnpm/TS リポジトリに重い | 見送り |
| 自作（YAML+mjs） | 最小・依存ゼロ | 車輪の再発明（v0.1 案） | **フォールバック** |

**pkspec の弱点と撤退線**：experimental（v0.4、API 変動中）、Pkl CLI＋バイナリ依存。これは「正はデータ、道具は差し替え可能」で受ける — Spec.pkl が持つのは ID・強度・文・検査参照だけなので、pkspec が使えなくなっても同じデータを数十行の mjs で検査し直せる。移行コストは一方向（道具→道具）で、文書構造には跳ねない。

## 3. 目標構造

```
README.md                 … リポジトリの入口（現状どおり）
docs/
  README.md               … 地図：何がどこにあるか、ID 接頭辞の意味、読み順（1ページ厳守）
  product.md              … 目的と価値、やらないこと（旧 docs/01 §1。Goal の散文版）
  runbook.md              … 運用（旧 docs/04）
  design/                 … ドメイン別の設計散文（旧 docs/02・03・05 を再編・現在形に書き直し）
    run.md ledger.md route.md trace-view.md gateway.md
  adr/                    … 理由・経緯・トレードオフ（追記型。設計文書の「版の地層」はここに移す）
    0001-....md
  generated/              … ビュー（CI が生成。手書き禁止、レビュー対象外）
    SPEC.md coverage.md
spec/                     … 正（機械可読）
  Spec.pkl                … Goal と Scenario（全制約 ID）。下記 §4
  Test.pkl / Adapter.pkl  … vitest・mjs チェッカー・qnt への接続
specs/*.qnt               … 形式仕様（現状どおり。Scenario の checks から参照される）
issues/                   … 現状どおり（観測/仮説/次の一手）＋漂流分類の語彙を追加（§6）
```

- **docs/01〜05 の番号付き文書は廃止。** 旧 01 §2〜（制約表）→ spec/Spec.pkl へ。旧 03・05 の対応表 → 生成物へ。散文は design/（現在形）と adr/（経緯）に分配。
- **設計散文は「現在形」で書き直す。**「v1.4 で〜に変えた」は adr/ に移し、design/ には今の仕組みだけを書く。
- 生成物は docs/generated/ に隔離し、diff レビューの対象から外す（CI が照合する）。

## 4. spec/ の中身 — 正の形

既存 ID は**維持する**（テスト名・qnt・コメントに根を張っており、改名は漂流だけ生む）。各 Scenario に domain と serves を付け、接頭辞の意味は docs/README.md の地図に一覧する。

```pkl
// spec/Spec.pkl（抜粋。実 ID）
goals {
  new Goal { id = "GOAL-VERIFIED-CITES"; name = "答えの根拠は原文と照合済みの引用である"; priority = 90 }
  new Goal { id = "GOAL-SINGLE-PATH";    name = "どの機械・会話からでも同じ手順・同じ結果"; priority = 80 }
}

scenarios {
  new {
    id = "C-01"; name = "モデルに見せるのは openTool だけ"
    severity = "critical"; reviewStatus = "approved"
    contributes { "GOAL-SINGLE-PATH" }
    tags { "spec"; "domain:view"; "strength:MUST" }
    // 検査は Test.pkl / overlay が specRef "C-01" で指す（mcp.test.ts の既存テスト）
  }
  new {
    id = "INV-8"; name = "締め切りで終わっていない現在の版の作業は、束の cutoffs に必ず現れる"
    severity = "critical"; reviewStatus = "approved"
    contributes { "GOAL-VERIFIED-CITES" }
    tags { "spec"; "domain:run"; "strength:MUST" }
    implementedAt { "specs/run.qnt" }          // 形式仕様＋壊した変種
  }
  new {
    id = "S-05"; name = "束1回の大きさは目標トークン内に収まる"
    severity = "major"; reviewStatus = "draft"  // draft の間は check が落とさない。
    tags { "spec"; "domain:budget"; "strength:SHOULD"; "measure:bench" }
    openQuestions { "Scale と Meter が未定（【要計測】の正体）。bench/ のどれを Meter にするか" }
  }
}
```

- **強度の対応**：MUST は `severity = critical/major` ＋ `reviewStatus = approved` とし、`pkspec check` が「実装テストのない approved spec → exit 1」で落とす。未計測の目標は draft のまま `openQuestions` に残す — 「未検査の MUST が列挙される」が `pkspec next`/`coverage` そのものになる。
- **検査の接続**：vitest は Adapter の overlay で既存テスト名（`[C-01]` タグ）に specRef を付ける。specs/*.qnt・scripts/check-*.mjs・bench/ は `implementedAt` で指し、`check --strict` がパスの実在を検査する。
- **定量目標（旧【要計測】）**：Scenario の記述に Planguage の Scale/Meter/Goal を書き、Meter を bench/ またはログ集計スクリプトにする。POLICY.slo（v0.1 §5）はこの Scenario から導出する。
- **決定の記録**：仕様に関わる決定は Scenario の `decisions`（追記型）へ。文書全体に関わる決定だけ adr/ に書く。

POLICY（packages/policy）は引き続き**実行時の値の正**。Spec.pkl は「何を守るか」、POLICY は「いくつで守るか」を持ち、両者の整合（例：INPUT_BOUNDS が POLICY から導出されている）は既存の型検査と PolicySchema（v0.1 §3、継続）が担う。

## 5. CI の最終形

```
pnpm check =
  pkspec check --strict   … approved spec に生きた検査があるか、implementedAt が実在するか
  pkspec orphans          … specRef のないテスト（タグ漏れ）
  pkspec lint             … 壊れた参照・廃止 spec への参照
  spec:check (Quint)      … 形式仕様＋壊した変種（既存。check に組み込む）
  lint:deps / lint:budget … 置き場所と大きさ（既存 mjs。pkspec の守備範囲外なので残す）
  typecheck / test        … 既存
docs 生成 = pkspec docs / coverage → docs/generated/（CI が再生成し、差分があれば落とす）
```

## 6. 漂流の扱い

docs/03 型の漂流は「対応表を人が直す」のではなく、(a) 表を生成物にして消滅させ、(b) それでも起きるずれ（仕様・コード・形式モデル間）は issues/ のテンプレに **drift 分類**（spec-drift / code-drift / model-drift / harness-drift / decision-drift / coverage-gap、mizchi/skills formal-methods-drift-guard の語彙）を足して起票する。「プロパティを黙って弱めて green にしない」を issues/README.md に明記する。

## 7. 移行計画

| 段 | 内容 | 出口条件 |
|---|---|---|
| M0（済） | INPUT_BOUNDS 単一正・clamp 統一・trace SCHEMA 一元化（ブランチ 30bd830） | check green |
| M1 | pkspec 導入試験：C-01・INV-8・S-05 など5件を Spec.pkl 化、vitest overlay 接続、`pkspec check` をローカルで通す | 5件で check/orphans が意図どおり動く。動かなければフォールバック（自作 mjs）に切替えて M2 へ |
| M2 | 全 ID 移行（旧 01 §2 表・旧 05 表 → Spec.pkl）、`pnpm check` へ組込み、docs/generated/ 生成開始 | 旧対応表の削除。未検査 MUST が coverage に列挙される |
| M3 | docs 再編：design/（現在形に書き直し）・adr/（地層の移設）・README 地図。旧 01〜05 を削除 | docs/ 直下は README・product・runbook・design/・adr/・generated/ のみ |

M1 が関門。pkspec の experimental リスクはここで実測し、ダメなら**データ（ID・文・参照）はそのまま**で検査だけ自作に切り替える。

## 8. 入れないもの

- 既存 ID の改名（接頭辞の意味は地図で解決する）。
- 全面の形式検証・証明（高くつく核心のみ。現状の Quint＋壊した変種を維持し、追加候補は RouteDO だけ）。
- 散文の廃止。理由・経緯は人の文章が正のまま。ただし置き場所は adr/ に固定する。
- Spec Kit / OpenSpec 型の「変更提案フロー」の導入（個人リポジトリには過剰。必要になったら speckit-xref を再評価）。

## 9. 出典

- mizchi/pkspec・uneffect・skills（formal-methods-drift-guard / reconciler）・formal-methods-playground — GitHub README（2026-10-29 取得）
- moinsen-dev/speckit-xref、leocamello/spec-kit-v-model、useblocks/spec-kit-preset-useblocks-vmodel — 同上
- knowledge:「意図を書くための仕様・制約の記述手段」（2026-10-26）— 層の割り付け・Planguage・SLO・フィットネス関数の出典番号はそちらに対応
