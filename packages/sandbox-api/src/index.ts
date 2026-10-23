/**
 * code mode で会話の Claude に見せる API（docs/03 §2.3）
 *
 * - 型（ホスト側の実装が使う）
 * - SANDBOX_TYPES：道具の説明文に埋め込む型定義の文字列（モデルが読む）
 */

export type SourceKind = "web" | "github" | "arxiv";

export type SourceRef = { kind: SourceKind; url: string; title?: string; locator: string };

export type Passage = { passageId: string; text: string; source: SourceRef };

export type LedgerHit = {
  passageId: string;
  recordId: string;
  excerpt: string;
  source: SourceRef;
  status: "確認済" | "照合中" | "未確認";
  reason?: string;
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
  question: { version: number; text: string };
  ledgerHits: LedgerHit[];
  passages: Passage[];
  cutoffs: Cutoff[];
  budget: { phase: "first" | "continue" | "deep"; usedTokens: number; capTokens: number };
  done: boolean;
  notices: Notice[];
};

export type QuestionInput = {
  question: string;
  scope?: string;
  exclusions?: string[];
  queries: string[];
  depth?: "first" | "standard";
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

/** モデルが読む型定義。道具の説明文に埋め込む */
export const SANDBOX_TYPES = `
type SourceRef = { kind: "web" | "github" | "arxiv"; url: string; title?: string; locator: string };
type Passage = { passageId: string; text: string; source: SourceRef };
type LedgerHit = { passageId: string; recordId: string; excerpt: string; source: SourceRef;
                   status: "確認済" | "照合中" | "未確認"; reason?: string };
type Cutoff = { what: string; why: string; detail?: string };
type Notice = { kind: "budget_stopped" | "superseded" | "run_not_found" | "done"; [k: string]: unknown };
type Bundle = {
  runId: string;
  question: { version: number; text: string };
  ledgerHits: LedgerHit[];   // 以前に確かめた抜き書き。status は今回の照らし直しの結果
  passages: Passage[];       // 今回取得した原文の段落（表示用。保存されない）
  cutoffs: Cutoff[];         // 打ち切り・取得不能。結果に必ず示す
  budget: { phase: string; usedTokens: number; capTokens: number };
  done: boolean;
  notices: Notice[];
};
type ClaimInput = { text: string; cite: { passageId: string; quote: string }[] };  // quote は段落の文をそのまま（300字まで）
type ClaimStatus = { index: number; status: "確認済" | "確認済（表記差あり）" | "未確認"; reason?: string; recorded?: string[] };

declare const research: {
  /** 調査を始める。25秒ほどで最初の束を返し、その後もハブが集め続ける */
  start(q: { question: string; scope?: string; exclusions?: string[]; queries: string[];
             depth?: "first" | "standard"; urls?: string[] }): Promise<Bundle>;
  /** 前回から増えた分だけを返す。waitMs まで待つ（最大50秒） */
  next(runId: string, opts?: { waitMs?: number }): Promise<Bundle>;
  /** 主張を照合する。照合できた引用だけが台帳に残る */
  verify(runId: string, claims: ClaimInput[]): Promise<{ statuses: ClaimStatus[]; notices: Notice[] }>;
  /** 向きを変える。問いの版が上がり、古い版の作業は結果に混ざらない */
  steer(runId: string, q: { question: string; queries: string[]; urls?: string[] }): Promise<Bundle>;
  /** 利用者が深掘りを求めたときだけ呼ぶ */
  deepen(runId: string): Promise<Bundle>;
};

declare const ledger: {
  search(text: string): Promise<{ recordId: string; excerpt: string; source: SourceRef; verifiedAt: string }[]>;
};
`.trim();
