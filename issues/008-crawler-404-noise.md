---
id: 8
title: robots.txt / favicon.ico の 404(クローラ由来のノイズ)
status: in-progress
priority: low
area: hub/mcp
kind: noise
cause_confirmed: true
count: 35
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# robots.txt / favicon.ico の 404(クローラ由来のノイズ)

## 観測

直近30日で `GET /robots.txt` が404 ×21、`GET /favicon.ico` が404 ×14。クローラ由来で実害はないが、404 の集計を汚す。

## 次の一手

- `/robots.txt` に全拒否の軽量応答(200)を返す。
- `/favicon.ico` は 204 を返す。

どちらも fetch ハンドラに数行足すだけ。原因はクローラ由来と確認済み。

## 対応（2026-10-30、docs/06 の設計に基づく実装）

`index.ts` の defaultHandler に `/robots.txt`（200、全拒否）と `/favicon.ico`（204）を追加。
