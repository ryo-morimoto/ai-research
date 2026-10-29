/**
 * 観測（observability）の事象は、この1つの union で宣言する（ADR-0001。issues/001・003・004 の根本対応）。
 * Workers の観測に JSON の1行として残る。ここにない形の console.log を書かない
 * （Cloudflare 側の集計・SLO の Meter がこの形に依存する）。
 */
export type ObsEvent =
  /** 遅いストレージ操作（issue 004 の律速の計測。速いときは書かない） */
  | { event: "slow_storage"; label: string; ms: number }
  /** 境界で HubError に直した失敗（issue 002 の分析はこの行を数える） */
  | { event: "hub_error"; message: string; runId?: string | undefined }
  /** code の道具の実行がエラーを返した（issue 001：これまで記録がなかった） */
  | { event: "code_error"; message: string }
  /** 調査の記録を送れなかった（C-03：調査は失敗しない。落とした数だけ残す） */
  | { event: "trace_dropped"; n: number; total: number; error: string };

export function emit(e: ObsEvent): void {
  console.log(JSON.stringify(e));
}

/** 遅いストレージ操作だけを記録する（時間切れの律速を測るまで締め切りで隠さない。issue 004） */
export const SLOW_STORAGE_MS = 1_000;

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= SLOW_STORAGE_MS) emit({ event: "slow_storage", label, ms });
  }
}
