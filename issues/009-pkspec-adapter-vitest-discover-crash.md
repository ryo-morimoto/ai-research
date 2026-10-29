---
id: 9
title: pkspec-adapter-vitest の discover が core パッケージでコアダンプする（上流の不具合）
status: open
priority: low
area: spec
kind: bug
cause_confirmed: true
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
- **原因を最小再現で確定（2026-10-30、bisect 10 回）**。次の 11 行のファイルが単独で決定的に SIGABRT：

  ```ts
  import { describe, expect, it } from "vitest";
  import fc from "fast-check";
  import { ... } from "../src/index.ts";
  describe("記録の整形（例）", () => {
    const base = { runId: "run_1", at: 1, ev: 1, v: 1 };
    it("サロゲートの組を割らずに切る", () => {
      expect(clipChars("😀😀😀", 2)).toBe("😀😀");
    });
  });
  ```

  切り分けの結果：`import fc from "fast-check"`（**未使用**）を消すと成功。`void fc` で使うと成功。
  生のサロゲートペアのリテラル単体・describe 単体・src import 単体・日本語名単体はどれも成功。
  → 未使用の fast-check import と、describe 内の生のサロゲートリテラルの**組み合わせ**でシムが abort する
  （esbuild/strip の変換経路の差と推測。シム内部の MoonBit 文字列処理が候補）。
- **vitest の版に依存しない（2026-10-30 追試）**：モノレポ外の単体プロジェクト（上の再現ファイル＋
  clipChars の 4 行スタブだけ）でも再現する。vitest 4.1.12 と**最新の 5.0.5** の両方で決定的に SIGABRT、
  エスケープ表記への回避も両方で有効（対照実験済み）。→ 原因はシム（MoonBit バイナリ）側で確定。
- drift 分類は `harness-drift`（検査の道具の側の不具合）。検査の性質は変えない。

## 次の一手

- **リポジトリ側は回避済み（2026-10-30）**：core/test/trace.test.ts の絵文字リテラルをエスケープ表記
  （`"\u{1F600}"`）に変えた（検査の意味は同じ）。これで core の discover が通り、
  `pkspec adapter --dry-run` が本体 CLI で全スイート解決（lint:constraints に組み込み済み）。
  scripts/run-overlays.mjs も core の discover 照合を復活させた。
- 残るのは上流（mizchi/pkspec）への報告だけ。上の最小再現をそのまま貼れる
  （**外部への報告は利用者の了承を得てから**）。
