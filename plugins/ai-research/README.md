# ai-research プラグイン

調べものを、利用者自身の調査ハブ ai-research（claude.ai のカスタムコネクタ）に通すためのプラグイン。設計は [docs/02 §7.4〜7.8](../../docs/02-architecture.md)、制約は [docs/01 の U-03・Q-07](../../docs/01-requirements-and-constraints.md)。

## 入れ方

claude.ai（またはデスクトップアプリ）の **Customize > Plugins > Add > Add marketplace** で `ryo-morimoto/ai-research` を追加し、`ai-research` を入れる。アカウントに保存され、Claude Code にも同期される。

Claude Code だけで試すなら：

```text
/plugin install ai-research --marketplace ryo-morimoto/ai-research
```

（コマンドラインで入れたプラグインはその機械に留まり、アカウントには入らない）

前提：ai-research のカスタムコネクタを claude.ai に登録してあること（docs/04 §3）。

## 中身

| 部品 | 効く面 | すること |
|---|---|---|
| スキル `ai-research-first` | すべて（チャット、Cowork、Claude Code） | 調べものをするとき、WebSearch / WebFetch より先に ai-research を使う手順と、経路外の書き方 |
| フック（http） | Claude Code、Cowork（チャットでは動かない） | 組み込みの WebSearch / WebFetch を呼ぶ前にハブに問い合わせ、止めるか通すかをハブが決める |

## プライバシー（ハブに送るもの）

フックは、利用者自身の Cloudflare 上のハブ（`https://ai-research.ryo-morimoto-dev.workers.dev/hooks/…`）にだけ送る。第三者には送らない。

| フック | 送るもの（Claude Code のフックの入力） | ハブが残すもの |
|---|---|---|
| UserPromptSubmit | 会話の ID、依頼文 | 「その回の依頼がウェブ検索を明示したか」の印だけ（1時間で消える）。依頼文は残さない |
| PreToolUse（WebSearch / WebFetch のときだけ） | 会話の ID、道具の名前、検索語または URL | 日ごとの回数だけ |

ハブに届かないとき・ハブが 2xx 以外を返したとき、フックは止めない（組み込みの道具がそのまま動く）。
