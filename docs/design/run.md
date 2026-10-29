# 設計：調査の実行（RunDO と code mode の API）

（現在形。API 変更の経緯は adr/archive/02 §8.1〜8.4。形式仕様は specs/run.qnt、境界は packages/hub/src/boundary.ts）

## API（モデルに見せる型）

正は `packages/sandbox-api`（型と `sandboxTypes()`）。説明文に埋め込む上限値は policy の `INPUT_BOUNDS` から導出する。要点：

- `research.start({ question, mode, sources?, queries?, urls?, waitMs?, maxPassages?, … })` — mode は `lookup`（1つの事実。urls があれば検索しない）か `survey`（調べる。続きあり）。
- `next` / `steer` / `deepen` / `around` / `find` / `verify` / `close` / `help`。
- 失敗は値（HubError: busy / run_not_found / bad_input / internal ＋ next）で返す（P-05）。
- **数値の超過は拒まず丸めて `clamped` で知らせる**（waitMs・maxPassages・before/after・limit）。拒むのは型・形の誤りだけ（issue 002）。

## 依頼の種類（mode、D9）

| | lookup | survey |
|---|---|---|
| 台帳 | 先に見る。3件まで | 5件まで |
| 取得 | urls があればそれだけ | 検索＋urls |
| 段落 | 5件まで | 12件まで |
| 最初の束 | 15秒 | 25秒 |
| 続き | 集めない | 作業が尽きるか4分（W-04）。`deepen` で延長 |

## 束（Bundle）

- 出典は `sources` に1回だけ置き、段落・台帳の候補は sourceId で指す。問いの文は繰り返さない。
- `pending`（まだ集めている）と `cutoffs`（確定した喪失）を区別する（Q-04、INV-8）。打ち切りの理由は CUTOFF_REASONS（sandbox-api）で列挙。
- `progress`（searched/found/fetched/failed/running）と `done`（作業の状態で決める。D15）。
- 0件は `{ kind: "empty", why, next }`。経路外に出てよいのは all_failed / search_failed のときだけ。
- `procedure`（手順の版）。説明文の版と違えば `research.help()`（U-05）。

## 方向転換と版（INV-10）

すべての非同期作業に問いの版 v を付ける。steer で v を上げ、古い v の作業は止める（結果は混ぜない。照合できた抜き書きは台帳に入れてよい）。取得済みの原文は新しい版で使い回す。

## 照合（verify）

- 引用は、引いた段落の中でだけ照合する。完全一致 → 前後の文脈 → あいまい一致（閾値 0.9）。数の並び・否定の語が違えば通さない（marker_mismatch）。
- 状態は「引用が原文にあるか」だけを表す：引用確認済 / 引用確認済（表記差あり）/ 照合失敗（reason と nearest）/ 未照合（Q-01）。失敗には理由ごとの次の手（VERIFY_NEXT）。
- 照合できた抜き書きだけが台帳に入る（INV-1、INV-5。ledger.md）。

## 予算（R-01、INV-9）

数えるのはハブが会話に返した量と照合で受け取った量。段階（first 10万 / continue 60万 / deep 140万）の上限を超える束は切り詰め、`budget_stopped` で止める。

## 保存と退避（INV-13）

原文の全文と段落の本文はメモリだけ。ストレージには meta（問い・版・予算・段落のメタデータ・ID の払い出し）と実行記録。退避で全文を失ったら、段落のメタデータの URL から取り直す。

## 不変条件

run に関わるのは INV-5・8・9・10・11・13・14（一覧と検査は docs/generated/SPEC.md）。specs/run.qnt のモデルと、わざと壊した変種（check-specs.mjs）で空振りを防ぐ。
