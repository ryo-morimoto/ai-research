import { normalize } from "./normalize.ts";
import { estimateTokens, type TokenFactors, DEFAULT_TOKEN_FACTORS } from "./tokens.ts";
import { LIMITS } from "./limits.ts";

/**
 * 段落選び（docs/03 §2.6.3）
 *
 * 原文を段落に分け、問いと検索語との語の重なりで点数を付け（BM25 に近い計算）、
 * 上位から選ぶ。出典1つあたりの件数・段落の長さ・束全体の大きさの上限を守る（性質 P5）。
 */

export type Paragraph = { sourceId: string; index: number; text: string };

export type Selected = Paragraph & { score: number; tokens: number };

export type SelectLimits = {
  passageMaxChars: number;
  passagesPerBundle: number;
  passagesPerSource: number;
  maxTokens: number;
};

export function splitParagraphs(sourceId: string, text: string): Paragraph[] {
  return text
    .split(/\n\s*\n+/)
    .map((t) => normalize(t))
    .filter((t) => t.length > 0)
    .map((t, index) => ({ sourceId, index, text: t }));
}

/**
 * 語に分ける。ASCII の語は小文字の単語、CJK などは2文字ずつ（bigram）。
 * 日本語の分かち書きは近似（要計測）。
 */
export function terms(text: string): string[] {
  const n = normalize(text).toLowerCase();
  const out: string[] = [];
  for (const w of n.match(/[a-z0-9_]+(?:[.\-][a-z0-9_]+)*/g) ?? []) {
    if (w.length >= 2) out.push(w);
  }
  const nonAscii = n.replace(/[\x00-\x7f]+/g, " ");
  for (const run of nonAscii.split(/\s+/)) {
    const chars = Array.from(run);
    if (chars.length === 1) out.push(run);
    for (let i = 0; i + 1 < chars.length; i++) out.push((chars[i] ?? "") + (chars[i + 1] ?? ""));
  }
  return out;
}

export function scoreParagraphs(paragraphs: Paragraph[], query: string[]): Map<Paragraph, number> {
  const k1 = 1.2;
  const b = 0.75;
  const qTerms = new Set(query.flatMap((q) => terms(q)));
  const docs = paragraphs.map((p) => terms(p.text));
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (qTerms.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const scores = new Map<Paragraph, number>();
  paragraphs.forEach((p, i) => {
    const d = docs[i] ?? [];
    const tf = new Map<string, number>();
    for (const t of d) if (qTerms.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const [t, f] of tf) {
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / Math.max(1, avgLen))));
    }
    scores.set(p, s);
  });
  return scores;
}

/** 長い段落は、問いの語が最も多く現れる位置を中心に maxChars に切る */
export function clip(text: string, query: string[], maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const qTerms = [...new Set(query.flatMap((q) => terms(q)))];
  let bestStart = 0;
  let bestHits = -1;
  const step = Math.max(1, Math.floor(maxChars / 4));
  for (let s = 0; s + maxChars <= chars.length + step; s += step) {
    const start = Math.min(s, chars.length - maxChars);
    const window = chars.slice(start, start + maxChars).join("").toLowerCase();
    let hits = 0;
    for (const t of qTerms) if (window.includes(t)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      bestStart = start;
    }
    if (start === chars.length - maxChars) break;
  }
  return chars.slice(bestStart, bestStart + maxChars).join("");
}

export function selectPassages(
  paragraphs: Paragraph[],
  query: string[],
  limits: SelectLimits = {
    passageMaxChars: LIMITS.passageMaxChars,
    passagesPerBundle: LIMITS.passagesPerBundle,
    passagesPerSource: LIMITS.passagesPerSource,
    maxTokens: LIMITS.bundleMaxTokens,
  },
  factors: TokenFactors = DEFAULT_TOKEN_FACTORS,
): Selected[] {
  const scores = scoreParagraphs(paragraphs, query);
  const ranked = [...paragraphs]
    .map((p) => ({ p, s: scores.get(p) ?? 0 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.sourceId.localeCompare(b.p.sourceId) || a.p.index - b.p.index);
  const perSource = new Map<string, number>();
  const out: Selected[] = [];
  let total = 0;
  for (const { p, s } of ranked) {
    if (out.length >= limits.passagesPerBundle) break;
    const used = perSource.get(p.sourceId) ?? 0;
    if (used >= limits.passagesPerSource) continue;
    const text = clip(p.text, query, limits.passageMaxChars);
    const tokens = estimateTokens(text, factors);
    if (total + tokens > limits.maxTokens) continue;
    out.push({ ...p, text, score: s, tokens });
    perSource.set(p.sourceId, used + 1);
    total += tokens;
  }
  return out;
}
