/**
 * code mode で会話の Claude に見せる API（docs/03 §2.3）
 *
 * - 型（ホスト側の実装が使う）
 * - SANDBOX_TYPES：道具の説明文に埋め込む型定義の文字列（モデルが読む）
 */

export type SourceKind = "web" | "github" | "arxiv";

export type SourceRef = { kind: SourceKind; url: string; title?: string; locator: string };

/** context は見出し・表の見出し行（照合の対象外）。照合で引用するのは text だけ */
export type Passage = { passageId: string; text: string; context?: string; source: SourceRef };

export type LedgerHit = {
  passageId: string;
  recordId: string;
  excerpt: string;
  source: SourceRef;
  status: "確認済" | "照合中" | "未確認";
  reason?: string;
  /** 台帳に入れたとき（原文と照らした日時）。変わりやすい値の新しさを判断するため（Q-01） */
  verifiedAt: string;
};

export type CutoffReason = "timeout" | "blocked" | "robots" | "policy" | "budget" | "error" | "unsupported" | "not_configured";

export type Cutoff = { what: string; why: CutoffReason; detail?: string };

export type Notice =
  | { kind: "budget_stopped"; phase: "first" | "continue" | "deep" }
  | { kind: "superseded"; currentVersion: number }
  | { kind: "run_not_found" }
  | { kind: "done" };

export type Bundle = {
  runId: string;
  mode: Mode;
  question: { version: number; text: string };
  ledgerHits: LedgerHit[];
  passages: Passage[];
  cutoffs: Cutoff[];
  budget: { phase: "first" | "continue" | "deep"; usedTokens: number; capTokens: number };
  done: boolean;
  notices: Notice[];
};

/** 依頼の種類（設計 v1.3 D9）。lookup＝1つの事実を引く、survey＝調べる */
export type Mode = "lookup" | "survey";

export type QuestionInput = {
  question: string;
  mode: Mode;
  scope?: string;
  exclusions?: string[];
  queries?: string[];
  /** 調べたい URL が分かっているときに直接指定する（GitHub、arXiv、Web） */
  urls?: string[];
};

export type ClaimInput = {
  text: string;
  /** 引用は段落 ID と、その段落の中の文をそのまま写した短い引用（300字まで） */
  cite: { passageId: string; quote: string }[];
};

export type ClaimStatus = {
  index: number;
  status: "確認済" | "確認済（表記差あり）" | "未確認";
  reason?: "no_citation" | "unknown_passage" | "not_in_source" | "quote_too_long" | "empty_quote" | "stale_version" | "budget";
  recorded?: string[];
};

export type VerifyResult = { statuses: ClaimStatus[]; notices: Notice[] };

/**
 * 実行環境に渡す関数の失敗（設計 v1.3 D12、制約 P-05）。例外ではなく値で返す。
 *   busy          ハブが一時的に応えられない（過負荷、ストレージの時間切れ、初期化）。少しおいて同じ呼び出しをもう一度
 *   run_not_found その runId の調査がない（期限切れ、初期化で失われた）。start からやり直す
 *   bad_input     渡した値が型に合わない。message を見て直す
 *   internal      それ以外。経路外で調べる
 */
export type HubErrorCode = "busy" | "run_not_found" | "bad_input" | "internal";
export type HubError = { error: { code: HubErrorCode; retryable: boolean; message: string; next: string; runId?: string } };

/** モデルが読む型定義。道具の説明文に埋め込む */
export const SANDBOX_TYPES = `
type Source = { kind: "web" | "github" | "arxiv"; url: string; title?: string; locator: string };
type Passage = { passageId: string; text: string; context?: string; source: Source };  // context は見出し（引用しない）
type LedgerHit = { passageId: string; excerpt: string; source: Source; status: "確認済" | "照合中" | "未確認"; verifiedAt: string };
type Bundle = { runId: string; mode: "lookup" | "survey"; question: { version: number; text: string };
  ledgerHits: LedgerHit[]; passages: Passage[]; cutoffs: { what: string; why: string; detail?: string }[]; done: boolean };
type Claim = { text: string; cite: { passageId: string; quote: string }[] };  // quote は段落の text をそのまま
type HubError = { error: { code: "busy" | "run_not_found" | "bad_input" | "internal"; retryable: boolean; message: string; next: string } };

declare const research: {
  start(q: { question: string; mode: "lookup" | "survey"; queries?: string[]; urls?: string[] }): Promise<Bundle | HubError>;
  next(runId: string, opts?: { waitMs?: number }): Promise<Bundle | HubError>;   // survey の続き（差分だけ）
  verify(runId: string, claims: Claim[]): Promise<{ statuses: { index: number; status: "確認済" | "確認済（表記差あり）" | "未確認"; reason?: string }[] } | HubError>;
  steer(runId: string, q: { question: string; queries?: string[]; urls?: string[] }): Promise<Bundle | HubError>;
  deepen(runId: string): Promise<Bundle | HubError>;
  close(runId: string): Promise<{ closed: true } | HubError>;
};
declare const ledger: { search(text: string): Promise<{ excerpt: string; source: Source; verifiedAt: string }[]> };
`.trim();
