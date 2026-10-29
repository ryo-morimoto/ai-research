import { describe, it, expect } from "vitest";
import { z } from "zod";
import { CUTOFF_REASONS, CLAIM_REASONS } from "@ai-research/sandbox-api";
import { EMPTY_NEXT, INPUT_BOUNDS, OFF_PATH_REASONS, POLICY, VERIFY_NEXT } from "@ai-research/policy";

/**
 * POLICY 自身のスキーマ検査（ADR-0001：層5は構造だけでなく、値の間の不変条件も機械で確かめる）。
 * 値を変えるのは自由。ここが落ちるのは、値どうしの関係が壊れたとき
 */

const hostPolicy = z.object({
  pattern: z.string().min(1),
  minIntervalMs: z.number().int().positive(),
  maxConcurrent: z.number().int().positive(),
  timeoutMs: z.number().int().positive().optional(),
});

const PolicySchema = z
  .object({
    name: z.string().min(1),
    revision: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/),
    deadlines: z.object({
      fetchMs: z.number().positive(),
      leaseWaitMs: z.number().positive(),
      continueUntilMs: z.number().positive(),
      nextMaxWaitMs: z.number().positive(),
      revalidateMs: z.number().positive(),
    }),
    backoff: z.object({ defaultMs: z.number(), minMs: z.number(), maxMs: z.number(), statuses: z.array(z.number().int()) }),
    relevance: z.object({ minCoverage: z.number().gt(0).lt(1) }),
    modes: z.record(
      z.string(),
      z.object({
        ledgerShow: z.number().int().positive(),
        passagesPerBundle: z.number().int().positive(),
        passagesPerSource: z.number().int().positive(),
        startMs: z.number().positive(),
        continues: z.boolean(),
        searchWithUrls: z.boolean(),
      }),
    ),
    hosts: z.array(hostPolicy).min(1),
    defaultHost: hostPolicy,
    tierWeight: z.object({ paper: z.number(), official: z.number(), encyclopedia: z.number(), other: z.number() }),
  })
  .loose();

describe("POLICY のスキーマと値の整合（ADR-0001）", () => {
  it("構造がスキーマに合う", () => {
    expect(() => PolicySchema.parse(POLICY)).not.toThrow();
  });

  it("値の間の不変条件：backoff の順序、締め切りの順序、種類の上限", () => {
    expect(POLICY.backoff.minMs).toBeLessThanOrEqual(POLICY.backoff.defaultMs);
    expect(POLICY.backoff.defaultMs).toBeLessThanOrEqual(POLICY.backoff.maxMs);
    // 続きを待つ上限は、順番待ちの上限と続きの締め切りに収まる
    expect(POLICY.deadlines.nextMaxWaitMs).toBeLessThanOrEqual(POLICY.deadlines.leaseWaitMs);
    expect(POLICY.deadlines.nextMaxWaitMs).toBeLessThan(POLICY.deadlines.continueUntilMs);
    // 最初の束の締め切りは続きの上限より短い
    for (const m of Object.values(POLICY.modes)) {
      expect(m.startMs).toBeLessThan(POLICY.deadlines.continueUntilMs);
      expect(m.passagesPerBundle).toBeLessThanOrEqual(POLICY.limits.passagesPerBundle);
      expect(m.passagesPerSource).toBeLessThanOrEqual(m.passagesPerBundle);
    }
    // 一次資料を前に（tierWeight の順序）
    expect(POLICY.tierWeight.paper).toBeGreaterThan(POLICY.tierWeight.official);
    expect(POLICY.tierWeight.official).toBeGreaterThan(POLICY.tierWeight.encyclopedia);
    expect(POLICY.tierWeight.encyclopedia).toBeGreaterThan(POLICY.tierWeight.other);
  });

  it("一覧の整合：cutoffAllowReasons ⊆ CUTOFF_REASONS、VERIFY_NEXT は CLAIM_REASONS を網羅", () => {
    for (const r of POLICY.routing.cutoffAllowReasons) expect(CUTOFF_REASONS).toContain(r);
    expect(Object.keys(VERIFY_NEXT).sort()).toEqual([...CLAIM_REASONS].sort());
    // policy・robots は経路外に回さない（E-02）
    expect(POLICY.routing.cutoffAllowReasons).not.toContain("policy");
    expect(POLICY.routing.cutoffAllowReasons).not.toContain("robots");
  });

  it("INPUT_BOUNDS は POLICY から導出されている（境界の上限が方針より狭くならない。issue 002）", () => {
    expect(INPUT_BOUNDS.waitMsMax).toBe(POLICY.deadlines.nextMaxWaitMs);
    expect(INPUT_BOUNDS.maxPassagesMax).toBe(Math.max(POLICY.modes.lookup.passagesPerBundle, POLICY.modes.survey.passagesPerBundle));
    expect(INPUT_BOUNDS.aroundMax).toBe(POLICY.around.maxEach);
    expect(INPUT_BOUNDS.findLimitMax).toBe(POLICY.find.maxResults);
  });

  it("Q-01：経路外のラベルが一覧（OFF_PATH_REASONS）から導かれている", () => {
    const texts = [EMPTY_NEXT.search_failed, EMPTY_NEXT.all_failed];
    for (const t of texts) {
      const m = t.match(/経路外（([^）]+)）/);
      expect(m, t).not.toBeNull();
      expect(OFF_PATH_REASONS).toContain(m![1]);
    }
  });
});
