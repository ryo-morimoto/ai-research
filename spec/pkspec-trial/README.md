# pkspec 導入試験（ADR-0001 M1）— 実施済み

2026-10-29、pkspec@0.4.2（公式リリース tarball、sha256 照合済み）で実施。スキーマ（pkl/）は
同じタグから vendoring した。

## 実施内容と結果

| 項目 | 結果 |
|---|---|
| Spec.pkl に5件（W-01・INV-8・Q-01・C-01・S-05）＋ Goal 3件 | 書けた（constraints.ts からの移植は機械的） |
| `pkspec check Spec.pkl Test.pkl` | **green**：「all 5 declared spec(s) have an implementation」 |
| 壊した変種（Spec-broken.pkl：実装のない approved spec を1件追加） | **exit 1**：「1 unimplemented spec(s) — 1 critical … ZZZ-999」。検査は実効 |
| `pkspec exec -f Test.pkl`（実装ポインタの grep 検査5件） | 5 passed |
| `pkspec coverage` | 5/5（severity・reviewStatus 別の内訳つき） |
| vitest への overlay（Adapter.pkl） | 記述済み。check に含めてもエラーなし。ただし **0.4.2 の CLI には adapter 実行サブコマンドがない**（README の main 版にはある）ので、vitest ケースへの接続の実行は将来の版待ち |

## 判定（全面移行するか）

- できること（check・coverage・orphans・goals・next・壊した変種の検出）は自作 mjs と同等以上。
- ただし現時点では移行しない：
  1. 0.4.2 は adapter 未搭載で、vitest のテスト名への接続（自作側は grep タグで実現済み）が実行できない
  2. 自作チェッカーが持つ「生成ビュー（docs/generated/）の一致検査」「verifiedOutsideRepo の区別」に相当する機能は pkspec の語彙にない
  3. API は変動中（README と配布版で CLI が既に違う）
- **再評価の条件**：pkspec が adapter 実行を安定版で出したとき。データ（spec/constraints.ts）は
  Scenario 互換のままなので、移行は機械的（このディレクトリの Spec.pkl がその証明）。

## 再実行のしかた

```sh
cd spec/pkspec-trial
pkspec check Spec.pkl Test.pkl          # green
pkspec check Spec-broken.pkl Test.pkl   # exit 1（空振りの防止）
pkspec exec -f Test.pkl
pkspec coverage Spec.pkl Test.pkl
```
