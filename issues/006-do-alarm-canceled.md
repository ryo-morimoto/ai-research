---
id: 6
title: Durable Object のアラーム処理が canceled になっている
status: investigating
priority: medium
area: hub/run
kind: bug
cause_confirmed: false
count: 11
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# Durable Object のアラーム処理が canceled になっている

## 観測

直近30日で、trigger が日時表示(= alarm 起点)の canceled が11件。2026-10-25〜26 に集中している(origin=alarm のイベントは30日で872件なので、割合は約1.3%)。

1回きりの集中か、継続して起きるのかは未確認。

## 仮説

- RunDO の後片付けや trace のバッチ書き込みのアラームが中断された(確度:低。entrypoint を未確認)。反証:`$workers.entrypoint` で group-by して特定する。

## 次の一手

- どの DO のアラームかを特定する(`$workers.entrypoint` で group-by)。
- 特定できたら、その処理が冪等か(中断→再実行で壊れないか)を確認する。冪等なら優先度を下げてよい。

## 対応（2026-10-30、docs/06 の設計に基づく実装）

entrypoint を特定するクエリを runbook §4.2 に定義。RunDO/TraceDO の alarm は冪等（put の上書き・transactionSync）と確認済み。
