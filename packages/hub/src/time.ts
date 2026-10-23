import { POLICY } from "@ai-research/policy";
import type { Env } from "./env.ts";

/** 試験のときだけ待ち時間を縮める。本番では 1 */
export function timeScale(env: Env): number {
  const s = Number(env.TEST_TIME_SCALE ?? "1");
  return Number.isFinite(s) && s > 0 ? s : 1;
}

export function sleep(ms: number, env: Env, signal?: AbortSignal): Promise<void> {
  const real = Math.max(0, ms * timeScale(env));
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, real);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** 締め切り付きで待つ。締め切りを過ぎたら undefined */
export async function withDeadline<T>(p: Promise<T>, ms: number, env: Env): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms * timeScale(env)));
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type Deadlines = typeof POLICY.deadlines;

/** 方針の時間上限。試験では TEST_DEADLINES（JSON）で一部を差し替えられる */
export function deadlines(env: Env): Deadlines {
  if (!env.TEST_DEADLINES) return POLICY.deadlines;
  try {
    return { ...POLICY.deadlines, ...(JSON.parse(env.TEST_DEADLINES) as Partial<Deadlines>) };
  } catch {
    return POLICY.deadlines;
  }
}
