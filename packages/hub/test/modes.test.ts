import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { POLICY } from "@ai-research/policy";
import { presentCutoffs } from "../src/cutoffs.ts";
import { timeScale } from "../src/time.ts";
import { inspect, run, sleep, upstreamLog, upstreamSet } from "./helpers.ts";
import { checkRunTrace, type Ev } from "./trace.ts";

const scale = timeScale(env);
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
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限", queries: ["limits"] });
    expect(b.done).toBe(false);
    expect(await stub.close()).toBe(true);
    const n = await stub.next(0);
    expect(n.done).toBe(true);
    const { events } = await inspect(stub);
    checkRunTrace(events as Ev[], { timeScale: scale });
    expect(await run("run_mode_nonexistent0").close()).toBe(false);
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
      { what: "検索で見つけたページ 3 件", why: "timeout", detail: "取れなかった：timeout 2、blocked 1" },
    ]);
    expect(presentCutoffs([{ origin: "search", cutoff: { what: "https://b.example/", why: "timeout" } }])).toEqual([{ what: "https://b.example/", why: "timeout" }]);
  });
});
