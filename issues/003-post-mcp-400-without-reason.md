---
id: 3
title: POST /mcp の 400 が多く、理由が記録されていない
status: investigating
priority: high
area: hub/mcp
kind: observability
cause_confirmed: false
count: 274
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# POST /mcp の 400 が多く、理由が記録されていない

## 観測

直近30日で `POST /mcp` が 400 を返した呼び出しが274件。5xx は0件。該当の呼び出しには console 出力が一切付いておらず、理由がログから分からない。

## 仮説

- MCP の streamable HTTP のセッション切れ(確度:中)。反証:理由ログを足して観測。
- 外部スキャナの不正な JSON-RPC(確度:中)。同上。

現状のログでは切り分けられないので、どちらも未確認。

## 次の一手

400 を返す経路(ルータと MCP トランスポート)に理由の構造化ログを1行足す(例:`{ event: "bad_request", reason, path }`)。1〜2週間観測して内訳を見る。本体の対処は内訳が出てから決める。

## 対応（2026-10-30、docs/06 の設計に基づく実装）

`handleMcp` に 4xx の理由ログ（`bad_request`）を実装（docs/06 R1）。1〜2週間観測して内訳を見る。
