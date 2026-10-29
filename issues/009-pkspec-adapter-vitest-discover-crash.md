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

  切り分けの結果（2026-10-30 の追試で**訂正**）：
  - **fast-check は無関係**。import 行を同じバイト長のコメントに置き換えても再現する（利用者の指摘で検証。
    adapter が import を挿入している事実もない — discover は vitest の収集を走らせるだけ）。
  - 必要条件は「**生のサロゲートペアのリテラル**」。エスケープ表記（\u{1F600}）にすると
    vitest 4.1.12 / 5.0.5 のどちらでも常に成功する。
  - 落ちるかどうかは周辺の内容・vitest の版に敏感：4.1.12 では当該行の削除で通ったが、
    5.0.5 では削除しても・コメント行を足しても落ちる。
  → 変換後の出力の**オフセット／バイト位置がサロゲート境界に掛かるかに依存する、シム内部
  （MoonBit の文字列・位置処理）の不具合**と推定。機構の特定は上流の調査対象。
- **vitest の版に依存しない（2026-10-30 追試）**：モノレポ外の単体プロジェクト（上の再現ファイル＋
  clipChars の 4 行スタブだけ）でも再現する。vitest 4.1.12 と**最新の 5.0.5** の両方で決定的に SIGABRT、
  エスケープ表記への回避も両方で有効（対照実験済み）。→ 原因はシム（MoonBit バイナリ）側で確定。
- drift 分類は `harness-drift`（検査の道具の側の不具合）。検査の性質は変えない。

## 次の一手

- **リポジトリ側は回避済み（2026-10-30）**：core/test/trace.test.ts の絵文字リテラルをエスケープ表記
  （`"\u{1F600}"`）に変えた（検査の意味は同じ）。これで core の discover が通り、
  `pkspec adapter --dry-run` が本体 CLI で全スイート解決（lint:constraints に組み込み済み）。
  scripts/run-overlays.mjs も core の discover 照合を復活させた。
- 残るのは上流（mizchi/pkspec）への報告だけ。投稿文は issues/009-upstream-draft.md
  （**外部への報告は利用者の了承を得てから**）。
- 回避（エスケープ表記）は上流が直るまでの一時措置。生リテラル自体は正当で、上流修正後に戻してよい
  （UTF-8 ソースは標準。Google Java Style 2.3.3 は生リテラルを Best とし、扱えないツール側の不具合と位置づける）。
