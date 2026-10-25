import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { routeStub } from "../src/route.ts";
import type { RunDO } from "../src/run.ts";
import { POLICY } from "@ai-research/policy";
import { presentCutoffs } from "../src/cutoffs.ts";
import { timeScale } from "../src/time.ts";
import { inspect, run, sleep, upstreamLog, upstreamSet } from "./helpers.ts";
import { checkRunTrace, type Ev } from "./trace.ts";

const scale = timeScale(env);
/** その実行の DO だけ env を差し替える */
async function patchEnv(stub: DurableObjectStub<RunDO>, patch: Record<string, string>) {
  await runInDurableObject(stub, (inst: RunDO) => {
    const self = inst as unknown as { env: Record<string, unknown> };
    self.env = { ...self.env, ...patch };
  });
}
const slowPage = async (stub: DurableObjectStub<RunDO>) => {
  await patchEnv(stub, { TEST_DEADLINES: JSON.stringify({ fetchMs: 100_000 }) });
  await upstreamSet({ url: "https://chain.example.com/page", delayMs: 3_000, contentType: "text/html", body: "<p>遅い</p>" });
};

const newRun = () => {
  const id = `run_mode_${crypto.randomUUID().slice(0, 8)}`;
  return { id, stub: run(id) };
};

describe("依頼の種類（設計 v1.3 D9、制約 S-06・U-04）", () => {
  it("lookup で URL があれば検索しない。最初の束で終わり、残りの作業は止める", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "lookup", question: "arXiv の API の頻度制限", queries: ["limits"], urls: ["https://docs.example.com/limits"] });
    expect(b.mode).toBe("lookup");
    expect(b.done).toBe(true);
    expect(b.passages.length).toBeGreaterThan(0);
    expect(b.passages.length).toBeLessThanOrEqual(POLICY.modes.lookup.passagesPerBundle);
    expect(b.passages.every((p) => p.source.url === "https://docs.example.com/limits")).toBe(true);
    expect((await upstreamLog()).some((l) => l.url.startsWith("https://search.test/"))).toBe(false);
    const { tasks, events } = await inspect(stub);
    await sleep(50);
    expect((await inspect(stub)).tasks.every((t) => t.done)).toBe(true);
    checkRunTrace(events as Ev[], { timeScale: scale });
    void tasks;
  });

  it("lookup で URL がなければ検索する。段落は lookup の上限まで", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "lookup", question: "取得先の制限とキャッシュ", queries: ["limits", "cache"] });
    expect(b.done).toBe(true);
    expect(b.passages.length).toBeLessThanOrEqual(POLICY.modes.lookup.passagesPerBundle);
    expect((await upstreamLog()).some((l) => l.url.startsWith("https://search.test/"))).toBe(true);
  });

  it("lookup の締め切りに間に合わない利用者の URL は、打ち切りとして1件ずつ示す", async () => {
    const { id, stub } = newRun();
    await upstreamSet({ url: "https://slow.example.com/page", delayMs: 3_000, contentType: "text/html", body: "<p>遅い</p>" });
    const b = await stub.start(id, { mode: "lookup", question: "遅いページ", urls: ["https://slow.example.com/page"] });
    expect(b.done).toBe(true);
    expect(b.cutoffs.map((c) => c.what)).toContain("https://slow.example.com/page");
  });

  it("survey は close で止まる。以後は作業を始めない", async () => {
    const { id, stub } = newRun();
    // 作業が残っている間に止める（作業が尽きれば close しなくても終わる。設計 v1.4 D15）
    await slowPage(stub);
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限", queries: ["limits"], urls: ["https://chain.example.com/page"] });
    expect(b.done).toBe(false);
    expect(await stub.close()).toBe(true);
    const n = await stub.next(0);
    expect(n.done).toBe(true);
    const { events } = await inspect(stub);
    checkRunTrace(events as Ev[], { timeScale: scale });
    expect(await run("run_mode_nonexistent0").close()).toBe(false);
  });
});

describe("終わりと進み具合と0件の理由（設計 v1.4 §8.2.4、制約 P-06）", () => {
  it("survey は作業が尽きたら終わる。続きを待たせない", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "プロンプトキャッシュ", queries: ["cache"] });
    let last = b;
    if (!last.done) last = await stub.next(50_000);
    expect(last.done).toBe(true);
    const t0 = Date.now();
    const again = await stub.next(50_000);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(again.done).toBe(true);
    expect(b.progress.searched).toBe(1);
    expect(b.progress.found).toBeGreaterThanOrEqual(1);
    expect(last.progress.running).toBe(0);
    const { events } = await inspect(stub);
    expect(events.some((e) => e.type === "finish" && e.why === "idle")).toBe(true);
    checkRunTrace(events as Ev[], { timeScale: scale });
  });

  it("見つからない：no_hits と次の手", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "存在しない話題", queries: ["nothingmatches"] });
    const last = b.done ? b : await stub.next(50_000);
    const all = [...b.notices, ...last.notices];
    const e = all.find((x) => x.kind === "empty");
    expect(e).toMatchObject({ kind: "empty", why: "no_hits" });
    expect((e as { next: string }).next).toContain("research.steer");
  });

  it("すべて取れない：all_failed。打ち切りに URL が出る", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "lookup", question: "拒まれるページ", urls: ["https://blocked.example.com/page"] });
    expect(b.notices.find((x) => x.kind === "empty")).toMatchObject({ why: "all_failed" });
    expect(b.cutoffs.map((c) => c.what)).toContain("https://blocked.example.com/page");
    expect(b.progress).toMatchObject({ fetched: 0, failed: 1 });
  });

  it("関係がない：not_relevant", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "lookup", question: "量子コンピュータの誤り訂正", queries: ["qubit"], urls: ["https://docs.example.com/cache"] });
    expect(b.passages).toHaveLength(0);
    expect(b.notices.find((x) => x.kind === "empty")).toMatchObject({ why: "not_relevant" });
  });

  it("まだ集めている：still_running", async () => {
    const { id, stub } = newRun();
    await slowPage(stub);
    const b = await stub.start(id, { mode: "survey", question: "遅い", urls: ["https://chain.example.com/page"] });
    expect(b.done).toBe(false);
    expect(b.notices.find((x) => x.kind === "empty")).toMatchObject({ why: "still_running" });
    await stub.close();
  });

  it("検索が使えない：search_failed。組み込みの検索を経路外として通す（WebFetch は通さない）", async () => {
    const { id, stub } = newRun();
    await patchEnv(stub, { SEARCH_PROVIDER: "none" });
    const b = await stub.start(id, { mode: "lookup", question: "何か", queries: ["limits"] });
    expect(b.notices.find((x) => x.kind === "empty")).toMatchObject({ why: "search_failed" });
    await sleep(50);
    const r = routeStub(env);
    expect(await r.decide({ session: "s", tool: "WebSearch" })).toMatchObject({ kind: "allow", why: "searchDown" });
    expect(await r.decide({ session: "s", tool: "WebFetch", url: "https://x.example/" })).toMatchObject({ kind: "deny" });
  });

  it("一度でも何かを届けた版では、空の差分に0件の通知を付けない", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "プロンプトキャッシュ", queries: ["cache"] });
    expect(b.passages.length).toBeGreaterThan(0);
    const n = await stub.next(0);
    expect(n.notices.some((x) => x.kind === "empty")).toBe(false);
  });
});

describe("打ち切りの見せ方（Q-04）", () => {
  it("利用者の URL・台帳・検索そのものは1件ずつ、検索で見つけたページはまとめる", () => {
    const out = presentCutoffs([
      { origin: "url", cutoff: { what: "https://a.example/", why: "blocked" } },
      { origin: "search", cutoff: { what: "https://b.example/", why: "timeout" } },
      { origin: "search", cutoff: { what: "https://c.example/", why: "blocked" } },
      { origin: "search", cutoff: { what: "https://d.example/", why: "timeout" } },
      { origin: "system", cutoff: { what: "検索: x", why: "not_configured" } },
    ]);
    expect(out).toEqual([
      { what: "https://a.example/", why: "blocked" },
      { what: "検索: x", why: "not_configured" },
      {
        what: "検索で見つけたページ 3 件",
        why: "timeout",
        detail: "取れなかった：timeout 2、blocked 1",
        urls: ["https://b.example/", "https://c.example/", "https://d.example/"],
      },
    ]);
    expect(presentCutoffs([{ origin: "search", cutoff: { what: "https://b.example/", why: "timeout" } }])).toEqual([{ what: "https://b.example/", why: "timeout" }]);
  });

  it("性質：まとめても、取れなかった URL を1つも落とさない", () => {
    const origin = fc.constantFrom("url", "ledger", "search", "system") as fc.Arbitrary<"url" | "ledger" | "search" | "system">;
    const why = fc.constantFrom("timeout", "blocked", "error", "unsupported") as fc.Arbitrary<"timeout">;
    const item = fc.record({ origin, cutoff: fc.record({ what: fc.webUrl(), why }) });
    fc.assert(
      fc.property(fc.array(item, { maxLength: 20 }), (items) => {
        const shown = presentCutoffs(items).flatMap((c) => [c.what, ...(c.urls ?? [])]);
        for (const it of items) expect(shown).toContain(it.cutoff.what);
      }),
    );
  });
});
