import type { ResolvedProvider, Executor } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Bundle, ClaimInput, HubError, Notice, QuestionInput } from "@ai-research/sandbox-api";
import { CODE_TOOL_DESCRIPTION, POLICY, tierOf } from "@ai-research/policy";
import type { Env } from "./env.ts";
import { ledgerStub } from "./ledger.ts";
import { runStub } from "./run.ts";
import { routeStub } from "./route.ts";
import { AroundOpts, FindInput, FindOpts, ClaimsInput, NextOpts, PassageIdInput, RunIdInput, StartInput, SteerInput, clampMax, hubError, parse, runNotFound } from "./boundary.ts";
import { INPUT_BOUNDS } from "@ai-research/policy";
import { emit } from "./obs.ts";

/**
 * code mode の実行環境に渡す関数（docs/03 §2.3）。
 * 実行環境からは外へ通信できない（globalOutbound: null、INV-12）。外への取得はハブの関数だけが行う。
 * 境界（boundary.ts）で、入る値を型に直し、出る失敗を HubError に直す（P-05）。
 */
type Fn = (...args: unknown[]) => Promise<unknown>;

/** 例外を値（HubError）に直す。runId を知っている呼び出しは、それを添える */
function guarded(fn: (...args: unknown[]) => Promise<unknown>, runIdOf?: (args: unknown[]) => string | undefined): Fn {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      const runId = runIdOf?.(args);
      emit({ event: "hub_error", message: String((e as Error)?.message ?? e).slice(0, 300), ...(typeof runId === "string" ? { runId } : {}) });
      return hubError(e, typeof runId === "string" && /^run_/.test(runId) ? runId : undefined);
    }
  };
}

function tooManyStarts(): HubError {
  const n = POLICY.fanout.maxStartsPerCode;
  return {
    error: {
      code: "busy",
      retryable: true,
      message: `1回の code で始められる調査（start）は ${n} つまで（取得先への負荷を抑えるため）`,
      next: `残りの start は次の code で呼ぶ。先に ${n} つ start して、結果は next でまとめて受け取れる。`,
    },
  };
}

const firstArg = (args: unknown[]) => (typeof args[0] === "string" ? args[0] : undefined);
const notFound = (b: { notices?: { kind: string }[] }, runId: string) =>
  b.notices?.some((n) => n.kind === "run_not_found") ? runNotFound(runId) : b;
/** 丸めた知らせを結果の先頭に足す */
const withNotices = <T extends { notices: Notice[] }>(r: T, notices: Notice[]): T => {
  if (notices.length) r.notices = [...notices, ...r.notices];
  return r;
};

export function providers(env: Env, client?: string): ResolvedProvider[] {
  // 1回の code で始められる調査の数（設計 v1.5 §8.3.5）。providers は code の呼び出しごとに作られる
  let starts = 0;
  const research: Record<string, Fn> = {
    start: guarded(async (q: unknown) => {
      const input = parse(StartInput, q, "start") as QuestionInput;
      if (++starts > POLICY.fanout.maxStartsPerCode) return tooManyStarts();
      // 種類の上限を超えた値は丸めて知らせる（issue 002）。正は POLICY.modes
      const notices: Notice[] = [];
      const mode = POLICY.modes[input.mode];
      const w = clampMax(notices, "waitMs", mode.startMs, input.waitMs);
      if (w !== undefined) input.waitMs = w;
      const p = clampMax(notices, "maxPassages", mode.passagesPerBundle, input.maxPassages);
      if (p !== undefined) input.maxPassages = p;
      const runId = `run_${crypto.randomUUID()}`;
      await routeStub(env).noteResearchStart().catch(() => {});
      return withNotices((await runStub(env, runId).start(runId, input, client)) as Bundle, notices);
    }),
    next: guarded(async (runId: unknown, opts?: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const o = parse(NextOpts, opts, "opts");
      const notices: Notice[] = [];
      const wait = clampMax(notices, "waitMs", INPUT_BOUNDS.waitMsMax, o?.waitMs) ?? 0;
      return notFound(withNotices((await runStub(env, id).next(wait)) as Bundle, notices), id);
    }, firstArg),
    around: guarded(async (runId: unknown, passageId: unknown, opts?: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const pid = parse(PassageIdInput, passageId, "passageId");
      const o = parse(AroundOpts, opts, "opts");
      const notices: Notice[] = [];
      const before = clampMax(notices, "before", INPUT_BOUNDS.aroundMax, o?.before) ?? 1;
      const after = clampMax(notices, "after", INPUT_BOUNDS.aroundMax, o?.after) ?? 1;
      const r = await runStub(env, id).around(pid, before, after);
      return notFound(withNotices(r, notices), id);
    }, firstArg),
    find: guarded(async (runId: unknown, source: unknown, text: unknown, opts?: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const f = parse(FindInput, { source, text }, "find");
      const o = parse(FindOpts, opts, "opts");
      const notices: Notice[] = [];
      const limit = clampMax(notices, "limit", INPUT_BOUNDS.findLimitMax, o?.limit) ?? INPUT_BOUNDS.findLimitMax;
      return notFound(withNotices(await runStub(env, id).find(f.source, f.text, limit), notices), id);
    }, firstArg),
    verify: guarded(async (runId: unknown, claims: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const c = parse(ClaimsInput, claims ?? [], "claims") as ClaimInput[];
      return notFound(await runStub(env, id).verify(c), id);
    }, firstArg),
    steer: guarded(async (runId: unknown, q: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const input = parse(SteerInput, q, "steer");
      const notices: Notice[] = [];
      const waitMs = clampMax(notices, "waitMs", INPUT_BOUNDS.waitMsMax, input.waitMs);
      const q2: { question: string; queries: string[]; urls?: string[]; sources?: ("web" | "scholarly")[]; waitMs?: number } = { question: input.question, queries: input.queries ?? [] };
      if (input.urls) q2.urls = input.urls;
      if (input.sources) q2.sources = input.sources;
      if (waitMs !== undefined) q2.waitMs = waitMs;
      return notFound(withNotices((await runStub(env, id).steer(q2)) as Bundle, notices), id);
    }, firstArg),
    deepen: guarded(async (runId: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      return notFound((await runStub(env, id).deepen()) as Bundle, id);
    }, firstArg),
    close: guarded(async (runId: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      return (await runStub(env, id).close()) ? { closed: true } : runNotFound(id);
    }, firstArg),
  };
  // 今の手順と型（会話の途中でハブが変わったとき。設計 v1.6 §8.4.2）
  research.help = guarded(async () => ({ procedure: POLICY.revision, description: CODE_TOOL_DESCRIPTION }));
  const ledger: Record<string, Fn> = {
    search: guarded(async (text: unknown) => {
      const stub = ledgerStub(env);
      const seq = await stub.currentSeq();
      const rows = await stub.search(String(text ?? ""), { snapshotSeq: seq, limit: 20 });
      return rows.map((r) => ({
        recordId: r.recordId,
        excerpt: r.excerpt,
        source: { kind: r.kind, url: r.url, locator: r.locator, tier: tierOf(r), ...(r.title ? { title: r.title } : {}) },
        verifiedAt: r.verifiedAt,
      }));
    }),
  };
  return [
    { name: "research", fns: research },
    { name: "ledger", fns: ledger },
  ];
}

export function makeExecutor(env: Env): Executor {
  return new DynamicWorkerExecutor({ loader: env.LOADER, timeout: 60_000, globalOutbound: null });
}
