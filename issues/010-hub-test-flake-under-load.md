---
id: 10
title: hub の結合試験が負荷の下で間欠的に落ちる（時間依存の試験）
status: investigating
priority: medium
area: hub/test
kind: noise
cause_confirmed: false
count: 4
period_days: 1
source: 2026-10-29〜30 のフルスイート実行 12 回の記録（このリポジトリの作業ログ）
created: 2026-10-30
---

## 観測

- 2026-10-29〜30 に hub スイート（145 件）をフルで 12 回実行し、3 回で計 4 件が落ちた。落ちた試験は毎回違う：
  - `run.test.ts W-01・P-01`（×2。「3秒に1回」の段落か blocked の打ち切りが最初の束にない）
  - `scholarly.test.ts sources に scholarly を渡すと…`（×2。assertion は expected false/undefined）
  - `tracedo.test.ts steer は版の変化…`（×1、/tmp クォータ超過の時間帯）
- 同じコミットの再実行では毎回 green。負荷（load average 3 前後、並行の check 実行）か /tmp の状態と相関。
- **W-01 は原因を特定して直した（2026-10-30）**：試験が「締め切りで束が返る」（W-01 本体）に加えて
  「中身が最初の束にある」まで要求していた。短縮スケール（25秒×scale）では負荷で中身が続き側にずれる。
  製品の意味論（P-01：遅い分は続きで届く）どおり、締め切りの検査は残し、中身は done まで集める形にした。
  修正後、フルスイート5回連続 all green（145×5）。

## 仮説

- 確度 高（W-01、確認済み）：時間スケール短縮の試験が、締め切り内に非同期の中身が揃うことまで仮定していた。
- 確度 中（scholarly）：同型。偽の取得先への多段の取得（書誌→抄録→公開の版）が lookup/survey の
  短縮締め切りに間に合わないことがある。反証するには、負荷をかけながら scholarly だけを反復し、
  落ちた回の束に pending が残っているかを見る。

## 次の一手

- scholarly の落ちた assertion の対象を、W-01 と同じく「done まで集めてから確かめる」形にできるか確認する
  （締め切りそのものの検査は弱めない）。それまでは再実行で判別できる（同一コミットで green なら flake）。
