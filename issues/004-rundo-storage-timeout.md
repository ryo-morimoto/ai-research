---
id: 4
title: RunDO のストレージ操作がタイムアウトしてオブジェクトがリセットされた
status: investigating
priority: high
area: hub/run
kind: bug
cause_confirmed: false
count: 4
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# RunDO のストレージ操作がタイムアウトしてオブジェクトがリセットされた

## 観測

直近30日の errorレベルの実エラーはこれだけ(計4件)。

- `Durable Object storage operation exceeded timeout which caused object to be reset.` ×2(`RunDO`、jsrpc、2026-10-23 頃の同時刻)
- 同時刻に `exceededWallTime`(wallTime 30,021ms)×1
- 近い事象:`Connection closed: this Durable Object instance is no longer active.` ×1

件数は少ないが、実行中の調査(run)の経過が失われた可能性があるため優先度は高。

## 仮説

- RunDO の events・trace のバッチ書き込みが1トランザクションとして大きすぎ、ストレージ操作が長引いた(確度:低〜中)。反証:発生時刻の run を特定し、そのときの書き込み量を実行記録から見る。

## 次の一手

- `obs.ts` の `slow_storage` ログが30日で0件 → リセットに至る前の遅い操作を捉えられていない。しきい値・計測対象を見直し、まず前兆を測れるようにする。
- 発生時刻(2026-10-23 頃)の run を RunDO / TraceDO の記録から特定し、何の操作中だったかを確かめる。

## 対応（2026-10-30、docs/06 の設計に基づく実装）

第1段（計測）を実装：`SLOW_STORAGE_MS` を 250ms に下げ、`run.save.*` / `trace.append` に bytes・件数を添えた（docs/06 R3）。律速が確認できたら第2段（チャンク分割）へ。
