# ai-research

調査にかかる時間を短くするためのシステム。どの機械・どの会話・どのアプリから依頼しても、同じ記憶・同じ手順・同じ道具で調べ、確かめた事実を出典の原文つきで残す。

- 調査の道具・記憶・手順は Cloudflare 上のハブ1か所に置き、リモート MCP で公開する
- 会話をしている Claude は、ハブの関数を呼ぶ短いコードを書くだけ（code mode）。重い作業と途中結果はハブの中に留まる
- 台帳には出典と原文の短い抜き書きだけが入る。書き込みは照合器だけが行う

## 文書

| 文書 | 中身 |
|---|---|
| [docs/01-requirements-and-constraints.md](docs/01-requirements-and-constraints.md) | やりたいことと制約（v0.5） |
| [docs/02-architecture.md](docs/02-architecture.md) | アーキテクチャと設計（v1.1） |
| [docs/03-detailed-design-and-verification.md](docs/03-detailed-design-and-verification.md) | 詳細設計と検証方法（stage2） |

## 構成

```text
packages/core         純粋な関数（正規化、照合、段落選び、規則、予算）。性質ベーステストの主な対象
packages/policy       版つきの方針（取得先ごとの制限、上限値、道具の説明文）
packages/hub          Worker：MCP の入口、RunDO・LedgerDO・HostLimiterDO・ConfigDO、取得の出口
packages/sandbox-api  code mode でモデルに見せる型
specs                 Quint の仕様（台帳、1つの調査、頻度制限）とわざと壊した版
bench                 計測（試験用の依頼セット、呼び出し器）
```

## 開発

```sh
pnpm install
pnpm check          # 依存の規則 + 型検査 + テスト
pnpm spec:check     # Quint の仕様をモデル検査（Java が必要）
```

性質ベーステストの回数とシードは `FC_RUNS` と `FC_SEED` で変えられる。

## ライセンス

[LICENSE](LICENSE)
