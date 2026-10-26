import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import fc from "fast-check";
import { hostPolicy } from "@ai-research/policy";
import { withLease } from "../src/limiter.ts";
import { timeScale } from "../src/time.ts";
import { sleep } from "./helpers.ts";

const limiter = (host: string) => env.LIMITER.get(env.LIMITER.idFromName(host));
const scale = timeScale(env);

/** 記録した開始時刻と、有効だった区間から INV-6 / INV-7 を確かめる */
function checkTrace(starts: number[], intervals: [number, number][], minIntervalMs: number, maxConcurrent: number) {
  const sorted = [...starts].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(minIntervalMs * scale - 1e-6);
  for (const [s] of intervals) {
    const overlapping = intervals.filter(([a, b]) => a <= s && s < b).length;
    expect(overlapping).toBeLessThanOrEqual(maxConcurrent);
  }
}

describe("頻度制限（HostLimiterDO）", () => {
  it("INV-6/7：arXiv の API（3秒に1回、同時1本）を並行の要求でも守る", async () => {
    const host = "export.arxiv.org";
    const policy = hostPolicy(host);
    const intervals: [number, number][] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withLease(env, host, async () => {
          const s = Date.now();
          await sleep(5 + (i % 3) * 5);
          intervals.push([s, Date.now()]);
        }, { waitLimitMs: 60_000 }),
      ),
    );
    const h = await limiter(host).history();
    expect(h.starts.length).toBe(6);
    expect(h.active).toBe(0);
    checkTrace(h.starts, intervals, policy.minIntervalMs, policy.maxConcurrent);
  });

  it("性質：任意の並行の要求の列で INV-6/7 が成り立つ（fast-check）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("api.github.com", "arxiv.org", "raw.githubusercontent.com"),
        fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 8 }),
        async (base, durations) => {
          const host = `${crypto.randomUUID().slice(0, 6)}.${base}`;
          const policy = hostPolicy(host);
          const intervals: [number, number][] = [];
          await Promise.all(
            durations.map((d) =>
              withLease(env, host, async () => {
                const s = Date.now();
                await sleep(d);
                intervals.push([s, Date.now()]);
              }, { waitLimitMs: 120_000 }),
            ),
          );
          const h = await limiter(host).history();
          checkTrace(h.starts, intervals, policy.minIntervalMs, policy.maxConcurrent);
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 15) },
    );
  });

  it("許可証は期限で回収される（返さずに落ちた機械があっても止まらない）", async () => {
    const host = "lost.example.com";
    const policy = { pattern: host, minIntervalMs: 0, maxConcurrent: 1 };
    const stub = limiter(host);
    const a = await stub.acquire(policy, 1_000); // 返さない
    expect(a.granted).toBe(true);
    const b = await stub.acquire(policy, 1_000);
    expect(b.granted).toBe(false);
    await sleep(1_000 * scale + 20);
    const c = await stub.acquire(policy, 1_000);
    expect(c.granted).toBe(true);
  });

  it("待ちが上限を超えるなら LeaseTimeout（黙って長く待たない）", async () => {
    const host = "export.arxiv.org";
    const p = Array.from({ length: 4 }, () => withLease(env, host, async () => "ok", { waitLimitMs: 4_000 }).catch((e) => e));
    const r = await Promise.all(p);
    expect(r.filter((x) => x === "ok").length).toBeGreaterThanOrEqual(1);
    expect(r.some((x) => x instanceof Error && /上限/.test(x.message))).toBe(true);
  });
});

import { env as testEnv } from "cloudflare:test";
import { Gateway } from "../src/gateway.ts";
import { upstreamLog, upstreamSet } from "./helpers.ts";
import { providers } from "../src/sandbox.ts";

describe("拒まれたときの冷却と、並べて呼ぶ上限（設計 v1.5 §8.3.5、制約 E-02）", () => {
  it("429 と Retry-After を受けたら、その取得先への取得を全体で空け、締め切りに収まれば1回だけ取り直す", async () => {
    await upstreamSet({ url: "https://busy.example.org/a", status: 429, headers: { "retry-after": "2" }, body: "slow down" });
    await upstreamSet({ url: "https://busy.example.org/b", contentType: "text/html", body: "<p>別のページの本文です。十分な長さの文にしておく。</p>" });
    const gw = new Gateway(testEnv);
    const t0 = Date.now();
    const r = await gw.fetchDoc("https://busy.example.org/a");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cutoff.why).toBe("blocked");
      expect(r.cutoff.detail).toContain("429");
    }
    const b = await gw.fetchDoc("https://busy.example.org/b");
    expect(b.ok).toBe(true);
    const log = (await upstreamLog()).filter((l) => l.url.startsWith("https://busy.example.org/") && !l.url.endsWith("robots.txt"));
    const a = log.filter((l) => l.url.endsWith("/a"));
    expect(a).toHaveLength(2);
    // 2秒（方針の時間）の冷却が、取り直しと別のページの両方に効いている
    const scale = Number(testEnv.TEST_TIME_SCALE);
    expect(a[1]!.at - a[0]!.at).toBeGreaterThanOrEqual(2_000 * scale - 5);
    const bReq = log.find((l) => l.url.endsWith("/b"))!;
    expect(bReq.at - a[0]!.at).toBeGreaterThanOrEqual(2_000 * scale - 5);
    void t0;
  });

  it("冷却が取得1件の締め切りより長ければ、取り直さずに blocked（再開を求められたことを書く）", async () => {
    await upstreamSet({ url: "https://busy2.example.org/a", status: 429, headers: { "retry-after": "120" }, body: "" });
    const r = await new Gateway(testEnv).fetchDoc("https://busy2.example.org/a");
    expect(!r.ok && r.cutoff.detail).toContain("120");
    expect((await upstreamLog()).filter((l) => l.url === "https://busy2.example.org/a")).toHaveLength(1);
  });

  it("1回の code で start は5つまで。6つ目は busy と次の手（例外にしない）", async () => {
    const [research] = providers(testEnv);
    const fns = research!.fns as Record<string, (...a: unknown[]) => Promise<any>>;
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => fns.start!({ question: `問い ${i}`, mode: "lookup", urls: ["https://docs.example.com/cache"] })));
    expect(rs.filter((r) => r.error).length).toBe(1);
    expect(rs.find((r) => r.error)!.error).toMatchObject({ code: "busy", retryable: true });
    expect(rs.find((r) => r.error)!.error.next).toContain("次の code");
  });
});
