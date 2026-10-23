/**
 * トークン数の見積もり（docs/03 §2.6.7）
 *
 * 予算（R-01）を守るため、見積もりは多めに倒す（性質 P8）。
 * 係数は暫定。実際のトークナイザの値と比べて policy で調整する。
 *
 * - CJK（漢字・かな・全角記号など）：1文字 1.0 トークン
 * - それ以外：3文字 1 トークン（英語の平均の約4文字より多めに見積もる）
 */
const CJK = /[\u{3000}-\u{30ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}\u{ff00}-\u{ffef}\u{ac00}-\u{d7af}]/u;

export type TokenFactors = { cjkPerChar: number; otherCharsPerToken: number };

export const DEFAULT_TOKEN_FACTORS: TokenFactors = { cjkPerChar: 1.0, otherCharsPerToken: 3 };

export function estimateTokens(text: string, f: TokenFactors = DEFAULT_TOKEN_FACTORS): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * f.cjkPerChar + other / f.otherCharsPerToken);
}

/** JSON にしたときの大きさで見積もる（束や照合結果を数えるとき） */
export function estimateJsonTokens(value: unknown, f: TokenFactors = DEFAULT_TOKEN_FACTORS): number {
  return estimateTokens(JSON.stringify(value) ?? "", f);
}
