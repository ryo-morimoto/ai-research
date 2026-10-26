import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TraceEvent } from "@ai-research/core";
import { traceStub, type TraceDO } from "../src/trace.ts";
import { run, sleep } from "./helpers.ts";

/**
 * 調査の記録（docs/05）。
 *   V-02  1回の調査の流れが事象として残る
 *   C-03  記録に失敗しても調査は止まらない
 *   C-04  段落の本文は残らない
 *   C-08  取り消しは墓標。墓標の後は読み取りに出ず、遅れて届いた事象も捨てる
 *   C-10  保持期間を過ぎた事象は消える
 */
let n = 0;
const newRun = () => {
  const id = `run_trace_${++n}_${crypto.randomUUID().slice(0, 6)}`;
  return { id, stub: run(id) };
};
const tr = () => traceStub(env);

/** 送るのを待たないので、届くまで待つ */
async function eventsUntil(runId: string, until: (evs: TraceEvent[]) => boolean, ms = 15_000): Promise<TraceEvent[]> {
  const t0 = Date.now();
  for (;;) {
    const evs = await tr().events(runId);
    if (until(evs) || Date.now() - t0 > ms) return evs;
    await sleep(50);
  }
}
const has = (type: TraceEvent["type"]) => (evs: TraceEvent[]) => evs.some((e) => e.type === type);

async function patchTraceEnv(patch: Record<string, string | undefined>) {
  await runInDurableObject(tr(), (inst: TraceDO) => {
    const self = inst as unknown as { env: Record<string, unknown> };
    self.env = { ...self.env, ...patch };
  });
}

describe("調査の記録（TraceDO）", () => {
  it("V-02：1回の調査の流れが、調査の中の順に残る。集計は事象と合う", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    let last = b;
    while (!last.done) last = await stub.next(50_000);
    const evs = await eventsUntil(id, has("run.done"));
    const types = new Set(evs.map((e) => e.type));
    for (const t of ["run.started", "search.sent", "source.fetched", "passage.selected", "cutoff", "run.done"] as const) expect(types.has(t), t).toBe(true);
    expect(evs[0]!.type).toBe("run.started");
    // 調査の中の順（ev）は単調に増える
    for (let i = 1; i < evs.length; i++) expect(evs[i]!.ev).toBeGreaterThan(evs[i - 1]!.ev);

    const started = evs.find((e) => e.type === "run.started")!;
    expect(started).toMatchObject({ question: "取得先の制限は", mode: "survey", queries: ["limits"] });
    // 束で届けた段落は、すべて記録にある
    const delivered = new Set(evs.filter((e) => e.type === "passage.selected").map((e) => (e as { passageId: string }).passageId));
    expect(delivered.has(b.passages[0]!.passageId)).toBe(true);
    // 拒まれた取得は、理由とホストつきで残る（目的 2 の偏りの材料）
    const blocked = evs.find((e) => e.type === "cutoff" && e.why === "blocked") as Extract<TraceEvent, { type: "cutoff" }> | undefined;
    expect(blocked?.host).toBeTruthy();

    const [summary] = await tr().runs({ limit: 5 });
    expect(summary).toMatchObject({ runId: id, done: true, question: "取得先の制限は", mode: "survey" });
    expect(summary!.passages).toBe(evs.filter((e) => e.type === "passage.selected").length);
    expect(summary!.sources).toBe(evs.filter((e) => e.type === "source.fetched" && !e.reused).length);
    expect(summary!.cutoffs).toBe(evs.filter((e) => e.type === "cutoff").length);
    expect(summary!.events).toBe(evs.length);
  });

  it("C-04：段落の本文は記録に残らない", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    await eventsUntil(id, has("passage.selected"));
    const dump = await tr().exportJsonl({ runId: id });
    expect(dump.length).toBeGreaterThan(0);
    for (const p of b.passages) expect(dump.includes(p.text), p.passageId).toBe(false);
    expect(dump).not.toMatch(/"text":/);
  });

  it("verify の結果が、主張ごとの状態と記録された recordId で残る", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    const p = b.passages[0]!;
    const r = await stub.verify([{ text: "主張", cite: [{ passageId: p.passageId, quote: p.text.slice(0, 20) }] }]);
    expect(r.statuses[0]!.status).toMatch(/^引用確認済/);
    const evs = await eventsUntil(id, has("verify.done"));
    const v = evs.find((e) => e.type === "verify.done") as Extract<TraceEvent, { type: "verify.done" }>;
    const claims = v.claims ?? [];
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ passageIds: [p.passageId], recorded: r.statuses[0]!.recorded });
    expect((await tr().runs())[0]!.verified).toBe(1);
  });

  it("steer は版の変化として残り、使い回した出典は数え直さない", async () => {
    const { id, stub } = newRun();
    await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    await stub.steer({ question: "取得先の制限の数値", queries: ["limits"] });
    const evs = await eventsUntil(id, (es) => es.some((e) => e.type === "run.steered") && es.some((e) => e.type === "source.fetched" && e.v === 2));
    const steered = evs.find((e) => e.type === "run.steered")!;
    expect(steered).toMatchObject({ v: 2, question: "取得先の制限の数値" });
    expect(evs.some((e) => e.type === "source.fetched" && e.v === 2 && e.reused)).toBe(true);
    const [s] = await tr().runs();
    expect(s!.version).toBe(2);
    expect(s!.sources).toBe(evs.filter((e) => e.type === "source.fetched" && !e.reused).length);
  });

  it("C-03：記録の書き込みが失敗しても、調査は束を返す", async () => {
    await patchTraceEnv({ TEST_TRACE_FAIL: "1" });
    try {
      const { id, stub } = newRun();
      const b = await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
      expect(b.passages.length).toBeGreaterThan(0);
      await sleep(200);
    } finally {
      await patchTraceEnv({ TEST_TRACE_FAIL: undefined });
    }
    expect(await tr().runs()).toEqual([]);
  });

  it("C-08：取り消すと読み取りに出ない。遅れて届いた事象も捨てる。墓標は書き出しに残る", async () => {
    const { id, stub } = newRun();
    await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    await eventsUntil(id, has("passage.selected"));
    expect((await tr().forget(id, "試験")).ok).toBe(true);
    expect(await tr().events(id)).toEqual([]);
    expect((await tr().runs()).some((r) => r.runId === id)).toBe(false);
    const late = await tr().append(JSON.stringify([{ type: "run.deepened", runId: id, at: Date.now(), ev: 999, v: 1 }]));
    expect(late).toEqual({ accepted: 0, rejected: 1 });
    const dump = await tr().exportJsonl();
    expect(dump).not.toMatch(new RegExp(`"runId":"${id}"`));
    expect(dump).toMatch(/"type":"tombstone"/);
  });

  it("整形で落ちる事象は数えて捨てる（種類が分からない・必須の欄がない）", async () => {
    const r = await tr().append(
      JSON.stringify([
        { type: "passage.text", runId: "r", at: 1, ev: 1, v: 1, text: "本文" },
        { type: "source.fetched", runId: "r", at: 1, ev: 2, v: 1 },
        { type: "run.deepened", runId: "r", at: 1, ev: 3, v: 1 },
      ]),
    );
    expect(r).toEqual({ accepted: 1, rejected: 2 });
  });

  it("C-10：保持期間を過ぎた事象と集計は消える", async () => {
    const old = Date.now() - 91 * 86_400_000;
    await tr().append(JSON.stringify([{ type: "run.started", runId: "old_run", at: old, ev: 1, v: 1, question: "古い問い", mode: "lookup" }]));
    expect((await tr().runs()).some((r) => r.runId === "old_run")).toBe(true);
    // 消す間隔を待たずに、次の追記で消させる
    await runInDurableObject(tr(), (inst: TraceDO) => {
      (inst as unknown as { lastPrune: number }).lastPrune = 0;
    });
    await tr().append(JSON.stringify([{ type: "run.started", runId: "new_run", at: Date.now(), ev: 1, v: 1, question: "新しい問い", mode: "lookup" }]));
    const ids = (await tr().runs()).map((r) => r.runId);
    expect(ids).toContain("new_run");
    expect(ids).not.toContain("old_run");
    expect(await tr().events("old_run")).toEqual([]);
  });

  it("V-03：調査の流れには、問いの版ごとの概念とずれの印が付く。打ち切りには出典の種類が付く", async () => {
    const { id, stub } = newRun();
    let b = await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    while (!b.done) b = await stub.next(50_000);
    await eventsUntil(id, has("run.done"));
    const r = await tr().run(id);
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]!.concepts.map((c) => c.label)).toEqual(["limits"]);
    const blocked = r.events.find((e) => e.type === "cutoff" && e.why === "blocked") as Extract<TraceEvent, { type: "cutoff" }>;
    expect(blocked.kind).toBe("web");
    expect(blocked.tier).toBeTruthy();
  });

  it("V-04・V-10：取りこぼしを理由・ホスト・種類・手順の版ごとに数え、元の調査へたどれる", async () => {
    const t = Date.now();
    let ev = 0;
    const E = (runId: string, e: Record<string, unknown>) => ({ runId, at: t, ev: ++ev, v: 1, ...e });
    await tr().append(
      JSON.stringify([
        E("g1", { type: "run.started", question: "q1", mode: "survey", procedureVersion: "A" }),
        E("g1", { type: "source.fetched", sourceId: "s1", url: "https://a.example/x", host: "a.example", tier: "official" }),
        E("g1", { type: "source.fetched", sourceId: "s2", url: "https://a.example/x", host: "a.example", tier: "official", reused: true }),
        E("g1", { type: "cutoff", what: "https://b.example/y", why: "blocked", host: "b.example", kind: "web", tier: "other" }),
        E("g1", { type: "cutoff", what: "https://b.example/z", why: "timeout", host: "b.example", kind: "web", tier: "other" }),
        E("g1", { type: "verify.done", claims: [{ status: "照合失敗", reason: "near_miss", passageIds: ["p1"], recorded: [] }, { status: "引用確認済", passageIds: ["p2"], recorded: ["r1"] }] }),
        E("g2", { type: "run.started", question: "q2", mode: "lookup", procedureVersion: "B" }),
        E("g2", { type: "cutoff", what: "検索: q2", why: "error" }),
        E("g2", { type: "cutoff", what: "https://b.example/w", why: "blocked", host: "b.example", kind: "web", tier: "other" }),
        E("g3", { type: "run.started", question: "q3", mode: "lookup", procedureVersion: "B" }),
        E("g3", { type: "cutoff", what: "https://c.example/", why: "robots", host: "c.example" }),
      ]),
    );
    await tr().forget("g3");
    const g = await tr().gaps(7);
    expect(g.byWhy).toEqual([
      { why: "blocked", n: 2 },
      { why: "error", n: 1 },
      { why: "timeout", n: 1 },
    ]);
    expect(g.byHost[0]).toEqual({ host: "b.example", fetched: 0, cutoffs: 3, reasons: { blocked: 2, timeout: 1 } });
    expect(g.byHost.find((h) => h.host === "")).toMatchObject({ cutoffs: 1, reasons: { error: 1 } });
    expect(g.byHost.some((h) => h.host === "c.example")).toBe(false);
    expect(g.byTier).toEqual([
      { tier: "official", fetched: 1, cutoffs: 0 },
      { tier: "other", fetched: 0, cutoffs: 3 },
    ]);
    expect(g.byVersion.map((v) => [v.procedureVersion, v.runs, v.cutoffs])).toEqual([
      ["A", 1, 2],
      ["B", 1, 2],
    ]);
    expect(g.verifyReasons).toEqual([{ reason: "near_miss", n: 1 }]);
    expect((await tr().gapRuns({ host: "b.example" })).map((r) => r.runId).sort()).toEqual(["g1", "g2"]);
    expect((await tr().gapRuns({ host: "b.example", why: "timeout" })).map((r) => r.runId)).toEqual(["g1"]);
    expect((await tr().gapRuns({ host: "" })).map((r) => r.runId)).toEqual(["g2"]);
  });
});
