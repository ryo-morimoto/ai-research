# issues/

Cloudflare のログ分析などで見つけた改善対象を1件1ファイルで置く。ファイル名は `NNN-slug.md`。

## 構造

各ファイルは YAML フロントマターと、次の節を持つ。**解決策(改善案)は必須ではない**。原因が確かめられる前に解決策を書くと早すぎる収束を招くので、節を分けて推測と事実を混ぜない。

| 節 | 必須 | 書くこと |
|---|---|---|
| `## 観測` | ○ | 事実だけ。数字・期間・ログの文言・コードで確認したこと。推測を書かない |
| `## 仮説` | 任意 | 原因や対処の推測。確度(高/中/低)と、どう確かめる・反証するかを添える。複数あってよい |
| `## 次の一手` | ○ | 最小の次の行動。多くは仮説を確かめる調査や、測るためのログ追加。解決の実装とは限らない |

フロントマターの項目:

| 項目 | 型 | 意味 |
|---|---|---|
| `id` | number | ファイル名の NNN と同じ |
| `title` | string | 一行の要約 |
| `status` | `open` \| `investigating` \| `in-progress` \| `done` \| `wontfix` | 状態。原因調査中は `investigating` |
| `priority` | `high` \| `medium` \| `low` | 優先度 |
| `area` | string | 発生箇所(例 `hub/mcp`, `hub/run`, `hub/pdf`, `ops`) |
| `kind` | `bug` \| `observability` \| `ux` \| `noise` | 種別 |
| `cause_confirmed` | boolean | 原因を事実で確かめたか。false の間は解決の実装に入らない |
| `count` | number | 観測された件数(観測期間内) |
| `period_days` | number | 観測期間(日) |
| `source` | string | 数字の出どころ(例 `cf o11y telemetry query`) |
| `created` | date | 起票日 |

## 集計の例

```bash
# 状態×優先度の件数
grep -h -E '^(status|priority):' issues/0*.md | paste - - | sort | uniq -c
# 原因未確認のまま残っているもの
grep -l 'cause_confirmed: false' issues/0*.md
```
