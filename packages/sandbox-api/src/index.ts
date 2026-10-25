/**
 * code mode で会話の Claude に見せる API（docs/03 §2.3）
 *
 * - 型（ホスト側の実装が使う）
 * - SANDBOX_TYPES：道具の説明文に埋め込む型定義の文字列（モデルが読む）
 */

export type SourceKind = "web" | "github" | "arxiv" | "work";
export type WorkMeta = { authors: string[]; year?: number; venue?: string; doi?: string; pmid?: string; pmcid?: string };

/** tier は出典の種類（設計 v1.4 D13）：paper（論文）・official（公式）・encyclopedia（百科事典）・other */
export type SourceRef = {
  kind: SourceKind;
  url: string;
  title?: string;
  locator: string;
  tier?: "paper" | "official" | "encyclopedia" | "other";
  /** 論文の書誌（kind が work のとき。設計 v1.4 §8.2.2） */
  work?: WorkMeta;
};

/** 探す先（設計 v1.4 §8.2.2）。scholarly は書誌・抄録の API（Europe PMC、Crossref） */
export type SourceSet = "web" | "scholarly";

/**
 * context は見出し・導入の文・表の見出し行（照合の対象外）。照合で引用するのは text だけ。
 * 出典は束の sources に1回だけ置き、sourceId で指す（設計 v1.4 §8.2.7）
 */
export type Passage = { passageId: string; sourceId: string; text: string; context?: string };

export type LedgerHit = {
  passageId: string;
  sourceId: string;
  excerpt: string;
  /** 引用確認済：照らし直して原文にあった。照合失敗：原文が変わり抜き書きがない。取得できず未照合：取り直せなかった（設計 v1.4 §8.2.6） */
  status: "引用確認済" | "照合中" | "照合失敗" | "取得できず未照合";
  reason?: string;
  /** 台帳に入れたとき（原文と照らした日時）。変わりやすい値の新しさを判断するため（Q-01） */
  verifiedAt: string;
};

export type CutoffReason = "timeout" | "blocked" | "robots" | "policy" | "budget" | "error" | "unsupported" | "not_configured";

/** urls：まとめた打ち切りの URL（経路外で読める。設計 v1.4 §8.2.4） */
export type Cutoff = { what: string; why: CutoffReason; detail?: string; urls?: string[] };

/** 進み具合（設計 v1.4 §8.2.4）。検索した語・見つけた候補・取得できた出典・取得できなかった出典・走っている作業の数 */
export type Progress = { searched: number; found: number; fetched: number; failed: number; running: number };

/** 0件の理由（設計 v1.4 §8.2.4）。束の状態から規則で決める */
export type EmptyReason = "no_hits" | "search_failed" | "all_failed" | "not_relevant" | "still_running";

export type Notice =
  | { kind: "budget_stopped"; phase: "first" | "continue" | "deep" }
  | { kind: "superseded"; currentVersion: number }
  | { kind: "run_not_found" }
  | { kind: "empty"; why: EmptyReason; next: string }
  | { kind: "passage_not_found"; passageId: string };

/** 束（設計 v1.4 §8.2.7）。予算は止めたときの通知（budget_stopped）だけで示す */
export type Bundle = {
  runId: string;
  mode: Mode;
  question: { version: number; text: string };
  sources: Record<string, SourceRef>;
  ledgerHits: LedgerHit[];
  passages: Passage[];
  cutoffs: Cutoff[];
  progress: Progress;
  done: boolean;
  notices: Notice[];
};

/** 依頼の種類（設計 v1.3 D9）。lookup＝1つの事実を引く、survey＝調べる */
export type Mode = "lookup" | "survey";

export type QuestionInput = {
  question: string;
  mode: Mode;
  /** 既定は ["web"]。論文・研究の知見は "scholarly" を含める */
  sources?: SourceSet[];
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

/**
 * 照合の状態（設計 v1.4 §8.2.6）。確かめるのは「引用が原文にあるか」だけで、主張の正しさは確かめない。
 *   照合失敗：引用が原文に見つからない（reason と、原文でいちばん近い箇所 nearest）
 *   未照合：引用がない（no_citation）、予算で照合していない（budget）
 */
export type ClaimStatus = {
  index: number;
  status: "引用確認済" | "引用確認済（表記差あり）" | "照合失敗" | "未照合";
  reason?: "no_citation" | "unknown_passage" | "not_in_source" | "marker_mismatch" | "near_miss" | "quote_too_long" | "empty_quote" | "stale_version" | "budget";
  nearest?: { text: string; score: number };
  recorded?: string[];
};

export type VerifyResult = { statuses: ClaimStatus[]; notices: Notice[] };

/** 段落の前後（設計 v1.4 §8.2.5）。前後の候補の塊を、照合できる段落として返す */
export type AroundResult = { sources: Record<string, SourceRef>; passages: Passage[]; cutoffs: Cutoff[]; notices: Notice[] };

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
type Source = { kind: "web" | "github" | "arxiv" | "work"; url: string; title?: string; locator: string;
  tier: "paper" | "official" | "encyclopedia" | "other"; work?: { authors: string[]; year?: number; venue?: string; doi?: string } };
type Passage = { passageId: string; sourceId: string; text: string; context?: string };  // context は見出し（引用しない）
type LedgerHit = { passageId: string; sourceId: string; excerpt: string; status: "引用確認済" | "照合中" | "照合失敗" | "取得できず未照合"; verifiedAt: string };
type Bundle = { runId: string; sources: Record<string, Source>; ledgerHits: LedgerHit[]; passages: Passage[];
  cutoffs: { what: string; why: string; detail?: string; urls?: string[] }[];
  progress: Record<"searched" | "found" | "fetched" | "failed" | "running", number>;
  done: boolean; notices: { kind: string; why?: string; next?: string }[] };
type Claim = { text: string; cite: { passageId: string; quote: string }[] };
type Status = { index: number; status: "引用確認済" | "引用確認済（表記差あり）" | "照合失敗" | "未照合"; reason?: string; nearest?: { text: string; score: number } };
type HubError = { error: { code: string; retryable: boolean; message: string; next: string } };
type Q = { question: string; queries?: string[]; urls?: string[]; sources?: ("web" | "scholarly")[] };

declare const research: {
  start(q: Q & { mode: "lookup" | "survey" }): Promise<Bundle | HubError>;
  next(runId: string, opts?: { waitMs?: number }): Promise<Bundle | HubError>;
  around(runId: string, passageId: string, opts?: { before?: number; after?: number }): Promise<{ sources; passages: Passage[] } | HubError>;
  verify(runId: string, claims: Claim[]): Promise<{ statuses: Status[] } | HubError>;
  steer(runId: string, q: Q): Promise<Bundle | HubError>;
  deepen(runId: string): Promise<Bundle | HubError>;
};
`.trim();
