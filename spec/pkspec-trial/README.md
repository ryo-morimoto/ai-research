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
| vitest への overlay（Adapter.pkl） | **接続を検証し、実行した。** (1) 同梱シム `pkspec-adapter-vitest discover` が返す実ケース ID（形式 `file::テスト名`）と overlay の4鍵が完全一致（hub 3鍵は discover 出力との grep 照合、core 1鍵は `vitest list` との照合）。(2) `pkspec-adapter-vitest run --manifest …` で4鍵すべての実 vitest ケースを実行し、JSONL で `outcome: "passed"`（W-01 5.3s・INV-8 5.9s・C-01 5.1s・Q-01 0.8s）。なお `pkspec` 本体の CLI には adapter サブコマンドがなく（main の README が先行）、**core パッケージでは discover がコアダンプで落ちる**（run は動く）— experimental の不安定さの実測 |

## 判定（全面移行するか）

- できること（check・coverage・壊した変種の検出・シム経由の vitest 実行）は自作 mjs と同等以上。
- ただし現時点では移行しない：
  1. adapter は本体 CLI 未統合で、シムを手で呼ぶ必要がある。core では discover がコアダンプ（experimental）
  2. 自作チェッカーが持つ「生成ビュー（docs/generated/）の一致検査」「verifiedOutsideRepo の区別」に相当する機能は pkspec の語彙にない
  3. API は変動中（README と配布版で CLI が既に違う）
- **再評価の条件**：adapter が本体 CLI に統合された安定版が出て、discover のクラッシュが直ったとき。
  データ（spec/constraints.ts）は Scenario 互換のままなので、移行は機械的（このディレクトリの Spec.pkl がその証明）。

## 再実行のしかた

```sh
cd spec/pkspec-trial
pkspec check Spec.pkl Test.pkl          # green
pkspec check Spec-broken.pkl Test.pkl   # exit 1（空振りの防止）
pkspec exec -f Test.pkl
pkspec coverage Spec.pkl Test.pkl

# overlay の鍵の照合と実行（シムを直接呼ぶ。manifest は discover の selector をそのまま使う）
cd ../../packages/hub
pkspec-adapter-vitest discover | grep -c "test/run.test.ts::W-01・P-01"   # 1 なら鍵が実在
pkspec-adapter-vitest run --manifest <discover の cases から作った JSON>   # caseFinish: passed
```
