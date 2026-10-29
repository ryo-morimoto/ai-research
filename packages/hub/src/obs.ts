/**
 * 観測（observability）の事象は、この1つの union で宣言する（ADR-0001。issues/001・003・004 の根本対応）。
 * Workers の観測に JSON の1行として残る。ここにない形の console.log を書かない
 * （Cloudflare 側の集計・SLO の Meter がこの形に依存する）。
 */
export type ObsEvent =
  /** 遅いストレージ操作（issue 004 の律速の計測。速いときは書かない）。bytes は書いた量、n は件数 */
  | { event: "slow_storage"; label: string; ms: number; bytes?: number; n?: number }
  /** 境界で HubError に直した失敗（issue 002 の分析はこの行を数える） */
  | { event: "hub_error"; message: string; runId?: string | undefined }
  /** code の道具の実行がエラーを返した（issue 001：これまで記録がなかった） */
  | { event: "code_error"; message: string }
  /** 境界が型・形の誤りで弾いた（issue 002：何を渡していたかを切り分ける。本文の値は入れない） */
  | { event: "bad_input"; what: string; issues: string; args: string }
  /** HTTP の 4xx を返した（issue 003：理由がログに残らなかった） */
  | { event: "bad_request"; path: string; status: number; reason: string }
  /** 調査の記録を送れなかった（C-03：調査は失敗しない。落とした数だけ残す） */
  | { event: "trace_dropped"; n: number; total: number; error: string };

export function emit(e: ObsEvent): void {
  console.log(JSON.stringify(e));
}

/**
 * 遅いストレージ操作だけを記録する（時間切れの律速を測るまで締め切りで隠さない。issue 004）。
 * 30日で0件 = 前兆が測れていなかったため、しきい値を 1000ms から下げた（docs/06 R3 第1段）
 */
export const SLOW_STORAGE_MS = 250;

/** sizeOf・countOf は遅かったときだけ呼ぶ（速い経路に序列化の費用を足さない） */
export async function timed<T>(label: string, fn: () => Promise<T>, meta?: { sizeOf?: () => number; countOf?: () => number }): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= SLOW_STORAGE_MS) {
      emit({
        event: "slow_storage",
        label,
        ms,
        ...(meta?.sizeOf ? { bytes: meta.sizeOf() } : {}),
        ...(meta?.countOf ? { n: meta.countOf() } : {}),
      });
    }
  }
}
