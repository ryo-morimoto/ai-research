import { describe, expect, it } from "vitest";
import { blocksFromMarkdown, candidateParagraphs } from "../src/index.ts";

describe("blocksFromMarkdown（設計 v1.3 D10）", () => {
  it("フロントマターは日付の項目だけメタデータにし、残りは捨てる", () => {
    const b = blocksFromMarkdown("---\ntitle: Limits\npcx_content_type: concept\nupdated: 2026-09-30\n---\n\n本文の文。");
    expect(b).toEqual([
      { kind: "meta", text: "updated: 2026-09-30" },
      { kind: "prose", text: "本文の文。" },
    ]);
  });

  it("表の行は1行ずつの塊にし、見出しと見出し行を context に持つ。<br> と | は表示の形にする", () => {
    const md = "## Worker limits\n\n| Feature | Workers Free | Workers Paid |\n| --- | --- | --- |\n| CPU time | 10 ms | 5 min<br>(default 30 s) |\n| Memory | 128 MB | 128 MB |";
    const rows = blocksFromMarkdown(md).filter((x) => x.kind === "row");
    expect(rows).toEqual([
      { kind: "row", text: "CPU time | 10 ms | 5 min (default 30 s)", context: "Worker limits — Feature | Workers Free | Workers Paid" },
      { kind: "row", text: "Memory | 128 MB | 128 MB", context: "Worker limits — Feature | Workers Free | Workers Paid" },
    ]);
  });

  it("箇条は1項目ずつ（長い箇条が1つの段落にまとまって切れない）。リンクは文字だけ、タグだけの行は捨てる", () => {
    const md = "## principles\n\n<details>\n<summary>all</summary>\n\n- **Fix Root Causes.** Debugging. Trace each symptom back.\n- **Prove It Works.** Verify against the [real artifact](./x.md).\n  continued line.\n\n</details>";
    const items = blocksFromMarkdown(md).filter((x) => x.kind === "item");
    expect(items.map((x) => x.text)).toEqual([
      "Fix Root Causes. Debugging. Trace each symptom back.",
      "Prove It Works. Verify against the real artifact. continued line.",
    ]);
    expect(items[0]!.context).toBe("principles");
  });

  it("見出し・コードは段落の候補にしない。記号だけの塊も候補にしない", () => {
    const blocks = blocksFromMarkdown("# CPU time (ms)\n\n```json\n{\"@context\": \"https://schema.org\"}\n```\n\n---\n\n本文。");
    const c = candidateParagraphs("s1", blocks);
    expect(c.map((x) => x.text)).toEqual(["本文。"]);
    // index は塊の位置（取り直しても同じ）
    expect(c[0]!.index).toBe(blocks.findIndex((x) => x.text === "本文。"));
  });
});

import { markReferences, isReferenceHeading, looksLikeCitation, coverage, selectPassages } from "../src/index.ts";
import fc from "fast-check";

describe("参考文献の塊（設計 v1.4 §8.2.3）", () => {
  it("参考文献・脚注・関連項目・外部リンクの節の中は ref にする。次の節で戻る", () => {
    const out = markReferences([
      { kind: "heading", text: "Findings" },
      { kind: "prose", text: "Deliberative mindsets are open-minded.", context: "Findings" },
      { kind: "heading", text: "7 References[edit]" },
      { kind: "item", text: "Some reference without the usual shape" },
      { kind: "heading", text: "参考文献" },
      { kind: "prose", text: "本の名前" },
      { kind: "heading", text: "Discussion" },
      { kind: "prose", text: "Back to content." },
    ]);
    expect(out.map((b) => b.kind)).toEqual(["heading", "prose", "heading", "ref", "heading", "ref", "heading", "prose"]);
  });

  it("見出しの名前の判定（節番号・編集の印・コロンを除いて比べる）", () => {
    for (const h of ["References", "REFERENCES", "See also", "External links", "Further reading", "Notes", "脚注", "関連項目", "外部リンク", "2. Bibliography:"]) {
      expect(isReferenceHeading(h), h).toBe(true);
    }
    for (const h of ["Reference architecture for agents", "Notes on the method", "Results"]) expect(isReferenceHeading(h), h).toBe(false);
  });

  it("著者, 頭文字. (年). の並びは、どの節にあっても ref。本文の中の引用は当てない", () => {
    expect(looksLikeCitation("Gollwitzer, P. M., & Bayer, U. (1999). Deliberative versus implemental mindsets in the control of action.")).toBe(true);
    expect(looksLikeCitation("^ Gilbert, D. T. (1991). How mental systems believe. American Psychologist, 46, 107–119.")).toBe(true);
    expect(looksLikeCitation("Gollwitzer (1990) showed that deliberative mindsets are open-minded.")).toBe(false);
    expect(looksLikeCitation("Taylor and Gollwitzer (1995) demonstrated that the implemental mindset produces optimism.")).toBe(false);
    const [b] = markReferences([{ kind: "item", text: "Kluger, A. N., & DeNisi, A. (1996). The effects of feedback interventions on performance." }]);
    expect(b!.kind).toBe("ref");
  });
});

describe("関連の絶対の下限（被覆率、設計 v1.4 §8.2.3）", () => {
  const q = ["Gollwitzer の熟慮マインドセットと実行マインドセットの研究", "Gollwitzer deliberative implemental mindsets Heckhausen 1990"];
  it("別の話題の抜き書きは下限に届かない。関係のある文は届く。複数形の s はそろえる", () => {
    expect(coverage("suggests that FIs improved performance on average (d =.41) but that over 1/3 of the FIs decreased performance", q)).toBeLessThan(0.34);
    expect(coverage("can also produce correct and logical responses without relying on the slower, more deliberative processing", q)).toBeLessThan(0.34);
    expect(coverage("How can I increase my downloads?", q)).toBe(0);
    expect(coverage("Second, memory. Taylor and Gollwitzer (1995) demonstrated that the implemental mindset produces optimistic self-views.", q)).toBeGreaterThanOrEqual(0.34);
    expect(coverage("実行マインドセットでは情報の処理が選択的になる", ["熟慮マインドセット 実行マインドセット"])).toBeGreaterThanOrEqual(0.34);
  });

  it("ひらがなだけの語と英語の機能語は分母に入れない", () => {
    expect(coverage("について", ["について の"])).toBe(0);
    expect(coverage("the of and", ["the of and"])).toBe(0);
  });

  it("性質：0〜1。問いをそのまま含む文は 1", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ maxLength: 80 }), (query, text) => {
        const c = coverage(text, [query]);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        const full = coverage(`${text} ${query}`, [query]);
        expect(full === 1 || full === 0).toBe(true);
      }),
    );
  });

  it("関係のある段落がひとつもないときは、いちばんましなものも返さない", () => {
    const out = selectPassages(
      [
        { sourceId: "s1", index: 0, text: "Mindset 1990: Historical graph of downloads" },
        { sourceId: "s1", index: 1, text: "Number of pages | 6" },
      ],
      q,
      { passageMaxChars: 600, passagesPerBundle: 5, passagesPerSource: 3, maxTokens: 10_000, minRatio: 0.3, minCoverage: 0.34 },
    );
    expect(out).toEqual([]);
  });

  it("出典の種類の重み：同じ文なら重いほうが先", () => {
    const text = "The deliberative mindset is open-minded and the implemental mindset is closed-minded.";
    const out = selectPassages(
      [
        { sourceId: "blog", index: 0, text, weight: 0.8 },
        { sourceId: "paper", index: 0, text, weight: 1.5 },
      ],
      q,
      { passageMaxChars: 600, passagesPerBundle: 5, passagesPerSource: 3, maxTokens: 10_000, minRatio: 0, minCoverage: 0.34 },
    );
    expect(out.map((p) => p.sourceId)).toEqual(["paper", "blog"]);
  });
});

import { attachLeadIns } from "../src/index.ts";

describe("導入の文（設計 v1.4 §8.2.5）", () => {
  it("「：」で終わる文を、続く箇条の context に添える。箇条が終われば外す", () => {
    const out = attachLeadIns([
      { kind: "prose", text: "直観が信頼できるのは、次の二つの条件の両方が成り立つとき：", context: "結論" },
      { kind: "item", text: "環境が十分に規則的であること", context: "結論" },
      { kind: "item", text: "長い練習で規則性を学ぶ機会があること", context: "結論" },
      { kind: "prose", text: "それ以外の場合は当てにならない。" },
      { kind: "item", text: "関係のない箇条" },
    ]);
    expect(out[1]!.context).toBe("結論 — 直観が信頼できるのは、次の二つの条件の両方が成り立つとき：");
    expect(out[2]!.context).toBe("結論 — 直観が信頼できるのは、次の二つの条件の両方が成り立つとき：");
    expect(out[4]!.context).toBeUndefined();
    expect(out[0]!.kind).toBe("prose");
  });
});

describe("被覆率：日英が混ざった問い・1語だけの一致（設計 v1.4 §8.2.3）", () => {
  it("日英が混ざった長い問いでも、英語の文書を日本語の語の数で薄めない", () => {
    const q = ["Kahneman & Klein 2009 原文: 直観的専門性が信頼できる条件(environment of sufficient regularity / opportunity to learn) の記述箇所"];
    const abs = "Kahneman and Klein argue that skilled intuitions develop in an environment of sufficient regularity, given an opportunity to learn its regularities.";
    expect(coverage(abs, q)).toBeGreaterThanOrEqual(0.34);
  });
  it("2語以上の組で1語だけ当たったものは数えない", () => {
    expect(coverage("The API limit is applied per IP address.", ["Cloudflare の API の制限"])).toBe(0);
    expect(coverage("Cloudflare API rate limits", ["Cloudflare の API の制限"])).toBe(1);
  });
});

describe("ハイフンでつないだ語", () => {
  it("部分の語でも当たる", () => {
    expect(coverage("explicitly accounts for order-effect phenomena", ["order effects"])).toBe(1);
  });
});
