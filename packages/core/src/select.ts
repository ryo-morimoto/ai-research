import { normalize } from "./normalize.ts";
import { estimateTokens, type TokenFactors, DEFAULT_TOKEN_FACTORS } from "./tokens.ts";
import { LIMITS } from "./limits.ts";

/**
 * 段落選び（docs/03 §2.6.3）
 *
 * 原文を段落に分け、問いと検索語との語の重なりで点数を付け（BM25 に近い計算）、
 * 上位から選ぶ。出典1つあたりの件数・段落の長さ・束全体の大きさの上限を守る（性質 P5）。
 */

/**
 * context（見出し・表の見出し行）は関連の点数に使い、照合には使わない（設計 v1.3 §8.1.3）。
 * weight は出典の種類の重み（設計 v1.4 §8.2.3。論文 > 公式 > 百科事典 > その他）。既定は 1
 */
export type Paragraph = { sourceId: string; index: number; text: string; context?: string; weight?: number };

export type Selected = Paragraph & { score: number; tokens: number };

export type SelectLimits = {
  passageMaxChars: number;
  passagesPerBundle: number;
  passagesPerSource: number;
  maxTokens: number;
  /** 最上位の点数との比の下限（設計 v1.3 §8.1.3）。0 なら下限なし */
  minRatio?: number;
  /** 問いの語の被覆率の下限（設計 v1.4 §8.2.3）。0 なら下限なし */
  minCoverage?: number;
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
    if (w.length >= 2) out.push(stem(w));
    // ハイフンでつないだ語は、部分の語でも当てる（order-effect と "order effects"）
    if (w.includes("-")) for (const part of w.split("-")) if (part.length >= 2 && !/^\d+$/.test(part)) out.push(stem(part));
  }
  const nonAscii = n.replace(/[\x00-\x7f]+/g, " ");
  for (const run of nonAscii.split(/\s+/)) {
    const chars = Array.from(run);
    if (chars.length === 1) out.push(run);
    for (let i = 0; i + 1 < chars.length; i++) out.push((chars[i] ?? "") + (chars[i + 1] ?? ""));
  }
  return out;
}

/** 英語の複数形の s だけを落とす（mindsets → mindset）。ss・us・is で終わる語は落とさない */
function stem(w: string): string {
  return w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
}

/** 区別に効かない語（英語の機能語）。被覆率だけに使う */
const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how in into is it its of on or that the their this to was were what when where which who why will with about than then there these those also between vs".split(" "),
);

/**
 * 区別に効く語（被覆率の分母）：英語の機能語と、ひらがなだけの語（助詞・活用語尾の2文字）を除く
 */
export function discriminativeTerms(text: string): string[] {
  return [...new Set(terms(text))].filter((t) => !STOPWORDS.has(t) && !/^[\p{Script=Hiragana}ー]+$/u.test(t));
}

/**
 * 問いの語の被覆率（設計 v1.4 §8.2.3）。最上位との比と違い、関係のある候補がひとつもないときに、
 * いちばんましなものを通さないための絶対の下限に使う。
 *
 * - 問いと検索語のそれぞれを、英数字の語の組と、それ以外（日本語など）の語の組に分け、組ごとに text に現れた割合を出して最大を返す。
 *   日英が混ざった問いでも、片方の言語の文書を、もう片方の語の数で薄めない
 * - 2語以上の組では、1語だけ当たったものは数えない（"API" だけ当たった別の話題を通さない）
 */
export function coverage(text: string, query: string[]): number {
  const have = new Set(terms(text));
  let best = 0;
  for (const q of query) {
    const all = discriminativeTerms(q);
    for (const group of [all.filter((t) => /^[\x00-\x7f]+$/.test(t)), all.filter((t) => !/^[\x00-\x7f]+$/.test(t))]) {
      if (group.length === 0) continue;
      const hit = group.filter((t) => have.has(t)).length;
      if (hit < Math.min(2, group.length)) continue;
      best = Math.max(best, hit / group.length);
    }
  }
  return best;
}

export function scoreParagraphs(paragraphs: Paragraph[], query: string[]): Map<Paragraph, number> {
  const k1 = 1.2;
  const b = 0.75;
  const qTerms = new Set(query.flatMap((q) => terms(q)));
  const docs = paragraphs.map((p) => terms(p.context ? `${p.context} ${p.text}` : p.text));
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
    scores.set(p, s * (p.weight ?? 1));
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
  const minCov = limits.minCoverage ?? 0;
  const ranked = [...paragraphs]
    .map((p) => ({ p, s: scores.get(p) ?? 0 }))
    .filter((x) => x.s > 0 && (minCov === 0 || coverage(x.p.context ? `${x.p.context} ${x.p.text}` : x.p.text, query) >= minCov))
    .sort((a, b) => b.s - a.s || a.p.sourceId.localeCompare(b.p.sourceId) || a.p.index - b.p.index);
  const floor = (ranked[0]?.s ?? 0) * (limits.minRatio ?? 0);
  const perSource = new Map<string, number>();
  const out: Selected[] = [];
  let total = 0;
  for (const { p, s } of ranked) {
    if (out.length >= limits.passagesPerBundle) break;
    if (s < floor) break;
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

/**
 * 全文検索（FTS5 の trigram）に渡す語（設計 v1.3 §8.1.4）。
 * ASCII は3文字以上の語、それ以外は3文字ずつ。長い文をそのまま型にしない。数に上限を付ける。
 */
export function searchTerms(texts: string[], max = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (out.length < max && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const text of texts) {
    const n = normalize(text).toLowerCase();
    for (const w of n.match(/[a-z0-9_]+(?:[.\-][a-z0-9_]+)*/g) ?? []) if (w.length >= 3) push(w);
    for (const run of n.replace(/[\x00-\x7f]+/g, " ").split(/\s+/)) {
      const chars = Array.from(run).filter((c) => !/[\p{P}\p{S}]/u.test(c));
      for (let i = 0; i + 2 < chars.length; i++) push(chars.slice(i, i + 3).join(""));
    }
  }
  return out;
}

export type RankOptions = { limit: number; minRatio: number; minCoverage?: number };

/**
 * 問いとの関連で並べ、関連の下限（最上位の点数との比）を超えたものを件数の上限まで返す（設計 v1.3 §8.1.3・§8.1.4）。
 * 台帳の候補と段落の候補の両方で使う（判断を1か所に置く）。
 */
export function rankRelevant<T>(items: T[], textOf: (item: T) => string, query: string[], opts: RankOptions): { item: T; score: number }[] {
  const paras = items.map((item, index) => ({ sourceId: "r", index, text: textOf(item) }));
  const scores = scoreParagraphs(paras, query);
  const minCov = opts.minCoverage ?? 0;
  const ranked = paras
    .map((p) => ({ item: items[p.index] as T, score: scores.get(p) ?? 0, text: p.text }))
    .filter((x) => x.score > 0 && (minCov === 0 || coverage(x.text, query) >= minCov))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ?? 0;
  return ranked
    .filter((x) => x.score >= top * opts.minRatio)
    .slice(0, opts.limit)
    .map(({ item, score }) => ({ item, score }));
}
