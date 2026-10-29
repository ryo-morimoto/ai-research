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

- 確度 中：discover の一覧取得が vitest の特定の出力・設定（プールの違い、list の出力形）を前提にしており、
  core 側の形で落ちる。反証するには、最小の vitest プロジェクト（素の vitest のみ）で discover を実行して
  再現するかを見る。
- これは drift 分類では `harness-drift`（検査の道具の側の不具合）。検査の性質は変えない。

## 次の一手

- 最小再現を作り、再現したら上流（mizchi/pkspec）に報告する（**外部への報告は利用者の了承を得てから**）。
- 影響：pkspec は唯一の正の検査器になった（adr/0001 の利用者決定 2026-10-30）が、落ちるのは
  adapter シムの discover だけで、check・exec・spec・coverage と run は動く。overlay の実行
  （scripts/run-overlays.mjs）では core の discover 照合を省略して run で検証している。
