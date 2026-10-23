/**
 * 上限値（docs/03 §2.8）。値は暫定。policy パッケージが版つきで上書きできる。
 */
export const LIMITS = {
  /** 抜き書きの最大長（E-01） */
  excerptMaxChars: 300,
  /** 照合用の前後の文脈それぞれの最大長（E-01） */
  contextMaxChars: 50,
  /** 段落1件の最大長（S-01） */
  passageMaxChars: 600,
  /** 束1回の段落の最大件数（S-01） */
  passagesPerBundle: 12,
  /** 出典1つあたりの段落の最大件数 */
  passagesPerSource: 4,
  /** 束1回の大きさ（トークン、S-01・S-05） */
  bundleMaxTokens: 6000,
  /** あいまい一致の閾値（要計測） */
  fuzzyThreshold: 0.9,
} as const;

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };
