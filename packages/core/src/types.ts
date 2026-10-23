export type SourceKind = "web" | "github" | "arxiv";

export type Source = {
  kind: SourceKind;
  url: string;
  title?: string;
  /** 位置。例：owner/repo@<sha>:path#L10-24、arXiv:2401.01234v2 §3.1、URL＋見出しの道筋 */
  locator: string;
};

export type Fingerprint = {
  etag?: string;
  lastModified?: string;
  /** 正規化した本文の SHA-256（16進） */
  textHash?: string;
  commit?: string;
  arxivVersion?: string;
};

export type Volatility = "stable" | "normal" | "volatile";

export type ClaimStatusLabel = "確認済" | "確認済（表記差あり）" | "未確認";
