---
name: ai-research-first
description: 調べもの・事実確認・論文や研究の知見と数値の確認・最新情報や仕様や料金の確認・URL の中身の確認をするとき（記憶で答えられそうでも）、頼まれていなくても WebSearch / WebFetch / web_search / web_fetch より先に、ai-research コネクタの code で調べる。
---

# 調べものは ai-research を通す

ai-research の `code` 道具を使う（遅延読み込みなら、ツール検索で `ai-research` を探して読み込む）。手順・API・結果の書き方は、その道具の説明文に従う。

ai-research が使えないとき・利用者がウェブ検索を明示したときだけ、組み込みの道具で調べ、答えの最後に1行「経路外（理由）」と書く。
