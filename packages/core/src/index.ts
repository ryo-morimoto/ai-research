export { normalize, loosen, loosenWithMap } from "./normalize.ts";
export {
  matchQuote,
  verifyQuote,
  reverifyRecord,
  statusLabel,
  similarity,
  type VerifiedExcerpt,
  type MatchKind,
  type MatchResult,
  type MatchOptions,
} from "./verify.ts";
export { splitParagraphs, terms, scoreParagraphs, selectPassages, clip, type Paragraph, type Selected, type SelectLimits } from "./select.ts";
export { estimateTokens, estimateJsonTokens, DEFAULT_TOKEN_FACTORS, type TokenFactors } from "./tokens.ts";
export { classifyVolatility, maxVolatility, baseVolatility, DEFAULT_VOLATILITY_RULES, type VolatilityRule } from "./volatility.ts";
export { admit, advance, capFor, DEFAULT_CAPS, type Phase, type BudgetState, type Admission } from "./budget.ts";
export {
  planRevalidation,
  judgeRevalidation,
  conditionalHeaders,
  type RevalidationMethod,
  type Observation,
  type Judgement,
} from "./revalidate.ts";
export { textHash } from "./hash.ts";
export { LIMITS, type Limits } from "./limits.ts";
export type { Source, SourceKind, Fingerprint, Volatility, ClaimStatusLabel } from "./types.ts";
