/**
 * 予算（docs/03 §2.6.7、制約 R-01）
 *
 * ハブが数えるのは、会話に返した量と、照合で受け取った量。
 * 束を返す前に「使用量＋束の量」が段階の上限を超えないかを確かめ、
 * 超えるなら残りに収まる量だけを許して止める（不変条件 INV-9、性質 P6）。
 */
export type Phase = "first" | "continue" | "deep";

export const DEFAULT_CAPS: Record<Phase, number> = {
  first: 100_000,
  continue: 600_000,
  deep: 1_400_000,
};

export type BudgetState = { used: number; phase: Phase; stopped: boolean };

export type Admission = { allowed: number; stop: boolean; state: BudgetState };

/** 段階の上限（累計）。continue と deep は最初の結果からの合計 */
export function capFor(phase: Phase, caps: Record<Phase, number> = DEFAULT_CAPS): number {
  return caps[phase];
}

/**
 * want トークンを使いたいときに、実際に使ってよい量を返す。
 * allowed は 0 以上 want 以下。used + allowed は上限を超えない。
 */
export function admit(state: BudgetState, want: number, caps: Record<Phase, number> = DEFAULT_CAPS): Admission {
  const w = Math.max(0, Math.floor(want));
  if (state.stopped) return { allowed: 0, stop: true, state };
  const cap = capFor(state.phase, caps);
  const remaining = Math.max(0, cap - state.used);
  if (w <= remaining) {
    return { allowed: w, stop: false, state: { ...state, used: state.used + w } };
  }
  return { allowed: remaining, stop: true, state: { ...state, used: state.used + remaining, stopped: true } };
}

/** 段階を進める（最初の結果 → 続き → 深掘り）。止まっていたら、上限が上がる段階に進むときだけ再開する */
export function advance(state: BudgetState, phase: Phase, caps: Record<Phase, number> = DEFAULT_CAPS): BudgetState {
  const stopped = state.stopped && capFor(phase, caps) <= state.used;
  return { ...state, phase, stopped };
}
