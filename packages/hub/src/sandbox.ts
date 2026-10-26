import type { ResolvedProvider, Executor } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Bundle, ClaimInput, QuestionInput } from "@ai-research/sandbox-api";
import { POLICY, tierOf } from "@ai-research/policy";
import type { Env } from "./env.ts";
import { ledgerStub } from "./ledger.ts";
import { runStub } from "./run.ts";
import { routeStub } from "./route.ts";
import { AroundOpts, FindInput, FindOpts, ClaimsInput, NextOpts, PassageIdInput, RunIdInput, StartInput, SteerInput, hubError, parse, runNotFound } from "./boundary.ts";

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
      console.log(JSON.stringify({ event: "hub_error", message: String((e as Error)?.message ?? e).slice(0, 300), runId }));
      return hubError(e, typeof runId === "string" && /^run_/.test(runId) ? runId : undefined);
    }
  };
}

const firstArg = (args: unknown[]) => (typeof args[0] === "string" ? args[0] : undefined);
const notFound = (b: { notices?: { kind: string }[] }, runId: string) =>
  b.notices?.some((n) => n.kind === "run_not_found") ? runNotFound(runId) : b;

export function providers(env: Env, client?: string): ResolvedProvider[] {
  const research: Record<string, Fn> = {
    start: guarded(async (q: unknown) => {
      const input = parse(StartInput, q, "start") as QuestionInput;
      const runId = `run_${crypto.randomUUID()}`;
      await routeStub(env).noteResearchStart().catch(() => {});
      return runStub(env, runId).start(runId, input, client);
    }),
    next: guarded(async (runId: unknown, opts?: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const o = parse(NextOpts, opts, "opts");
      return notFound((await runStub(env, id).next(Number(o?.waitMs ?? 0))) as Bundle, id);
    }, firstArg),
    around: guarded(async (runId: unknown, passageId: unknown, opts?: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const pid = parse(PassageIdInput, passageId, "passageId");
      const o = parse(AroundOpts, opts, "opts");
      return notFound(await runStub(env, id).around(pid, o?.before ?? 1, o?.after ?? 1), id);
    }, firstArg),
    find: guarded(async (runId: unknown, source: unknown, text: unknown, opts?: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const f = parse(FindInput, { source, text }, "find");
      const o = parse(FindOpts, opts, "opts");
      return notFound(await runStub(env, id).find(f.source, f.text, o?.limit ?? POLICY.find.maxResults), id);
    }, firstArg),
    verify: guarded(async (runId: unknown, claims: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const c = parse(ClaimsInput, claims ?? [], "claims") as ClaimInput[];
      return notFound(await runStub(env, id).verify(c), id);
    }, firstArg),
    steer: guarded(async (runId: unknown, q: unknown) => {
      const id = parse(RunIdInput, runId, "runId");
      const input = parse(SteerInput, q, "steer");
      const q2: { question: string; queries: string[]; urls?: string[]; sources?: ("web" | "scholarly")[] } = { question: input.question, queries: input.queries ?? [] };
      if (input.urls) q2.urls = input.urls;
      if (input.sources) q2.sources = input.sources;
      if (input.waitMs !== undefined) (q2 as { waitMs?: number }).waitMs = input.waitMs;
      return notFound((await runStub(env, id).steer(q2)) as Bundle, id);
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
