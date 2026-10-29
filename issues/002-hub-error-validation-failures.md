---
id: 2
title: 境界のバリデーション失敗(hub_error)が頻発している
status: open
priority: high
area: hub/boundary
kind: ux
cause_confirmed: true
count: 35
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# 境界のバリデーション失敗(hub_error)が頻発している

## 観測

直近30日の console 出力50件のうち35件が `hub_error`(境界 `boundary.ts` のバリデーション失敗)。Claude が code からハブの関数を間違った引数で呼んでいる。infoレベルで出るため、errorレベルの集計からは漏れていた。

| 件数 | 内容 |
|---|---|
| 13 | `opts.waitMs: Too big (≤60000)` |
| 11 | `opts.after: Too big (≤3)` |
| 5 | `opts.before/after: Too big (≤3)` |
| 2 | `start.maxPassages: Too big (≤50)` |
| 2 | `find.source/text: 型違い(object / undefined)` |
| 2 | `runId: 型違い(object)` |

件数では他のどのエラーよりも多く、そのたびに code の呼び直しが起きている(利用者の待ち時間とトークンの無駄)。

## 仮説

- 道具の説明文(`CODE_TOOL_DESCRIPTION`)が引数の上限・型を伝えきれていない(確度:中)。反証:説明文に上限を明記して再観測し、件数が減らなければ棄却。
- 上限超えを失敗でなく clamp + notices にすれば呼び直しが消える(確度:中)。`around` の `before/after` は `sandbox.ts` に clamp があるのに11件失敗しており、Zod の上限が先に弾いている可能性がある。反証:`boundary.ts` のスキーマを読む。

## 次の一手

`boundary.ts` を読んで、clamp より先に Zod が弾いているかを確かめる。合わせて、失敗した呼び出しの実引数(どんな値を渡していたか)をログに残せるか確認する。
