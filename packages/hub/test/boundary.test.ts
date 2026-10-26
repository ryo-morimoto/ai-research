import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { providers } from "../src/sandbox.ts";
import { classify } from "../src/boundary.ts";

/** 実行環境に渡す関数を直接呼ぶ（code mode の実行環境を経ずに、境界の振る舞いだけを見る） */
function fns(e: typeof env = env) {
  const [research, ledger] = providers(e);
  return { research: research!.fns as Record<string, (...a: unknown[]) => Promise<any>>, ledger: ledger!.fns as Record<string, (...a: unknown[]) => Promise<any>> };
}

/** RunDO の呼び出しが必ず失敗する env（ストレージの時間切れを模す） */
function failingRuns(message: string, extra: Record<string, unknown> = {}): typeof env {
  const stub = new Proxy({}, { get: () => async () => { throw Object.assign(new Error(message), extra); } });
  return { ...env, RUNS: { idFromName: () => ({}), get: () => stub } as unknown as typeof env.RUNS };
}

describe("実行環境との境界（P-05、設計 v1.3 D12）", () => {
  it("ストレージの時間切れ・過負荷は busy（再試行してよい）として値で返す。例外にしない", async () => {
    const { research } = fns(failingRuns("Durable Object storage operation exceeded timeout which caused object to be reset."));
    const r = await research.start!({ question: "x", mode: "survey", queries: ["a"] });
    expect(r.error).toMatchObject({ code: "busy", retryable: true });
    expect(r.error.next).toContain("もう一度");
    const n = await research.next!("run_0123456789abcdef", { waitMs: 0 });
    expect(n.error).toMatchObject({ code: "busy", runId: "run_0123456789abcdef" });
    const o = await fns(failingRuns("boom", { overloaded: true })).research.verify!("run_0123456789abcdef", []);
    expect(o.error.code).toBe("busy");
  });

  it("型に合わない値は bad_input。どこが合わないかを返す", async () => {
    const { research } = fns();
    const r = await research.start!({ queries: ["a"] });
    expect(r.error).toMatchObject({ code: "bad_input", retryable: true });
    expect(r.error.message).toContain("start.question");
    expect((await research.next!("not-a-run-id")).error.code).toBe("bad_input");
    // 依頼の種類は必ず選ぶ（D9）
    expect((await research.start!({ question: "x", queries: ["a"] })).error.message).toContain("start.mode");
    expect((await research.start!({ question: "x", mode: "lookup", urls: ["not a url"] })).error.message).toContain("start.urls");
  });

  it("ない runId は run_not_found（start からやり直す）", async () => {
    const { research } = fns();
    const r = await research.next!("run_00000000-0000-0000-0000-000000000000", { waitMs: 0 });
    expect(r.error).toMatchObject({ code: "run_not_found", retryable: false, runId: "run_00000000-0000-0000-0000-000000000000" });
    expect(r.error.next).toContain("research.start");
  });

  it("分からない失敗は internal（経路外で調べる）", () => {
    expect(classify(new Error("something odd"))).toBe("internal");
    expect(classify(new Error("Network connection lost."))).toBe("busy");
  });
});

import { CODE_TOOL_DESCRIPTION, ROUTE_DENY_REASON } from "@ai-research/policy";
import { StartInput as StartSchema } from "../src/boundary.ts";

describe("説明文の例は API の型に合う（設計 v1.4。例と型がずれて bad_input になったことの再発防止）", () => {
  it("research.start の例は、すべて StartInput として読める", () => {
    const examples = [...`${CODE_TOOL_DESCRIPTION}\n${ROUTE_DENY_REASON}`.matchAll(/research\.start\((\{[^\n]*?\})\)/g)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const src of examples) {
      const value = new Function(`return (${src.replaceAll("…", "x")});`)() as unknown;
      const r = StartSchema.safeParse(value);
      expect(r.success, src).toBe(true);
    }
  });
});

describe("API の約束（設計 v1.5 §8.3.7）", () => {
  it("around の before・after は3に丸め、clamped で知らせる（bad_input にしない）", async () => {
    const { research } = fns();
    const b = await research.start!({ question: "プロンプトキャッシュの前置き", mode: "lookup", urls: ["https://docs.example.com/cache"] });
    const pid = b.passages[0].passageId;
    const r = await research.around!(b.runId, pid, { before: 10, after: 5 });
    expect(r.error).toBeUndefined();
    expect(r.notices).toEqual(expect.arrayContaining([{ kind: "clamped", field: "before", max: 3 }, { kind: "clamped", field: "after", max: 3 }]));
  });

  it("verify の照合失敗・未照合に、理由ごとの次の手が付く", async () => {
    const { research } = fns();
    const b = await research.start!({ question: "プロンプトキャッシュの前置き", mode: "lookup", urls: ["https://docs.example.com/cache"] });
    const v = await research.verify!(b.runId, [
      { text: "a", cite: [] },
      { text: "b", cite: [{ passageId: "p99999", quote: "x" }] },
    ]);
    expect(v.statuses[0]).toMatchObject({ status: "未照合", reason: "no_citation" });
    expect(v.statuses[0].next).toContain("背景知識");
    expect(v.statuses[1]).toMatchObject({ status: "照合失敗", reason: "unknown_passage" });
    expect(v.statuses[1].next).toContain("passageId");
  });

  it("束は軽い：問いの文を繰り返さず、URL と同じ locator を省き、maxPassages で段落を絞れる", async () => {
    const { research } = fns();
    const b = await research.start!({ question: "取得先の制限とキャッシュ", mode: "survey", queries: ["limits", "cache"], maxPassages: 2 });
    expect(b.question).toEqual({ version: 1 });
    expect(b.passages.length).toBeLessThanOrEqual(2);
    for (const s of Object.values(b.sources) as { url: string; locator?: string }[]) expect(s.locator).not.toBe(s.url);
  });
});
