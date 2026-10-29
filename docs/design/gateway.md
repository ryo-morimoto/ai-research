# 設計：取得の出口（Gateway）・論文・頻度制限

（現在形。経路の判断の経緯は adr/archive/02 §8.2.2・§8.3.4）

## 取得と原文の塊（D10）

要約を挟まない取得（Web は本文抽出、GitHub は raw、arXiv は HTML→PDF）。原文は型つきの塊（文・箇条・表の行・見出し・コード・メタデータ・参考文献）にし、段落の候補は文として読める塊だけ。見出し・表の見出し行・導入の文は `context` に添える（照合の対象は text だけ）。

## 論文（D13、Q-08）

- `work` は書誌（著者・年・誌名・DOI）と抄録を持つ出典の種類。URL は `https://doi.org/<DOI>` に正規化。
- 抄録は Europe PMC → Crossref → OpenAlex → Semantic Scholar の順（同じ入力から同じ塊）。取れなければ `abstract: false`（「書誌のみ」の根拠）。
- 公開の版（本文）は PMC → Europe PMC のリンク → Unpaywall → OpenAlex → Semantic Scholar の順に、1論文2候補まで。読む論文は lookup 1件 / survey 3件。補うのは上位4件（関連の下限を先に当てる）。
- PDF は unpdf で文字を取り出す（10MB・60ページ・5秒まで。超えたら unsupported）。
- 出版社のページが拒んだら、URL の DOI から書誌・抄録に取り直す。取れなかったページの URL は経路の受け口へ（経路外で読める）。

## 出典の種類（tier）と順位

paper > official > encyclopedia > other の重みを段落の順位に掛ける（「一次資料を優先」を仕組みで持つ）。保存せず URL と kind から決める（policy の sourceTiers）。

## 頻度制限（HostLimiterDO、E-02、INV-6/7）

取得先ホストごとに許可証（minIntervalMs・maxConcurrent・leaseTtlMs 60秒）。全機械・全会話の合計で守る。429・503 は Retry-After（なければ30秒、上限5分）の冷却をホスト全体に効かせる。順番待ちは取得の時間上限（8秒）に数えない（別上限 leaseWaitMs 60秒）。同じ実行で失敗した URL は再取得しない（INV-14）。値の正は policy の hosts 表。
