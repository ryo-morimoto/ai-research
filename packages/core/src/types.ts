/** work は論文（書誌と抄録。設計 v1.4 D13、§8.2.2） */
export type SourceKind = "web" | "github" | "arxiv" | "work";

/** 論文の書誌（書誌・抄録の API の値を原文どおりに） */
export type WorkMeta = { authors: string[]; year?: number; venue?: string; doi?: string; pmid?: string; pmcid?: string };

/** 出典の種類（設計 v1.4 D13）。保存せず、出典から決める（policy の tierOf） */
export type Tier = "paper" | "official" | "encyclopedia" | "other";

export type Source = {
  kind: SourceKind;
  url: string;
  title?: string;
  tier?: Tier;
  /** 論文の書誌（kind が work のとき） */
  work?: WorkMeta;
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

/** 照合の状態（設計 v1.4 §8.2.6）。表すのは「引用が原文にあるか」だけ */
export type ClaimStatusLabel = "引用確認済" | "引用確認済（表記差あり）" | "照合失敗" | "未照合";
