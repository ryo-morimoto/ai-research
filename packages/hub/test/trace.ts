import { expect } from "vitest";
import { POLICY } from "@ai-research/policy";

/**
 * 実行の記録（RunDO の events）を specs/run.qnt の不変条件に照らす（docs/03 §3.3 の trace の検査）。
 *   INV-8  束を返した時点で終わっていない現在の版の作業は、その束の cutoffs に数えられている
 *   INV-9  使用量は段階の上限を超えない
 *   INV-10 束の段落はすべて現在の版のもの。作業は現在の版でしか始まらない
 *   INV-11 深掘りでなければ、続きの上限を過ぎて（または終えた後に）作業を始めない
 */
export type Ev = { ev: number; at: number; type: string; [k: string]: unknown };

export function checkRunTrace(events: Ev[], opts: { timeScale: number; continueUntilMs?: number }): { bundles: number; tasks: number } {
  const continueUntil = (opts.continueUntilMs ?? POLICY.deadlines.continueUntilMs) * opts.timeScale;
  let version = 0;
  let startAt = 0;
  let deep = false;
  let finished = false;
  const running = new Map<number, number>(); // task id -> v
  let bundles = 0;
  let tasks = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (i > 0) expect(e.ev, "ev は単調に増える").toBeGreaterThan(events[i - 1]!.ev);
    switch (e.type) {
      case "start":
        version = e.v as number;
        startAt = e.at;
        break;
      case "steer":
        version = e.v as number;
        finished = false;
        break;
      case "deepen":
        deep = true;
        finished = false;
        break;
      case "finish":
        finished = true;
        break;
      case "task_start": {
        tasks++;
        const v = e.v as number;
        expect(v, `INV-10：作業 ${e.id} は現在の版で始まる`).toBe(version);
        if (!deep) {
          expect(finished, `INV-11：終えた後に作業 ${e.id} を始めない`).toBe(false);
          expect(e.at - startAt, `INV-11：続きの上限を過ぎて作業 ${e.id} を始めない`).toBeLessThan(continueUntil + 50);
        }
        running.set(e.id as number, v);
        break;
      }
      case "task_done":
        running.delete(e.id as number);
        break;
      case "bundle": {
        bundles++;
        const v = e.v as number;
        expect(v).toBe(version);
        const pv = e.passageVersions as number[];
        for (const x of pv) expect(x, "INV-10：束の段落は現在の版のもの").toBe(v);
        const runningNow = [...running.entries()].filter(([, tv]) => tv === v).map(([id]) => id).sort((a, b) => a - b);
        const reported = [...(e.cutoffTasks as number[])].sort((a, b) => a - b);
        expect(reported, "INV-8：終わっていない作業はすべて打ち切りとして数える").toEqual(runningNow);
        expect(e.cutoffs as number, "INV-8：束の cutoffs に入っている").toBeGreaterThanOrEqual(runningNow.length);
        expect(e.used as number, "INV-9：使用量は段階の上限を超えない").toBeLessThanOrEqual(e.cap as number);
        break;
      }
    }
  }
  return { bundles, tasks };
}
