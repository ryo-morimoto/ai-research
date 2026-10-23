/**
 * 性質ベーステスト P1〜P9（docs/03 §3.2）
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  normalize,
  matchQuote,
  verifyQuote,
  selectPassages,
  splitParagraphs,
  admit,
  classifyVolatility,
  maxVolatility,
  estimateTokens,
  LIMITS,
  type Paragraph,
  type Volatility,
  type BudgetState,
  type Phase,
  DEFAULT_CAPS,
} from "../src/index.ts";

const runs = Number(process.env.FC_RUNS ?? 300);
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const params = { numRuns: runs, ...(seed !== undefined ? { seed } : {}) };

// 日本語・英語・記号・空白・全角・制御文字を混ぜた文字列
const mixedChar = fc.oneof(
  fc.constantFrom(..."あいうえおかきくけこアイウエオ漢字調査出典確認、。「」（）・ー"),
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
  fc.constantFrom(..." \t\n\r　 .,;:!?-_/()[]{}\"'"),
  fc.constantFrom(..."ＡＢＣ１２３ｱｲｳ​﻿\u0007"),
);
const text = (min = 0, max = 200) => fc.array(mixedChar, { minLength: min, maxLength: max }).map((a) => a.join(""));

const source = { kind: "web" as const, url: "https://example.com/a", locator: "https://example.com/a#x" };

describe("P1 正規化は冪等", () => {
  it("N(N(x)) === N(x)", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => normalize(normalize(s)) === normalize(s)), params);
    fc.assert(fc.property(text(), (s) => normalize(normalize(s)) === normalize(s)), params);
  });
});

describe("P2 照合器が作る抜き書きは N(原文) の部分文字列（INV-1）", () => {
  it("どんな引用でも、成功したら部分文字列", () => {
    fc.assert(
      fc.property(text(0, 400), text(0, 60), (src, quote) => {
        const r = verifyQuote({ quote, sourceText: src, source, fingerprint: {}, verifiedAt: "t" });
        if (!r.ok) return true;
        return normalize(src).includes(r.excerpt.excerpt) && r.excerpt.excerpt.length > 0;
      }),
      params,
    );
  });
  it("原文の一部を少し書き換えた引用でも、成功したら部分文字列", () => {
    fc.assert(
      fc.property(text(20, 400), fc.nat(), fc.nat(), mixedChar, (src, a, b, ch) => {
        const n = normalize(src);
        if (n.length < 10) return true;
        const s = a % (n.length - 5);
        const e = Math.min(n.length, s + 5 + (b % 60));
        const pos = s + ((a + b) % (e - s));
        const quote = n.slice(s, pos) + ch + n.slice(pos + 1, e);
        const r = verifyQuote({ quote, sourceText: src, source, fingerprint: {}, verifiedAt: "t" });
        if (!r.ok) return true;
        return n.includes(r.excerpt.excerpt);
      }),
      params,
    );
  });
});

describe("P3 原文の部分文字列を引用すれば完全一致", () => {
  it("N(原文) の部分文字列は exact", () => {
    fc.assert(
      fc.property(text(1, 400), fc.nat(), fc.nat(), (src, a, b) => {
        const n = normalize(src);
        if (n.length === 0) return true;
        const s = a % n.length;
        const len = 1 + (b % Math.min(LIMITS.excerptMaxChars, n.length - s));
        const quote = n.slice(s, s + len);
        if (normalize(quote).length === 0) return true;
        const m = matchQuote(quote, src);
        return m.ok && m.kind === "exact";
      }),
      params,
    );
  });
});

describe("P4 抜き書きの範囲の外を変えても照合は変わらない", () => {
  it("範囲の外の書き換えでは exact のまま。範囲の中の書き換えでは exact でなくなる", () => {
    const word = fc.array(fc.constantFrom(..."調査出典確認台帳原文"), { minLength: 12, maxLength: 30 }).map((a) => a.join(""));
    fc.assert(
      fc.property(word, text(0, 100), text(0, 100), text(0, 100), (quote, pre, post, noise) => {
        // 引用は前後と区切りの記号で離しておく（前後の書き換えが引用に食い込まないように）
        const src = `${pre}｜${quote}｜${post}`;
        const changedOutside = `${noise}｜${quote}｜${post}${noise}`;
        const m1 = matchQuote(quote, src);
        const m2 = matchQuote(quote, changedOutside);
        expect(m1.ok && m1.kind).toBe("exact");
        expect(m2.ok && m2.kind).toBe("exact");
        // 範囲の中の1文字を、引用に現れない文字に変える
        const mid = Math.floor(quote.length / 2);
        const inside = `${pre}｜${quote.slice(0, mid)}★${quote.slice(mid + 1)}｜${post}`;
        const m3 = matchQuote(quote, inside);
        expect(m3.ok && m3.kind === "exact").toBe(false);
      }),
      params,
    );
  });
});

describe("P5 段落選びは上限を守る", () => {
  it("件数・出典ごとの件数・段落の長さ・合計トークン", () => {
    const para = fc.record({
      sourceId: fc.constantFrom("s1", "s2", "s3"),
      text: text(1, 1500),
    });
    fc.assert(
      fc.property(
        fc.array(para, { maxLength: 40 }),
        fc.array(text(1, 20), { minLength: 1, maxLength: 4 }),
        fc.record({
          passageMaxChars: fc.integer({ min: 20, max: 800 }),
          passagesPerBundle: fc.integer({ min: 1, max: 15 }),
          passagesPerSource: fc.integer({ min: 1, max: 5 }),
          maxTokens: fc.integer({ min: 10, max: 8000 }),
        }),
        (ps, query, limits) => {
          const paragraphs: Paragraph[] = ps.map((p, index) => ({ ...p, index }));
          const out = selectPassages(paragraphs, query, limits);
          expect(out.length).toBeLessThanOrEqual(limits.passagesPerBundle);
          const per = new Map<string, number>();
          let total = 0;
          for (const s of out) {
            per.set(s.sourceId, (per.get(s.sourceId) ?? 0) + 1);
            expect(Array.from(s.text).length).toBeLessThanOrEqual(limits.passageMaxChars);
            total += s.tokens;
          }
          for (const v of per.values()) expect(v).toBeLessThanOrEqual(limits.passagesPerSource);
          expect(total).toBeLessThanOrEqual(limits.maxTokens);
        },
      ),
      params,
    );
  });
  it("splitParagraphs は空の段落を作らない", () => {
    fc.assert(fc.property(text(0, 500), (s) => splitParagraphs("x", s).every((p) => p.text.length > 0)), params);
  });
});

describe("P6 予算は負にならず、上限を超えない（INV-9）", () => {
  it("どんな要求の列でも used ≤ cap、allowed ≤ want", () => {
    const phase = fc.constantFrom<Phase>("first", "continue", "deep");
    fc.assert(
      fc.property(phase, fc.array(fc.integer({ min: -10, max: 200_000 }), { maxLength: 50 }), (p, wants) => {
        let st: BudgetState = { used: 0, phase: p, stopped: false };
        for (const w of wants) {
          const a = admit(st, w);
          expect(a.allowed).toBeGreaterThanOrEqual(0);
          expect(a.allowed).toBeLessThanOrEqual(Math.max(0, w));
          expect(a.state.used).toBeLessThanOrEqual(DEFAULT_CAPS[p]);
          expect(a.state.used).toBeGreaterThanOrEqual(st.used);
          if (st.stopped) expect(a.allowed).toBe(0);
          st = a.state;
        }
      }),
      params,
    );
  });
});

describe("P7 変わりやすさは会話の側の値で下がらない", () => {
  it("classify(hint) ≥ classify(なし)", () => {
    const vol = fc.constantFrom<Volatility>("stable", "normal", "volatile");
    const order = { stable: 0, normal: 1, volatile: 2 };
    fc.assert(
      fc.property(fc.constantFrom("web", "github", "arxiv" as const), fc.webUrl(), text(0, 100), vol, (kind, url, excerpt, hint) => {
        const base = classifyVolatility({ kind, url, excerpt });
        const withHint = classifyVolatility({ kind, url, excerpt, hint });
        expect(order[withHint]).toBeGreaterThanOrEqual(order[base]);
        expect(withHint).toBe(maxVolatility(base, hint));
      }),
      params,
    );
  });
});

describe("P8 トークンの見積もりは多めに倒す", () => {
  it("単調：文字を足すと見積もりは減らない", () => {
    fc.assert(fc.property(text(), text(), (a, b) => estimateTokens(a + b) >= estimateTokens(a)), params);
  });
  it("試料文での下限（実測値は policy で校正する）", () => {
    // 英語の平均は約4文字/トークン、日本語は約1文字/トークン以下。見積もりがそれを下回らないこと
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(..."abcdefghij klmnop") }), (s) => estimateTokens(s) >= Math.ceil(s.length / 4)),
      params,
    );
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(..."調査出典確認台帳原文あいうえお") }), (s) => estimateTokens(s) >= s.length),
      params,
    );
  });
});

describe("P9 抜き書きと文脈の長さは上限以内（E-01）", () => {
  it("excerpt ≤ 300、ctx ≤ 50", () => {
    fc.assert(
      fc.property(text(0, 2000), fc.nat(), fc.nat(), (src, a, b) => {
        const n = normalize(src);
        const s = n.length ? a % n.length : 0;
        const quote = n.slice(s, s + (b % 400));
        const r = verifyQuote({ quote, sourceText: src, source, fingerprint: {}, verifiedAt: "t" });
        if (!r.ok) return true;
        return (
          r.excerpt.excerpt.length <= LIMITS.excerptMaxChars &&
          r.excerpt.ctxBefore.length <= LIMITS.contextMaxChars &&
          r.excerpt.ctxAfter.length <= LIMITS.contextMaxChars
        );
      }),
      params,
    );
  });
});
