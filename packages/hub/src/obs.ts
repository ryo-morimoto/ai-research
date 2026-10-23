/**
 * 遅いストレージ操作だけを記録する（設計 v1.3 §12：時間切れの律速を測るまで締め切りで隠さない）。
 * Workers の観測（observability）に JSON の1行として残る。速いときは何も書かない。
 */
export const SLOW_STORAGE_MS = 1_000;

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms >= SLOW_STORAGE_MS) console.log(JSON.stringify({ event: "slow_storage", label, ms }));
  }
}
