import type { SourceKind, Volatility } from "./types.ts";

/**
 * 変わりやすさ（docs/03 §2.6.4）
 *
 * 規則で決める。会話の側（LLM）が付けた値は上げることにしか効かない（性質 P7）。
 */
const ORDER: Record<Volatility, number> = { stable: 0, normal: 1, volatile: 2 };

export function maxVolatility(a: Volatility, b: Volatility): Volatility {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export type VolatilityRule = { pattern: RegExp; target: "url" | "excerpt"; value: Volatility };

export const DEFAULT_VOLATILITY_RULES: VolatilityRule[] = [
  { target: "url", pattern: /status\.|\/status(\/|$)|statuspage/i, value: "volatile" },
  { target: "url", pattern: /pricing|\/price|料金|価格/i, value: "volatile" },
  { target: "url", pattern: /releases\/latest|\/latest(\/|$)|changelog/i, value: "volatile" },
  { target: "excerpt", pattern: /\b(latest|current(ly)?|as of|now)\b|最新|現在|現時点/i, value: "volatile" },
  { target: "excerpt", pattern: /\$\s?\d|¥\s?\d|\d+\s?(円|ドル|USD|JPY)/i, value: "volatile" },
];

export function baseVolatility(kind: SourceKind): Volatility {
  return kind === "arxiv" || kind === "work" ? "stable" : "normal";
}

export function classifyVolatility(
  args: { kind: SourceKind; url: string; excerpt: string; hint?: Volatility },
  rules: VolatilityRule[] = DEFAULT_VOLATILITY_RULES,
): Volatility {
  let v = baseVolatility(args.kind);
  for (const r of rules) {
    const subject = r.target === "url" ? args.url : args.excerpt;
    if (r.pattern.test(subject)) v = maxVolatility(v, r.value);
  }
  return args.hint ? maxVolatility(v, args.hint) : v;
}
