---
id: 1
title: code の実行失敗がログに残らない
status: in-progress
priority: high
area: hub/mcp
kind: observability
cause_confirmed: true
count: 0
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# code の実行失敗がログに残らない

## 観測

Cloudflare のログ(Workers Logs、直近30日)に、code の実行そのものの失敗(Claude が書いたコードの構文エラー・例外・60秒タイムアウト)が1件もない。発生していないのではなく、記録していない。

- `packages/hub/src/mcp.ts` の `code` の道具は、`executor.execute()` が `r.error` を返したとき `isError: true` でモデルに返すだけで、console に何も出さない。
- Dynamic Worker(ローダーの子 Worker)自体のイベントも観測に乗らない。30日分のログは全件 `service=ai-research` のみ。

このため、利用者の体験としての「code の失敗」は発生数すら測れない。

## 次の一手

`mcp.ts` の `code` ハンドラで、`r.error` のとき構造化ログを1行出す(`guarded()` の `hub_error` と同じ形。例:`{ event: "code_error", message, logs: r.logs?.length }`)。メッセージは先頭300字に切る。まず測れるようにする。対処(説明文の改善など)は内訳を見てから決める。

## 対応（2026-10-30、docs/06 の設計に基づく実装）

`mcp.ts` の code ハンドラに `code_error` の構造化ログを実装（docs/06 R1）。デプロイ後、内訳を観測して対処を決める。
