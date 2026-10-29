# 検査のカバレッジ（生成物）

手で編集しない（scripts/check-constraints.mjs が生成）。

- 登録: 72 件（MUST/MUST NOT 68、SHOULD 4）
- 機械検査あり: 60 / 72。運用で確かめる: 8。draft: 2

## 機械検査がない approved（本来ここは空であるべき）

| ID | 強さ | 検査 |
|---|---|---|
| S-04 | SHOULD | measure: 依頼の種類ごとの応答開始時間 |
| R-02 | SHOULD | manual: 点検表：保守が要る常駐プロセス0 |
| V-08 | SHOULD | manual: 実機確認 |

## 運用で確かめる（repo の CI では判定しない。verifiedOutsideRepo）

| ID | 確かめ方 |
|---|---|
| P-03 | manual: 点検表：読み取りの道具に承認が要らない設定（各アプリの権限設定） |
| P-04 | manual: 説明文の指示（PROCEDURE）。呼び出し器での半自動試験は未着手 |
| Q-05 | manual: 棚卸し（docs/design/architecture.md の表）と2台試験 |
| U-01 | manual: 点検表：新しい機械で行う作業が0件（登録手順は docs/runbook.md） |
| E-04 | manual: 送信内容の記録（outbound_log）の点検 |
| V-06 | manual: TraceDO は1人に1つ（設計で満たす）。実機確認済 2026-10-26 |
| V-07 | manual: 実機確認済（2026-10-26）<br>file: packages/view/test/view.test.ts（幅 375px の描画試験） |
| C-07 | manual: 点検表 |

## draft（検査が未整備。approved に上げるには機械検査が要る）

| ID | 問い |
|---|---|
| S-02 | 機械検査がない。RunDO の状態保持の試験に ID を付けるか、bench に入れてから approved にする |
| S-03 | 機械検査がない。gateway の経路選択の試験に ID を付けてから approved にする |

## 弱い検査（ファイルの実在のみ。ID タグを付ければ grep に上げられる）

| ID | 対象 |
|---|---|
| W-02 | packages/hub/test/run.test.ts |
| W-03 | packages/hub/test/ledger.test.ts |
| S-01 | packages/core/test/properties.test.ts |
| S-05 | bench/run_cases.py |
| P-01 | packages/hub/test/run.test.ts、specs/run.qnt |
| P-02 | packages/hub/test/gateway.test.ts |
| Q-01 | packages/core/test/properties.test.ts |
| Q-03 | scripts/check-deps.mjs、specs/ledger.qnt |
| U-02 | packages/hub/test/ledger.test.ts |
| E-02 | specs/limiter.qnt |
| E-03 | packages/view/test/view.test.ts |
| E-05 | plugins/ai-research/README.md |
| R-01 | packages/core/test/properties.test.ts |
| V-07 | packages/view/test/view.test.ts |
| V-09 | packages/hub/test/tracedo.test.ts |
| C-05 | packages/hub/test/mcp.test.ts |
| INV-5 | packages/hub/test/run.test.ts |

## 計測が要るもの（measure）

| ID | 計測 |
|---|---|
| W-01 | bench: 最初の結果まで P95 60秒 |
| W-03 | 2台試験 |
| S-01 | ステップ数に対する時間の推移 |
| S-02 | 休憩後の最初の応答時間 |
| S-03 | 出典種別ごとの取得時間 |
| S-04 | 依頼の種類ごとの応答開始時間 |
| S-05 | 長い会話と新しい会話の差 10秒以内【要計測】 |
| S-06 | bench: 依頼セットの流入量と精度（目標 1,500 以下【要計測】） |
| Q-08 | 学術の依頼セット：一次資料に届いた割合 80% 以上【要計測】 |
| U-03 | 経路率：強制できる面 100%、チャット 90% 以上【値は要計測】 |
| U-04 | bench: 依頼の種類ごとの呼び出し回数と答えの長さ |

## 未決の問い（openQuestions）

| ID | 問い |
|---|---|
| S-02 | 機械検査がない。RunDO の状態保持の試験に ID を付けるか、bench に入れてから approved にする
| S-03 | 機械検査がない。gateway の経路選択の試験に ID を付けてから approved にする
| S-05 | 目標値 10秒の妥当性は未計測。テストに S-05 の ID タグがない
| Q-01 | 「経路外（…）」等のラベル文字列はまだ複数箇所に直書き（policy の LABELS への一元化は未実施）
