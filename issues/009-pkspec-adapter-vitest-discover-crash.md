---
id: 9
title: pkspec-adapter-vitest の discover が core パッケージでコアダンプする（上流の不具合）
status: open
priority: low
area: spec/pkspec-trial
kind: bug
cause_confirmed: false
count: 1
period_days: 1
source: spec/pkspec-trial の M1 試験（2026-10-30）
created: 2026-10-30
---

## 観測

- pkspec@0.4.2（公式 tarball、linux-amd64、sha256 照合済み）の同梱シム `pkspec-adapter-vitest discover` を
  `packages/core` で実行すると、出力 0 バイトのままコアダンプで落ちる（bash: 「中止 (コアダンプ)」）。
- 同じコマンドは `packages/hub` では成功し、145 ケースの JSON を返した。
- `run --manifest` は **core でも成功**する（Q-01 のケースを実行し `outcome: "passed"`）。落ちるのは discover だけ。
- hub と core の違い：hub は @cloudflare/vitest-plugin（workerd プール）、core は素の vitest ＋ fast-check。

## 仮説

- ~~確度 中：素の vitest（workerd プールなし）だと落ちる~~ **反証済み（2026-10-30）**：
  vitest 4.1.12 だけの最小プロジェクト（1ファイル1テスト）では discover は成功した。
- 切り分けの観測（2026-10-30）：
  - packages/core：**決定的に再現**（2回とも exit 134 = SIGABRT、出力 0 バイト）
  - packages/hub（workerd プール）・packages/view（素の vitest、同じモノレポ・同じ vitest 版）：成功
  - `vitest list` 自体は core で成功する → 落ちているのは vitest ではなく**シム（MoonBit バイナリ）の discover 処理**
- 確度 中（更新後）：core のテスト収集の出力・内容の何か（候補：fast-check を import する5ファイル、
  テスト名に含まれる記号 ≤・×・=== など）をシムが処理するところで abort する。
  反証するには、core のテストファイルを1つずつ含めて discover を回し、落ちる最小の組を見つける。
- drift 分類は `harness-drift`（検査の道具の側の不具合）。検査の性質は変えない。

## 次の一手

- core のテストファイルを1つずつ含めた切り分けで最小再現を絞り、上流（mizchi/pkspec）に報告する
  （**外部への報告は利用者の了承を得てから**。切り分けデータは上の観測のとおり揃っている）。
- 影響：pkspec は唯一の正の検査器になった（adr/0001 の利用者決定 2026-10-30）が、落ちるのは
  adapter シムの discover だけで、check・exec・spec・coverage と run は動く。overlay の実行
  （scripts/run-overlays.mjs）では core の discover 照合を省略して run で検証している。
