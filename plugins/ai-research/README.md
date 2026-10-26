# ai-research プラグイン

調べものを、利用者自身の調査ハブ ai-research（claude.ai のカスタムコネクタ）に通すためのプラグイン。設計は [docs/02 §7.4〜7.8・§8.3](https://github.com/ryo-morimoto/ai-research/blob/main/docs/02-architecture.md)、制約は [docs/01 の U-03・Q-07・E-05・U-05](https://github.com/ryo-morimoto/ai-research/blob/main/docs/01-requirements-and-constraints.md)。

## 入れ方

claude.ai（またはデスクトップアプリ）の **Customize > Plugins > Add > Add marketplace** で `ryo-morimoto/ai-research` を追加し、`ai-research` を入れる。アカウントに保存され、Claude Code にも同期される。

Claude Code だけで試すなら：

```text
/plugin install ai-research --marketplace ryo-morimoto/ai-research
```

（コマンドラインで入れたプラグインはその機械に留まり、アカウントには入らない）

前提：ai-research のカスタムコネクタを claude.ai に登録してあること（[docs/04 §3](https://github.com/ryo-morimoto/ai-research/blob/main/docs/04-deploy-and-operations.md)）。

## 版

| プラグイン | ハブ（方針の版） | 変わったこと |
|---|---|---|
| 0.4.0 | 2026-10-26.1 以降（2026-10-26.2 で束に手順の版と help を足した。プラグインは同じ） | フックが版を送る（古い版はハブが更新を知らせる）。PostToolUse はツール検索だけ |
| 0.3.0 | 2026-10-25.1 | スキルの説明文に、論文・研究の知見と数値の確認を足した |

ハブは 0.4.0 より古いプラグイン（版の情報を送らないもの）を見つけると、その会話で1回だけ「更新してください」と知らせる。手順と結果の書き方はハブの code 道具の説明文にあるので、プラグインが古くても手順は古くならない。ただし説明文は会話の始めに読まれる。会話の途中でハブが変わったときは、束の `procedure` が説明文の版と違うことで分かり、`research.help()` で今の手順を読める（新しい会話を始めても同じ）。

## 中身

| 部品 | 効く面 | すること |
|---|---|---|
| スキル `ai-research-first` | すべて（チャット、Cowork、Claude Code） | 調べものをするとき、WebSearch / WebFetch より先に ai-research を使う手順と、経路外の書き方 |
| フック（http） | Claude Code、Cowork（チャットでは動かない） | 組み込みの WebSearch / WebFetch を呼ぶ前にハブに問い合わせ、止めるか通すかをハブが決める。ツール検索で ai-research が見つからなかった会話では、組み込みの道具を通す |

## プライバシー（ハブに送るもの）

フックは、利用者自身の Cloudflare 上のハブ（`https://ai-research.ryo-morimoto-dev.workers.dev/hooks/…`）にだけ送る。第三者には送らない。

送るものは Claude Code のフックの入力そのもの（http のフックは、送る項目を選べない）。ハブは用途に要るものだけを使い、残りは残さずに捨てる。

| フック | 何のために | 送るもの | ハブが残すもの |
|---|---|---|---|
| UserPromptSubmit | その回の依頼がウェブ検索を明示したかを判定する。プラグインの版を確かめる | 会話の ID、依頼文、プラグインの版（見出し） | 明示の印（1時間で消える）。明示と判定したときは、当たった規則の番号と語句（40字まで。依頼文の全体は残さない）を最新200件まで。プラグインの版ごとの日々の回数。更新を知らせた会話の ID（24時間） |
| PreToolUse（WebSearch / WebFetch のときだけ） | 止めるか通すかを決める | 会話の ID、道具の名前、検索語または URL、プラグインの版 | 日ごとの回数だけ |
| PostToolUse（ToolSearch のときだけ） | その会話で ai-research の道具が見つかったかを知る（見つからない会話では組み込みの道具を通すため） | 会話の ID、検索の語、ツール検索の結果（その会話で使える道具の名前の一覧）、プラグインの版 | 「この会話では ai-research が見つからない」の印（1時間で消える）。道具の一覧は残さない |

0.3.0 までは、PostToolUse が ai-research の道具の結果（調査の束）も送っていた。ハブは道具の名前しか使わず、残さずに捨てていたが、0.4.0 で送らないようにした。

残したものは `route_stats` の道具で見られる。

ハブに届かないとき・ハブが 2xx 以外を返したとき、フックは止めない（組み込みの道具がそのまま動く）。
