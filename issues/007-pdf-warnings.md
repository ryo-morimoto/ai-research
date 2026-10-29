---
id: 7
title: PDF 解析の警告(pdf.js)
status: open
priority: low
area: hub/pdf
kind: noise
cause_confirmed: true
count: 12
period_days: 30
source: cf o11y telemetry query
created: 2026-10-29
---

# PDF 解析の警告(pdf.js)

## 観測

直近30日の warnレベルは全て pdf.js の警告(計12件)。

| 件数 | 内容 |
|---|---|
| 5 | `TT: undefined function: 32` |
| 3 | `getTextContent - ignoring XObject: "FormatError: XObject should be a stream"` |
| 1 | `UnknownErrorException: Ensure that the standardFontDataUrl API parameter is provided.` |
| 1 | `Type3 font resource "N" is not available.` |
| 1 | `Indexing all PDF objects` |
| 1 | `Required "glyf" table is not found -- trying to recover.` |

大半は壊れた・珍しい PDF への警告で、抽出は続いている。`standardFontDataUrl` だけは設定不足。

## 次の一手

- `pdf.ts` で `standardFontDataUrl` を指定する(これは設定不足と確認済みで、設定で解消できる)。
- 残りは壊れた・珍しい PDF への警告で抽出は続いている。実害(本文が取れなかったか)が出たときに個別に見る。
