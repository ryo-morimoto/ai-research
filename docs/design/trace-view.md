# 設計：調査の記録（TraceDO）と View

（現在形。画面の詳細・実機確認・T0〜T2 の経緯は adr/archive/05）

## 目的

(1) 向きのずれに早く気づく（実行中の調査の概念と出典を見る）、(2) 取りこぼしの偏り（打ち切り・照合失敗のホスト・tier・手順の版ごとの数）を見て方針を直す。**トークンを使うのは開く1回だけ**（V-01）。

## 構造

```
書く道（締め切りの外）: RunDO ──事象（waitUntil、失敗しても調査は失敗しない。C-03）──▶ TraceDO
開く（モデルを通る1回）: research_view ──▶ 会話の中の View（MCP Apps）
見る道（モデルの外）  : View ──trace_read（app 専用）──▶ TraceDO
```

- 事象の型と整形は core/src/trace.ts。**欄の定義は SCHEMA 1か所**（必須は `!`）で、TraceEvent 型と機械的に一致する。段落の本文の欄を持たない（C-04）。
- TraceDO は1人に1つ。追記のみ・墓標・保持90日（C-08、C-10）。
- モデルに見える追加は `research_view` 1つだけ（C-01）。View は依存ゼロ・textContent のみ・モデルへ書き戻さない（C-09、C-11）。
- ずれの印（drift.ts）：検索語の集合から概念をまとめ（Jaccard 0.5）、未到達・外れを規則で付ける。LLM を使わない（C-02）。
- 見る道の依存は check-deps の規則4（trace 経路の import 許可リストと fetch 禁止）で固定する（V-01）。
