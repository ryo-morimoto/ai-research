# ai-research

調査にかかる時間を短くするためのシステム。どの機械・どの会話・どのアプリから依頼しても、同じ記憶・同じ手順・同じ道具で調べ、確かめた事実を出典の原文つきで残す。

- 調査の道具・記憶・手順は Cloudflare 上のハブ1か所に置き、リモート MCP で公開する
- 会話をしている Claude は、ハブの関数を呼ぶ短いコードを書くだけ（code mode）。重い作業と途中結果はハブの中に留まる
- 台帳には出典と原文の短い抜き書きだけが入る。書き込みは照合器だけが行う

## 文書

| 文書 | 中身 |
|---|---|
| [docs/01-requirements-and-constraints.md](docs/01-requirements-and-constraints.md) | やりたいことと制約（v0.8） |
| [docs/02-architecture.md](docs/02-architecture.md) | アーキテクチャと設計（v1.4） |
| [docs/03-detailed-design-and-verification.md](docs/03-detailed-design-and-verification.md) | 詳細設計と検証方法（stage2）。Known Unknowns の確認結果と、結合試験で見つかったこと（§4） |
| [docs/04-deploy-and-operations.md](docs/04-deploy-and-operations.md) | デプロイ、claude.ai への登録、運用、試験の動かし方 |

## 構成

```text
packages/core         純粋な関数（正規化、照合、段落選び、規則、予算）。性質ベーステストの主な対象
packages/policy       版つきの方針（取得先ごとの制限、上限値、道具の説明文）
packages/hub          Worker：MCP の入口と OAuth、RunDO・LedgerDO・HostLimiterDO、取得の出口。test/ に workerd 上の結合試験
packages/sandbox-api  code mode でモデルに見せる型
specs                 Quint の仕様（台帳、1つの調査、頻度制限）とわざと壊した版
bench                 計測（試験用の依頼セット、呼び出し器。M3）
```

## 状態

Cloudflare にデプロイし、claude.ai のカスタムコネクタとプラグインから使っている。設計 v1.4（論文の書誌と抄録、作業が尽きたら終わる、関連の絶対の下限、照合の状態の名前）まで実装した。計測は [docs/02](docs/02-architecture.md) §8.1.6・§8.2.9。

- 論文・研究の知見は `sources: ["scholarly", "web"]` で、Europe PMC と Crossref（キー不要）から書誌と抄録を引く。出版社のページが拒んだら URL の DOI に回る
- 照合の状態は「引用確認済」「照合失敗」「未照合」など。表すのは引用が原文にあるかだけで、主張の正しさではない

## 使い方（claude.ai のアカウントに3つ登録する）

1. カスタムコネクタ：`https://ai-research.ryo-morimoto-dev.workers.dev/mcp`（docs/04 §3）
2. プラグイン：Customize > Plugins > Add > Add marketplace で `ryo-morimoto/ai-research` を追加し、`ai-research` を入れる
3. Instructions for Claude に1行（docs/04 §3.1）

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
