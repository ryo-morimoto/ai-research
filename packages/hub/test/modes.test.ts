import { describe, it, expect } from "vitest";
import { env, runInDurableObject, evictDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { routeStub } from "../src/route.ts";
import type { RunDO } from "../src/run.ts";
import { POLICY } from "@ai-research/policy";
import { presentCutoffs } from "../src/cutoffs.ts";
import { timeScale } from "../src/time.ts";
import { excerptFrom, inspect, ledger, run, sleep, upstreamLog, upstreamSet } from "./helpers.ts";
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
    expect(b.passages.every((p) => b.sources[p.sourceId]?.url === "https://docs.example.com/limits")).toBe(true);
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

describe("進行中と喪失（設計 v1.5 §8.3.2、制約 Q-04）", () => {
  it("done の束では、終わらなかった作業は gave_up として cutoffs に入る。pending は空", async () => {
    const { id, stub } = newRun();
    await slowPage(stub);
    const b = await stub.start(id, { mode: "lookup", question: "遅い", urls: ["https://chain.example.com/page"] });
    expect(b.done).toBe(true);
    expect(b.pending).toEqual([]);
    expect(b.cutoffs).toContainEqual(expect.objectContaining({ what: "https://chain.example.com/page", why: "gave_up" }));
    const { events } = await inspect(stub);
    checkRunTrace(events as Ev[], { timeScale: scale });
  });

  it("waitMs を渡すと、種類の締め切りより早く最初の束を返す", async () => {
    const { id, stub } = newRun();
    await slowPage(stub);
    const t0 = Date.now();
    const b = await stub.start(id, { mode: "survey", question: "遅い", urls: ["https://chain.example.com/page"], waitMs: 1_000 });
    expect(Date.now() - t0).toBeLessThan(POLICY.modes.survey.startMs * scale);
    expect(b.pending.length).toBeGreaterThan(0);
    await stub.close();
  });

  it("台帳の候補は、照らし直しが決着するまで出さない。終わりまで決着しなければ「取得できず未照合」", async () => {
    const l = ledger();
    const text = "遅い出典の抜き書きの文です。";
    await l.appendVerified(excerptFrom(text, text, { url: "https://chain.example.com/page", locator: "x" }), "volatile", "r");
    const { id, stub } = newRun();
    await slowPage(stub);
    const b = await stub.start(id, { mode: "survey", question: "遅い出典の抜き書き", queries: [] });
    expect(b.ledgerHits).toEqual([]);
    await stub.close();
    const n = await stub.next(0);
    expect(n.ledgerHits.map((h) => h.status)).toEqual(["取得できず未照合"]);
  });
});

describe("行き止まりをなくす（no_passage と research.find、設計 v1.5 §8.3.3、制約 P-07）", () => {
  it("取得できたのに段落が選ばれなかった出典は、終わった束で no_passage として出る。find で探せて、照合できる。WebFetch も通る", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "lookup", question: "量子コンピュータの誤り訂正", queries: ["qubit"], urls: ["https://docs.example.com/cache"] });
    expect(b.passages).toHaveLength(0);
    const np = b.cutoffs.find((c) => c.why === "no_passage")!;
    expect(np).toMatchObject({ what: "https://docs.example.com/cache", why: "no_passage" });
    expect(np.sourceId).toMatch(/^s\d+$/);
    const f = await stub.find(np.sourceId!, "前置きが完全に一致");
    expect(f.passages[0]!.text).toContain("前置きが完全に一致");
    expect(f.sources[f.passages[0]!.sourceId]?.url).toBe("https://docs.example.com/cache");
    const v = await stub.verify([{ text: "x", cite: [{ passageId: f.passages[0]!.passageId, quote: "プロンプトキャッシュは前置きが完全に一致したときにだけ効く。" }] }]);
    expect(v.statuses[0]!.status).toBe("引用確認済");
    // URL でも探せる。当たらなければ理由を返す
    expect((await stub.find("https://docs.example.com/cache", "料金")).passages.length).toBeGreaterThan(0);
    expect((await stub.find("https://docs.example.com/cache", "zzzz")).notices[0]).toMatchObject({ kind: "empty" });
    expect((await stub.find("s999", "x")).notices[0]).toMatchObject({ kind: "source_not_found" });
    await sleep(50);
    expect(await routeStub(env).decide({ session: "s", tool: "WebFetch", url: "https://docs.example.com/cache" })).toMatchObject({ kind: "allow", why: "cutoff" });
    // 退避の後も find できる
    await evictDurableObject(stub);
    expect((await stub.find(np.sourceId!, "前置き")).passages.length).toBeGreaterThan(0);
  });

  it("段落が届いた出典は no_passage にしない。まだ終わっていない束でも出さない", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "プロンプトキャッシュの前置き", queries: ["cache"] });
    const last = b.done ? b : await stub.next(50_000);
    expect([...b.cutoffs, ...last.cutoffs].some((c) => c.why === "no_passage")).toBe(false);
  });
});

describe("段落の前後（research.around、設計 v1.4 §8.2.5）", () => {
  const page = `<html><head><title>Conditions</title></head><body><article><h1>Conditions for intuitive expertise</h1>
    <p>Kahneman and Klein argue that intuitive expertise develops only under particular conditions of the environment.</p>
    <p>Intuitive judgments can be trusted when both of the following conditions hold:</p>
    <ul><li>an environment that is sufficiently regular to be predictable</li><li>an opportunity to learn these regularities through prolonged practice</li></ul>
    <p>Without these, confidence is not a reliable signal of accuracy.</p>
  </article></body></html>`;

  it("前後の塊を、照合できる段落として返す。導入の文は箇条の context になる。退避の後も取り直して返す", async () => {
    const { id, stub } = newRun();
    await upstreamSet({ url: "https://paper.example.org/kk2009", contentType: "text/html", body: page });
    const b = await stub.start(id, { mode: "lookup", question: "Kahneman Klein intuitive expertise conditions", urls: ["https://paper.example.org/kk2009"] });
    const first = b.passages.find((p) => p.text.startsWith("Kahneman and Klein argue"))!;
    expect(first).toBeDefined();
    const ar = await stub.around(first.passageId, 0, 3);
    expect(ar.passages.map((p) => p.text)).toEqual([
      first.text,
      "Intuitive judgments can be trusted when both of the following conditions hold:",
      "an environment that is sufficiently regular to be predictable",
      "an opportunity to learn these regularities through prolonged practice",
    ]);
    expect(ar.passages[0]!.passageId).toBe(first.passageId);
    expect(ar.passages[2]!.context).toContain("both of the following conditions hold:");
    const lead = ar.passages[1]!;
    const second = ar.passages[3]!;
    const v = await stub.verify([{ text: "練習で学ぶ機会", cite: [{ passageId: second.passageId, quote: "an opportunity to learn these regularities through prolonged practice" }] }]);
    expect(v.statuses[0]!.status).toBe("引用確認済");
    await evictDurableObject(stub);
    const again = await stub.around(lead.passageId, 1, 0);
    expect(again.passages.map((p) => p.text)[1]).toBe(lead.text);
    expect(again.passages[0]!.text).toContain("Kahneman and Klein argue");
  });

  it("知らない段落・古い版の段落は、理由を返す", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "プロンプトキャッシュ", queries: ["cache"] });
    expect((await stub.around("p999", 1, 1)).notices[0]).toMatchObject({ kind: "passage_not_found" });
    const p = b.passages[0]!;
    await stub.steer({ question: "取得先の制限", queries: ["limits"] });
    expect((await stub.around(p.passageId, 1, 1)).notices[0]).toMatchObject({ kind: "superseded" });
  });
});
