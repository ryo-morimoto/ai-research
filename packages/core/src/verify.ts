import { normalize, loosen, loosenWithMap } from "./normalize.ts";
import { LIMITS } from "./limits.ts";
import type { Fingerprint, Source } from "./types.ts";

/**
 * 照合器（docs/03 §2.6.2）
 *
 * 台帳に書けるのは VerifiedExcerpt だけ。この型を作れるのはこのモジュールだけ
 * （ブランドの symbol をエクスポートしない。`as VerifiedExcerpt` は依存の規則で禁止）。
 * 不変条件 INV-1：excerpt は、その回に取得した原文の N 後の文字列の部分文字列である。
 */
declare const verifiedBrand: unique symbol;

export type VerifiedExcerpt = {
  readonly [verifiedBrand]: true;
  readonly excerpt: string;
  readonly ctxBefore: string;
  readonly ctxAfter: string;
  readonly source: Source;
  readonly fingerprint: Fingerprint;
  readonly verifiedAt: string;
  readonly match: MatchKind;
};

export type MatchKind = "exact" | "context" | "fuzzy";

export type MatchResult =
  | { ok: true; kind: MatchKind; start: number; end: number; score: number }
  | { ok: false; reason: "empty_quote" | "quote_too_long" | "not_in_source" };

export type MatchOptions = {
  /** 台帳のレコードから照らし直すときの前後の文脈 */
  ctxBefore?: string;
  ctxAfter?: string;
  fuzzyThreshold?: number;
  excerptMaxChars?: number;
};

/**
 * 引用 quote が原文 sourceText のどこにあるかを決める。
 * 返す位置は normalize(sourceText) 上の [start, end)。
 */
export function matchQuote(quote: string, sourceText: string, opts: MatchOptions = {}): MatchResult {
  const maxChars = opts.excerptMaxChars ?? LIMITS.excerptMaxChars;
  const q = normalize(quote);
  if (q.length === 0) return { ok: false, reason: "empty_quote" };
  if (q.length > maxChars) return { ok: false, reason: "quote_too_long" };
  const src = normalize(sourceText);

  // 1. 完全一致
  const idx = src.indexOf(q);
  if (idx >= 0) return { ok: true, kind: "exact", start: idx, end: idx + q.length, score: 1 };

  // 2. 前後の文脈で位置を特定し、記号・空白・幅の違いだけを許す（数字と否定の違いは許さない）
  const byCtx = locateByContext(q, src, opts.ctxBefore, opts.ctxAfter);
  if (byCtx) return { ok: true, kind: "context", ...byCtx, score: 1 };

  // 3. あいまい一致
  const threshold = opts.fuzzyThreshold ?? LIMITS.fuzzyThreshold;
  const fuzzy = fuzzyLocate(q, src);
  if (fuzzy && fuzzy.score >= threshold) {
    return { ok: true, kind: "fuzzy", start: fuzzy.start, end: fuzzy.end, score: fuzzy.score };
  }
  return { ok: false, reason: "not_in_source" };
}

/**
 * 記号・空白・大文字小文字・幅の違いを無視して位置を探す。
 * 同じ緩い形が複数あるときは、前後の文脈（W3C TextQuoteSelector の prefix / suffix と
 * 同じ考え方）が最もよく合うものを選ぶ。
 */
function locateByContext(
  q: string,
  src: string,
  ctxBefore: string | undefined,
  ctxAfter: string | undefined,
): { start: number; end: number } | null {
  const target = loosen(q);
  if (target.length === 0) return null;
  const { loose, starts, ends } = loosenWithMap(src);
  const before = ctxBefore ? normalize(ctxBefore) : "";
  const after = ctxAfter ? normalize(ctxAfter) : "";
  let best: { start: number; end: number; score: number } | null = null;
  let from = 0;
  for (;;) {
    const li = loose.indexOf(target, from);
    if (li < 0) break;
    const start = starts[li];
    const end = ends[li + target.length - 1];
    if (start === undefined || end === undefined) break;
    if (!sameMeaningMarkers(q, src.slice(start, end))) {
      from = li + 1;
      continue;
    }
    const score =
      commonSuffixLength(src.slice(Math.max(0, start - before.length), start), before) +
      commonPrefixLength(src.slice(end, end + after.length), after);
    if (!best || score > best.score) best = { start, end, score };
    from = li + 1;
  }
  return best ? { start: best.start, end: best.end } : null;
}

function commonSuffixLength(a: string, b: string): number {
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}

function commonPrefixLength(a: string, b: string): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

/**
 * あいまい一致：引用の一部（8文字以上）を手がかりに位置を探し、
 * 同じ長さの窓との編集距離の比で点数を付ける。
 */
function fuzzyLocate(q: string, src: string): { start: number; end: number; score: number } | null {
  const anchorLen = Math.min(8, q.length);
  let best: { start: number; end: number; score: number } | null = null;
  const tried = new Set<number>();
  for (let off = 0; off + anchorLen <= q.length; off += Math.max(1, Math.floor(anchorLen / 2))) {
    const anchor = q.slice(off, off + anchorLen);
    let from = 0;
    for (;;) {
      const hit = src.indexOf(anchor, from);
      if (hit < 0) break;
      const start = Math.max(0, hit - off);
      if (!tried.has(start)) {
        tried.add(start);
        for (const len of [q.length - 2, q.length - 1, q.length, q.length + 1, q.length + 2]) {
          if (len <= 0 || start + len > src.length) continue;
          const span = src.slice(start, start + len);
          // 数字や否定の違いは「表記差」ではなく意味の違い。あいまい一致でも許さない
          if (!sameMeaningMarkers(q, span)) continue;
          const score = similarity(q, span);
          if (!best || score > best.score) best = { start, end: start + len, score };
        }
      }
      from = hit + 1;
      if (tried.size > 200) break;
    }
  }
  return best;
}

// 数の表記：符号・小数点・百分率は意味を持つ。桁区切りのカンマだけは表記差として扱う
const NUMBER = /[-−]?\d+(?:[.,]\d+)*%?/gu;
const numbers = (s: string): string[] => (s.match(NUMBER) ?? []).map((x) => x.replace(/(?<=\d),(?=\d{3}(?!\d))/gu, "").replace("−", "-"));
const NEGATION = /ない|ません|なし|ぬ|ず|不|非|無|未|\bnot\b|\bno\b|\bnever\b|n't|\bwithout\b/giu;

/**
 * あいまい一致で許す差の範囲を、意味の変わらない表記差に限る。
 * 数字の並びと否定の語の並びが同じでなければ、同じ文とは見なさない
 * （事前の知識で数字を書き換えた引用を「表記差あり」で通さない。Q-06）。
 */
export function sameMeaningMarkers(a: string, b: string): boolean {
  const da = numbers(a);
  const db = numbers(b);
  if (da.length !== db.length || da.some((x, i) => x !== db[i])) return false;
  const na = (a.match(NEGATION) ?? []).map((x) => x.toLowerCase());
  const nb = (b.match(NEGATION) ?? []).map((x) => x.toLowerCase());
  return na.length === nb.length && na.every((x, i) => x === nb[i]);
}

/** 1 - 編集距離 / max(長さ) */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - (prev[m] ?? 0) / Math.max(n, m);
}

/**
 * 照合して VerifiedExcerpt を作る。台帳に書く抜き書きは、引用の文ではなく
 * 照合で位置が決まった原文側の文字列そのもの（docs/03 §2.6.2）。
 */
export function verifyQuote(args: {
  quote: string;
  sourceText: string;
  source: Source;
  fingerprint: Fingerprint;
  verifiedAt: string;
  options?: MatchOptions;
}): { ok: true; excerpt: VerifiedExcerpt } | { ok: false; reason: Extract<MatchResult, { ok: false }>["reason"] } {
  const m = matchQuote(args.quote, args.sourceText, args.options);
  if (!m.ok) return { ok: false, reason: m.reason };
  const src = normalize(args.sourceText);
  const maxChars = args.options?.excerptMaxChars ?? LIMITS.excerptMaxChars;
  const end = Math.min(m.end, m.start + maxChars);
  const excerpt = src.slice(m.start, end);
  const ctxN = LIMITS.contextMaxChars;
  const ve = {
    excerpt,
    ctxBefore: src.slice(Math.max(0, m.start - ctxN), m.start),
    ctxAfter: src.slice(end, Math.min(src.length, end + ctxN)),
    source: args.source,
    fingerprint: args.fingerprint,
    verifiedAt: args.verifiedAt,
    match: m.kind,
  } as unknown as VerifiedExcerpt;
  return { ok: true, excerpt: ve };
}

/** 照合の種類から、利用者に見せる状態の表記へ */
export function statusLabel(kind: MatchKind): "確認済" | "確認済（表記差あり）" {
  return kind === "exact" ? "確認済" : "確認済（表記差あり）";
}

/**
 * 台帳から読み戻した値を VerifiedExcerpt として扱うための唯一の入口。
 * 原文と照らし直して一致したときだけ返す（Q-02：照らし直せたものだけ確認済）。
 */
export function reverifyRecord(args: {
  excerpt: string;
  ctxBefore: string;
  ctxAfter: string;
  sourceText: string;
  source: Source;
  fingerprint: Fingerprint;
  verifiedAt: string;
}): { ok: true; excerpt: VerifiedExcerpt } | { ok: false; reason: Extract<MatchResult, { ok: false }>["reason"] } {
  return verifyQuote({
    quote: args.excerpt,
    sourceText: args.sourceText,
    source: args.source,
    fingerprint: args.fingerprint,
    verifiedAt: args.verifiedAt,
    options: { ctxBefore: args.ctxBefore, ctxAfter: args.ctxAfter },
  });
}
