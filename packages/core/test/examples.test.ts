import { describe, expect, it } from "vitest";
import {
  normalize,
  matchQuote,
  verifyQuote,
  reverifyRecord,
  judgeRevalidation,
  planRevalidation,
  classifyVolatility,
  selectPassages,
  splitParagraphs,
  textHash,
  admit,
  advance,
} from "../src/index.ts";

const source = { kind: "web" as const, url: "https://example.com/a", locator: "https://example.com/a" };

describe("normalize", () => {
  it("全角英数字・全角空白・改行をそろえる", () => {
    expect(normalize("　ＡＢＣ　１２３\n\n次の行\t")).toBe("ABC 123 次の行");
  });
  it("ゼロ幅文字を除く", () => {
    expect(normalize("調​査")).toBe("調査");
  });
});

describe("matchQuote の3段", () => {
  const src = "Durable Objects は、名前ごとに世界で1つだけ動くインスタンスです。どこから来た要求も届きます。";
  it("完全一致", () => {
    const m = matchQuote("名前ごとに世界で1つだけ動く", src);
    expect(m.ok && m.kind).toBe("exact");
  });
  it("記号・空白の違いだけなら context", () => {
    const m = matchQuote("名前ごとに 世界で1つだけ動く インスタンス", src);
    expect(m.ok && m.kind).toBe("context");
  });
  it("少しの書き換えは fuzzy", () => {
    const m = matchQuote("名前ごとに世界で一つだけ動くインスタンスです", src);
    expect(m.ok && m.kind).toBe("fuzzy");
  });
  it("原文にない文は失敗", () => {
    const m = matchQuote("サーバーを複数台に分散して動かす", src);
    expect(m.ok).toBe(false);
  });
  it("長すぎる引用は失敗", () => {
    const m = matchQuote("あ".repeat(301), "あ".repeat(400));
    expect(m).toEqual({ ok: false, reason: "quote_too_long" });
  });
});

describe("verifyQuote は原文側の文字列を抜き書きにする", () => {
  it("書き換えた引用でも、保存されるのは原文の文字列", () => {
    const src = "台帳には、その回に取得した原文に文字どおりある抜き書きだけが入る。";
    const r = verifyQuote({
      quote: "台帳には その回に取得した原文に文字どおりある抜き書きだけが入る",
      sourceText: src,
      source,
      fingerprint: {},
      verifiedAt: "2026-10-24T00:00:00Z",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(normalize(src).includes(r.excerpt.excerpt)).toBe(true);
      expect(r.excerpt.excerpt).toContain("台帳には、その回");
    }
  });
});

describe("上書き試験の単体版（Q-06）", () => {
  it("会話の前提で書き換えた事実は保存されない", () => {
    const src = "arXiv の API は3秒に1回、同時接続1本までとする。";
    const overwritten = "arXiv の API は1秒に10回まで呼んでよい";
    const r = verifyQuote({ quote: overwritten, sourceText: src, source, fingerprint: {}, verifiedAt: "t" });
    expect(r.ok).toBe(false);
  });
});

describe("reverifyRecord（Q-02）", () => {
  it("出典が変わって抜き書きが消えたら確認済にならない", () => {
    const before = "最初の版：上限は60万トークン。";
    const after = "改訂版：上限は80万トークンに引き上げた。";
    const v = verifyQuote({ quote: "上限は60万トークン", sourceText: before, source, fingerprint: {}, verifiedAt: "t1" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = reverifyRecord({ ...v.excerpt, sourceText: after, verifiedAt: "t2" });
    expect(r.ok).toBe(false);
  });
  it("前後の文脈で位置を決め直せる", () => {
    const before = "A。上限は、60万トークン。B。上限は60万トークン（別）。";
    const v = verifyQuote({ quote: "上限は、60万トークン", sourceText: before, source, fingerprint: {}, verifiedAt: "t1" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = reverifyRecord({ ...v.excerpt, sourceText: before, verifiedAt: "t2" });
    expect(r.ok && r.excerpt.excerpt).toBe("上限は、60万トークン");
  });
});

describe("照らし直しの規則", () => {
  it("確かめ方", () => {
    expect(planRevalidation("github", "normal")).toBe("github-commit");
    expect(planRevalidation("arxiv", "stable")).toBe("arxiv-version");
    expect(planRevalidation("web", "normal")).toBe("conditional-get");
    expect(planRevalidation("web", "volatile")).toBe("always-fetch");
  });
  it("判定", () => {
    expect(judgeRevalidation({ commit: "a" }, { method: "github-commit", commit: "a" })).toBe("unchanged");
    expect(judgeRevalidation({ commit: "a" }, { method: "github-commit", commit: "b" })).toBe("changed");
    expect(judgeRevalidation({ etag: "x" }, { method: "conditional-get", status: 304 })).toBe("unchanged");
    expect(judgeRevalidation({ textHash: "h" }, { method: "conditional-get", status: 200, textHash: "h" })).toBe("unchanged");
    expect(judgeRevalidation({}, { method: "always-fetch", textHash: "h" })).toBe("changed");
  });
});

describe("変わりやすさ", () => {
  it("規則", () => {
    expect(classifyVolatility({ kind: "arxiv", url: "https://arxiv.org/abs/1", excerpt: "x" })).toBe("stable");
    expect(classifyVolatility({ kind: "web", url: "https://x.com/pricing", excerpt: "x" })).toBe("volatile");
    expect(classifyVolatility({ kind: "web", url: "https://x.com/doc", excerpt: "現在の最新版は 3.2" })).toBe("volatile");
  });
});

describe("段落選び", () => {
  it("問いに関係する段落を上位に選ぶ", () => {
    const ps = [
      ...splitParagraphs("a", "Durable Objects はストレージを持つ。\n\n天気の話。"),
      ...splitParagraphs("b", "頻度制限は全機械の合計で守る。\n\n関係のない話。"),
    ];
    const out = selectPassages(ps, ["頻度制限", "全機械"]);
    expect(out[0]?.text).toContain("頻度制限");
  });
});

describe("textHash", () => {
  it("正規化後が同じなら同じハッシュ", async () => {
    expect(await textHash("ＡＢＣ  def")).toBe(await textHash("ABC def"));
  });
});

describe("予算", () => {
  it("上限で止まり、上の段階に進むと再開する", () => {
    let st = { used: 0, phase: "first" as const, stopped: false };
    const a = admit(st, 150_000);
    expect(a.allowed).toBe(100_000);
    expect(a.stop).toBe(true);
    const next = advance(a.state, "continue");
    expect(next.stopped).toBe(false);
    st = { ...next, phase: "first" } as typeof st;
  });
});
