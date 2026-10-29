# ai-research

調査にかかる時間を短くするためのシステム。どの機械・どの会話・どのアプリから依頼しても、同じ記憶・同じ手順・同じ道具で調べ、確かめた事実を出典の原文つきで残す。

- 調査の道具・記憶・手順は Cloudflare 上のハブ1か所に置き、リモート MCP で公開する
- 会話をしている Claude は、ハブの関数を呼ぶ短いコードを書くだけ（code mode）。重い作業と途中結果はハブの中に留まる
- 台帳には出典と原文の短い抜き書きだけが入る。書き込みは照合器だけが行う

## 文書

地図は [docs/README.md](docs/README.md)。定義は「正・注釈・ビュー」に分かれる（[docs/adr/0001](docs/adr/0001-definition-management.md)）。

| 文書 | 中身 |
|---|---|
| [docs/product.md](docs/product.md) | やりたいこと・成功の物差し・制約どうしの緊張関係 |
| [spec/constraints.ts](spec/constraints.ts) | **制約の台帳（正）**：全 ID・強さ・検査への参照。`pnpm check` が照合する |
| [docs/generated/SPEC.md](docs/generated/SPEC.md) | 制約の一覧（生成物） / [coverage.md](docs/generated/coverage.md) は未検査の棚卸し |
| [docs/design/](docs/design/architecture.md) | 部品ごとの設計（現在形）：architecture・run・ledger・gateway・route・trace-view |
| [docs/runbook.md](docs/runbook.md) | デプロイ、claude.ai への登録、運用、試験の動かし方 |
| [docs/adr/](docs/adr/0001-definition-management.md) | 決定の記録。`archive/` に旧 01〜05 の全文（経緯） |

## 構成

```text
packages/core         純粋な関数（正規化、照合、段落選び、規則、予算、記録の整形）。性質ベーステストの主な対象
packages/policy       版つきの方針（取得先ごとの制限、上限値、道具の説明文）
packages/hub          Worker：MCP の入口と OAuth、RunDO・LedgerDO・HostLimiterDO・RouteDO・TraceDO、取得の出口。test/ に workerd 上の結合試験
packages/sandbox-api  code mode でモデルに見せる型
packages/view         会話の中の View（MCP Apps の1枚の HTML。何にも依存しない）
spec                  制約の台帳（constraints.ts。正）
specs                 Quint の仕様（台帳、1つの調査、頻度制限）とわざと壊した版
bench                 計測（試験用の依頼セット、呼び出し器。M3）
```

## 状態

Cloudflare にデプロイし、claude.ai のカスタムコネクタとプラグインから使っている。設計 v1.5（進行中と喪失の区別、段落が選ばれない出典の find、論文の PDF と公開の版、拒まれたときの冷却、フックの送るものの最小化と版の検知、結果のラベル）まで実装した。計測は [docs/adr/archive/02](docs/adr/archive/02-architecture.md) §8.1.6・§8.2.9・§8.3.10。

- 論文・研究の知見は `sources: ["scholarly", "web"]` で、Europe PMC・Crossref・OpenAlex・Semantic Scholar から書誌と抄録を引き、公開の版（PDF を含む）があれば本文も読む。出版社のページが拒んだら URL の DOI に回る
- 結果のラベルは「引用確認済・種類」「書誌のみ」「未照合」「背景知識」「経路外（理由）」。表すのは引用が原文にあるかだけで、主張の正しさではない
- プラグインのフックが送るものと残すものは [plugins/ai-research/README.md](plugins/ai-research/README.md) の表に書いた

## 使い方（claude.ai のアカウントに3つ登録する）

1. カスタムコネクタ：`https://ai-research.ryo-morimoto-dev.workers.dev/mcp`（docs/runbook.md §3）
2. プラグイン：Customize > Plugins > Add > Add marketplace で `ryo-morimoto/ai-research` を追加し、`ai-research` を入れる
3. Instructions for Claude に1行（docs/runbook.md §3.1）

## 開発

```sh
pnpm install
pnpm check                     # 依存の規則 + 型検査 + 単体・性質・結合の試験
pnpm spec:check                # Quint の仕様をシミュレーションで検査
SPEC_MODE=full pnpm spec:check # Apalache のモデル検査も（Java 17 以上が必要）
```

性質ベーステストの回数とシードは `FC_RUNS` と `FC_SEED` で変えられる。

会話の側が払う量（会話に入ったトークン、段落の数、呼び出しの回数）は、依頼セットを Claude Code で実行して測る：

```sh
python3 -I bench/run_cases.py bench/cases/feedback-2026-10-24.json --mcp-config <トークン入りの MCP 設定> --plugin-dir plugins/ai-research --label <名前>
python3 -I bench/run_cases.py bench/cases/scholarly-2026-10-25.json ...   # 論文の知見（Q-08）
```

## ライセンス

[LICENSE](LICENSE)
