import type { ResolvedProvider, Executor } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { QuestionInput, ClaimInput } from "@ai-research/sandbox-api";
import type { Env } from "./env.ts";
import { ledgerStub } from "./ledger.ts";
import { runStub } from "./run.ts";

/**
 * code mode の実行環境に渡す関数（docs/03 §2.3）。
 * 実行環境からは外へ通信できない（globalOutbound: null、INV-12）。外への取得はハブの関数だけが行う。
 */
export function providers(env: Env, client?: string): ResolvedProvider[] {
  const research: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    start: async (q: unknown) => {
      const runId = `run_${crypto.randomUUID()}`;
      return runStub(env, runId).start(runId, q as QuestionInput, client);
    },
    next: async (runId: unknown, opts?: unknown) =>
      runStub(env, String(runId)).next(Number((opts as { waitMs?: number } | undefined)?.waitMs ?? 0)),
    verify: async (runId: unknown, claims: unknown) => runStub(env, String(runId)).verify((claims as ClaimInput[]) ?? []),
    steer: async (runId: unknown, q: unknown) =>
      runStub(env, String(runId)).steer(q as { question: string; queries: string[]; urls?: string[] }),
    deepen: async (runId: unknown) => runStub(env, String(runId)).deepen(),
  };
  const ledger: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    search: async (text: unknown) => {
      const stub = ledgerStub(env);
      const seq = await stub.currentSeq();
      const rows = await stub.search(String(text ?? ""), { snapshotSeq: seq, limit: 20 });
      return rows.map((r) => ({
        recordId: r.recordId,
        excerpt: r.excerpt,
        source: { kind: r.kind, url: r.url, locator: r.locator, ...(r.title ? { title: r.title } : {}) },
        verifiedAt: r.verifiedAt,
      }));
    },
  };
  return [
    { name: "research", fns: research },
    { name: "ledger", fns: ledger },
  ];
}

export function makeExecutor(env: Env): Executor {
  return new DynamicWorkerExecutor({ loader: env.LOADER, timeout: 60_000, globalOutbound: null });
}
