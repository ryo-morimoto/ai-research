/**
 * 1回の調査の概念とずれの印（docs/05 §3.5、V-03）
 *   D1 同じ事象の列からは同じ結果（並べ替えても ev の順で決まる）
 *   D2 reachedBy・unreached・off は互いに食い違わない
 *   D3 概念の表示名は検索語そのもの（作文しない）
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { driftOf, type TraceEvent } from "../src/index.ts";

const runs = Number(process.env.FC_RUNS ?? 200);
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const params = { numRuns: runs, ...(seed !== undefined ? { seed } : {}) };

const base = { runId: "r", at: 0 };
let ev = 0;
const E = (e: Record<string, unknown>) => ({ ...base, ev: ++ev, ...e }) as TraceEvent;

describe("ずれの印（例）", () => {
  it("検索語ごとに概念を作り、当たった出典と、どこにも当たらない概念・問いと関係のない出典に印を付ける", () => {
    ev = 0;
    const events = [
      E({ type: "run.started", v: 1, question: "Cloudflare Access で Workers を本人だけに限定する方法", mode: "survey", queries: ["Cloudflare Access protect Workers route", "Zero Trust free plan users", "Access one-time PIN login"] }),
      E({ type: "source.fetched", v: 1, sourceId: "s1", url: "https://developers.cloudflare.com/workers/configuration/cloudflare-access/", host: "developers.cloudflare.com", title: "Cloudflare Access · Workers docs" }),
      E({ type: "passage.selected", v: 1, passageId: "p1", sourceId: "s1", context: "Protect a Workers route" }),
      E({ type: "source.fetched", v: 1, sourceId: "s2", url: "https://www.example.com/recipes/curry", host: "www.example.com", title: "Best curry recipes" }),
    ];
    const [d] = driftOf(events);
    expect(d!.concepts.map((c) => c.label)).toEqual(["Cloudflare Access protect Workers route", "Zero Trust free plan users", "Access one-time PIN login"]);
    expect(d!.concepts[0]!.reachedBy).toEqual(["s1"]);
    expect(d!.unreached).toEqual(["Zero Trust free plan users", "Access one-time PIN login"]);
    expect(d!.off).toEqual(["s2"]);
  });

  it("語の集合がよく似た検索語は1つの概念にまとめる。検索語がなければ問いを概念にする", () => {
    ev = 0;
    const [a] = driftOf([E({ type: "run.started", v: 1, question: "q", mode: "survey", queries: ["MCP Apps visibility", "MCP Apps visibility app"] })]);
    expect(a!.concepts).toHaveLength(1);
    expect(a!.concepts[0]!.queries).toEqual(["MCP Apps visibility", "MCP Apps visibility app"]);
    ev = 0;
    const [b] = driftOf([E({ type: "run.started", v: 1, question: "取得先の制限は", mode: "lookup", queries: [] })]);
    expect(b!.concepts.map((c) => c.label)).toEqual(["取得先の制限は"]);
  });

  it("日本語の問いと英語の検索語でも、英語の題の出典は外れにならない（検索語の語で当てる）", () => {
    ev = 0;
    const [d] = driftOf([
      E({ type: "run.started", v: 1, question: "取得先ごとの頻度制限", mode: "survey", queries: ["arxiv rate limit"] }),
      E({ type: "source.fetched", v: 1, sourceId: "s1", url: "https://info.arxiv.org/help/api/tou.html", title: "arXiv API Terms of Use rate limits" }),
    ]);
    expect(d!.off).toEqual([]);
    expect(d!.unreached).toEqual([]);
  });

  it("steer の後は新しい版で付け直す。使い回した出典もその版の出典として数える", () => {
    ev = 0;
    const out = driftOf([
      E({ type: "run.started", v: 1, question: "q1", mode: "survey", queries: ["alpha beta"] }),
      E({ type: "source.fetched", v: 1, sourceId: "s1", url: "https://x.test/alpha-beta", title: "alpha beta" }),
      E({ type: "run.steered", v: 2, question: "q2", queries: ["gamma delta"] }),
      E({ type: "source.fetched", v: 2, sourceId: "s2", url: "https://x.test/alpha-beta", title: "alpha beta", reused: true }),
    ]);
    expect(out.map((d) => d.v)).toEqual([1, 2]);
    expect(out[0]!.off).toEqual([]);
    expect(out[1]!.off).toEqual(["s2"]);
    expect(out[1]!.unreached).toEqual(["gamma delta"]);
  });
});

const word = fc.constantFrom("alpha", "beta", "gamma", "delta", "access", "workers", "制限", "取得先", "調査", "出典", "limit", "route");
const phrase = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(" "));
const eventsArb = fc
  .record({
    question: phrase,
    queries: fc.array(phrase, { maxLength: 5 }),
    sources: fc.array(fc.record({ title: phrase, ctx: fc.option(phrase, { nil: undefined }) }), { maxLength: 6 }),
  })
  .map(({ question, queries, sources }) => {
    const out: TraceEvent[] = [{ type: "run.started", runId: "r", at: 0, ev: 1, v: 1, question, mode: "survey", queries } as TraceEvent];
    sources.forEach((s, i) => {
      out.push({ type: "source.fetched", runId: "r", at: 0, ev: out.length + 1, v: 1, sourceId: `s${i}`, url: `https://x.test/${i}`, title: s.title } as TraceEvent);
      if (s.ctx) out.push({ type: "passage.selected", runId: "r", at: 0, ev: out.length + 1, v: 1, passageId: `p${i}`, sourceId: `s${i}`, context: s.ctx } as TraceEvent);
    });
    return out;
  });

describe("ずれの印（性質）", () => {
  it("D1：並べ替えても同じ結果", () => {
    fc.assert(
      fc.property(eventsArb, fc.integer(), (events, k) => {
        const shuffled = [...events].sort((a, b) => ((a.ev * 7919 + k) % 101) - ((b.ev * 7919 + k) % 101));
        expect(driftOf(shuffled)).toEqual(driftOf(events));
      }),
      params,
    );
  });

  it("D2：印は互いに食い違わない", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        for (const d of driftOf(events)) {
          const ids = new Set(d.sources.map((s) => s.sourceId));
          for (const c of d.concepts) for (const s of c.reachedBy) expect(ids.has(s)).toBe(true);
          expect(d.unreached).toEqual(d.concepts.filter((c) => c.reachedBy.length === 0).map((c) => c.label));
          for (const s of d.sources) {
            expect(s.matched).toEqual(d.concepts.filter((c) => c.reachedBy.includes(s.sourceId)).map((c) => c.label));
            // 外れの出典は、どの概念にも当たらない
            if (s.off) expect(s.matched).toEqual([]);
          }
          expect(d.off).toEqual(d.sources.filter((s) => s.off).map((s) => s.sourceId));
        }
      }),
      params,
    );
  });

  it("D3：概念の表示名は検索語（なければ問い）そのもの", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const started = events[0] as Extract<TraceEvent, { type: "run.started" }>;
        const seeds = (started.queries ?? []).length ? started.queries! : [started.question];
        for (const d of driftOf(events)) for (const c of d.concepts) expect(seeds).toContain(c.label);
      }),
      params,
    );
  });
});
