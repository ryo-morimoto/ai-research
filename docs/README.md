# docs の地図

このリポジトリの定義は「正・注釈・ビュー」に分かれる（docs/adr/0001）。

| 区分 | 場所 | 中身 | 変更のしかた |
|---|---|---|---|
| **正**（機械可読） | `spec/constraints.ts` | 目的（Goal）と全制約（ID・強さ・1行の要件文・検査への参照） | 編集したら `pnpm constraints:write`。整合は `pnpm check` が検査 |
| 〃 | `packages/policy/` | 実行時の値の正（上限・締め切り・取得先の制限・説明文） | 変えたら revision を上げる（procedureVersion が変わる） |
| 〃 | `specs/*.qnt` | 形式仕様（Quint）＋わざと壊した変種 | `pnpm spec:check` |
| **注釈**（人向け・散文） | `docs/product.md` | 目的・成功の物差し・範囲・制約どうしの緊張関係 | ふつうに編集 |
| 〃 | `docs/design/*.md` | 部品ごとの設計（**現在形**。歴史は書かない） | ふつうに編集 |
| 〃 | `docs/adr/` | 決定の記録（追記型）。`archive/` に旧 01〜05 の全文（経緯の地層） | 追記のみ |
| 〃 | `docs/runbook.md` | デプロイと運用 | ふつうに編集 |
| 〃 | `issues/` | 観測/仮説/次の一手（漂流の分類を含む） | issues/README.md の構造 |
| **ビュー**（生成物） | `docs/generated/` | 制約の一覧（SPEC.md）とカバレッジ（coverage.md） | **手で編集しない。** scripts/check-constraints.mjs が生成 |

## 読み順

1. 何のためのシステムか → `product.md`
2. どんな制約を守るか（一覧） → `generated/SPEC.md`、未検査の棚卸しは `generated/coverage.md`
3. どう作られているか → `design/architecture.md` から部品ごとへ
4. なぜそうしたか → `adr/`（経緯の全文は `adr/archive/`）
5. 動かす・運用する → `runbook.md`

## 制約 ID の読み方

ID は歴史的に安定しており、改名しない。接頭辞の意味：

| 接頭辞 | 区分 | 例 |
|---|---|---|
| W- | 無駄な作業を減らす | W-01 60秒で最初の結果 |
| S- | 必要な作業の遅さを減らす | S-06 流し込む量の最小化 |
| P- | 停滞を減らす | P-05 失敗は次の手つきで返す |
| Q- | 結果の確かさと一貫性 | Q-01 照合の状態、Q-08 一次資料 |
| U- | 利用者の負担 | U-03 経路の強制 |
| E- | 外部への影響 | E-02 頻度制限 |
| R- | 資源 | R-01 トークン上限 |
| V- / C- | 調査の記録（見える化）の要件 / 制約 | V-01、C-04 |
| INV- | 設計の不変条件（Quint・結合試験で守る） | INV-8 |

各 ID の本文・強さ・検査は `spec/constraints.ts` が正。コードやテストの中の `[C-01]` のような表記は、この ID への参照であり、`pnpm lint:constraints` が台帳と突き合わせる（台帳にない ID は「孤児」として落ちる）。

## 旧文書との対応

docs/01〜05 の番号付き文書は 2026-10-29 に再編した（adr/0001）。全文は `adr/archive/` に凍結してある。コードコメントの「docs/02 §8.3.2」のような参照は、archive の同名ファイルの節を指す。

| 旧 | 行き先 |
|---|---|
| 01 要件と制約 | §0・§1・§4 → product.md、§2 の表 → spec/constraints.ts（+ generated/SPEC.md）、§3・§5・別紙 → archive |
| 02 アーキテクチャ | 現在形の設計 → design/、§8.1〜8.4 の経緯と計測 → archive |
| 03 詳細設計と検証 | 不変条件 → spec/constraints.ts、検証の対応表 → generated/、本文 → design/ と archive |
| 04 デプロイと運用 | runbook.md |
| 05 記録と見える化 | V-/C- → spec/constraints.ts、設計 → design/trace-view.md、本文 → archive |
