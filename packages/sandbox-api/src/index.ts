/**
 * code mode で会話の Claude に見せる API（docs/03 §2.3）
 *
 * - 型（ホスト側の実装が使う）
 * - SANDBOX_TYPES：道具の説明文に埋め込む型定義の文字列（モデルが読む）
 */

export type SourceKind = "web" | "github" | "arxiv" | "work";
/** abstract: false は、決めた経路のどれにも抄録がなかった印（設計 v1.6 §8.4.3） */
export type WorkMeta = { authors: string[]; year?: number; venue?: string; doi?: string; pmid?: string; pmcid?: string; abstract?: false };

/** tier は出典の種類（設計 v1.4 D13）：paper（論文）・official（公式）・encyclopedia（百科事典）・other */
export type SourceRef = {
  kind: SourceKind;
  url: string;
  title?: string;
  /** 位置（URL と同じなら省く） */
  locator?: string;
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
  /**
   * 引用確認済：照らし直して原文にあった。照合失敗：原文が変わり抜き書きがない。取得できず未照合：取り直せなかった（設計 v1.4 §8.2.6）。
   * 照らし直しが決着するまでは束に出さない（設計 v1.5 §8.3.2）
   */
  status: "引用確認済" | "照合失敗" | "取得できず未照合";
  reason?: string;
  /** 台帳に入れたとき（原文と照らした日時）。変わりやすい値の新しさを判断するため（Q-01） */
  verifiedAt: string;
};

/**
 * 打ち切り（確定した喪失）の理由（設計 v1.5 §8.3.2）。呼ぶ側の次の手で分ける。
 *   timeout   取得1件の時間切れ      gave_up   調査の終わりに残っていた作業
 *   not_found 出典がない（404 など） no_passage 取得できたが、問いに合う段落が選ばれなかった（§8.3.3）
 */
export const CUTOFF_REASONS = [
  "timeout",
  "gave_up",
  "blocked",
  "robots",
  "policy",
  "budget",
  "not_found",
  "error",
  "unsupported",
  "no_passage",
  "not_configured",
] as const;
export type CutoffReason = (typeof CUTOFF_REASONS)[number];

/** verify の照合失敗・未照合の理由（設計 v1.4 §8.2.6、v1.5 §8.3.7）。型と説明文の一覧はここから作る（設計 v1.6 §8.4.5） */
export const CLAIM_REASONS = [
  "no_citation",
  "unknown_passage",
  "not_in_source",
  "marker_mismatch",
  "near_miss",
  "quote_too_long",
  "empty_quote",
  "budget",
] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** まだ集めている作業（設計 v1.5 §8.3.2）。喪失ではない。next で届く */
export type Pending = { what: string; since: string };

/** urls：まとめた打ち切りの URL（経路外で読める。設計 v1.4 §8.2.4） */
export type Cutoff = { what: string; why: CutoffReason; detail?: string; urls?: string[]; sourceId?: string };

/** 進み具合（設計 v1.4 §8.2.4）。検索した語・見つけた候補・取得できた出典・取得できなかった出典・走っている作業の数 */
export type Progress = { searched: number; found: number; fetched: number; failed: number; running: number };

/** 0件の理由（設計 v1.4 §8.2.4）。束の状態から規則で決める */
export type EmptyReason = "no_hits" | "search_failed" | "all_failed" | "not_relevant" | "still_running";

export type Notice =
  | { kind: "budget_stopped"; phase: "first" | "continue" | "deep" }
  | { kind: "superseded"; currentVersion: number }
  | { kind: "run_not_found" }
  | { kind: "empty"; why: EmptyReason; next: string }
  | { kind: "passage_not_found"; passageId: string }
  | { kind: "source_not_found"; source: string }
  | { kind: "clamped"; field: string; max: number }
  | { kind: "query_language"; sourceIds: string[]; next: string };

/** 束（設計 v1.4 §8.2.7）。予算は止めたときの通知（budget_stopped）だけで示す */
export type Bundle = {
  runId: string;
  mode: Mode;
  /** 問いの版（steer で増える）。問いの文は呼んだ側が書いたものなので繰り返さない（設計 v1.5 §8.3.7） */
  question: { version: number };
  /** 手順（code の道具の説明文）の版。説明文の版と違えば research.help() で今の手順を読む（設計 v1.6 §8.4.2） */
  procedure: string;
  sources: Record<string, SourceRef>;
  ledgerHits: LedgerHit[];
  passages: Passage[];
  /** まだ集めている作業（done なら空） */
  pending: Pending[];
  /** 確定した喪失だけ */
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
  /** 最初の束を、種類の締め切り（survey 25秒、lookup 15秒）より早く返す（設計 v1.5 §8.3.2） */
  waitMs?: number;
  /** 1つの束で返す段落の上限（種類の上限より小さくだけできる。設計 v1.5 §8.3.7） */
  maxPassages?: number;
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
  reason?: ClaimReason;
  nearest?: { text: string; score: number };
  /** 照合失敗・未照合のとき、理由ごとの次の手（設計 v1.5 §8.3.7） */
  next?: string;
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

/**
 * モデルに見せる入力の上限（issue 002）。値の正は policy（POLICY から導く）。
 * 上限を型定義の文に埋め込み、超えた値は境界で丸めて clamped で知らせる（bad_input で往復させない）
 */
export type SandboxBounds = {
  /** next・steer の waitMs の上限（ms） */
  waitMsMax: number;
  /** 最初の束を待つ上限（ms、種類ごと） */
  startMs: { lookup: number; survey: number };
  /** 1つの束の段落の上限（種類ごと）。maxPassages はこれより小さくだけできる */
  maxPassages: { lookup: number; survey: number };
  /** around の before・after の上限 */
  aroundMax: number;
  /** find が返す段落の上限 */
  findLimitMax: number;
};

/** モデルが読む型定義。道具の説明文に埋め込む。上限値は方針（policy）から渡す */
export function sandboxTypes(b: SandboxBounds): string {
  const sec = (ms: number) => `${ms / 1000}秒`;
  const range = Array.from({ length: b.aroundMax + 1 }, (_, i) => i).join(" | ");
  return `
type Source = { kind: "web" | "github" | "arxiv" | "work"; url: string; title?: string; locator?: string;
  tier: "paper" | "official" | "encyclopedia" | "other"; work?: { authors: string[]; year?: number; venue?: string; doi?: string; abstract?: false } };
type Passage = { passageId: string; sourceId: string; text: string; context?: string };  // context は見出し（引用しない）
type Bundle = { runId: string; procedure: string; question: { version: number }; sources: Record<string, Source>; passages: Passage[];
  ledgerHits: { passageId: string; sourceId: string; excerpt: string; status: string; verifiedAt: string }[];
  pending: { what: string; since: string }[];
  cutoffs: { what: string; why: ${CUTOFF_REASONS.map((r) => `"${r}"`).join(" | ")}; detail?: string; urls?: string[]; sourceId?: string }[];
  progress: Record<string, number>; done: boolean; notices: { kind: string; why?: string; next?: string }[] };
type Status = { index: number; status: "引用確認済" | "引用確認済（表記差あり）" | "照合失敗" | "未照合";
  reason?: string; next?: string; nearest?: { text: string; score: number } };   // 失敗は next に従う
type HubError = { error: { code: string; retryable: boolean; message: string; next: string } };
type Q = { question: string; queries?: string[]; urls?: string[]; sources?: ("web" | "scholarly")[]; waitMs?: number };
type Extra = Promise<{ sources: Record<string, Source>; passages: Passage[]; notices: { kind: string }[] } | HubError>;

declare const research: {
  // 待ちは survey ${sec(b.startMs.survey)}・lookup ${sec(b.startMs.lookup)}。maxPassages は lookup ${b.maxPassages.lookup}・survey ${b.maxPassages.survey} まで（超えた分は丸めて clamped）
  start(q: Q & { mode: "lookup" | "survey"; maxPassages?: number }): Promise<Bundle | HubError>;
  next(runId: string, opts?: { waitMs?: number }): Promise<Bundle | HubError>;   // waitMs は ${sec(b.waitMsMax)}まで（超えた分は丸める）
  around(runId: string, passageId: string, opts?: { before?: ${range}; after?: ${range} }): Extra;
  find(runId: string, sourceIdOrUrl: string, text: string, opts?: { limit?: number }): Extra;   // limit は ${b.findLimitMax} まで
  verify(runId: string, claims: { text: string; cite: { passageId: string; quote: string }[] }[]): Promise<{ statuses: Status[] } | HubError>;
  steer(runId: string, q: Q): Promise<Bundle | HubError>;
  deepen(runId: string): Promise<Bundle | HubError>;
  help(): Promise<{ procedure: string; description: string }>;   // 今の手順と型
};
`.trim();
}
