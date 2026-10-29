---
id: 5
title: GET /mcp の canceled が異常終了として積もり、観測を汚す
status: investigating
priority: medium
area: hub/mcp
kind: noise
cause_confirmed: false
count: 110
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# GET /mcp の canceled が異常終了として積もり、観測を汚す

## 観測

直近30日で `GET /mcp` の outcome が `canceled` のものが110件。wallTime は中央値37秒・p99 87秒。ただし outcome≠ok の集計(異常終了の見張り)がこれで埋まり、本当の異常(issue 004 の exceededWallTime など)が見えにくい。

## 仮説

- SSE ストリームをクライアント(claude.ai)が切断した正常系(確度:中〜高)。wallTime 中央値37秒・p99 87秒という分布は長生きした接続の切断と整合する。反証:切断時刻がユーザー操作(会話の終了など)と無関係に偏っていれば再考。

## 次の一手

wallTime の分布と発生時間帯を見て正常切断かを確かめる。正常系なら、見張りのクエリ(保存クエリやアラート)で `GET /mcp` の canceled を除外する。コードの変更は不要の見込み。
