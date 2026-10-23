import { env } from "cloudflare:test";
import { verifyQuote, type Source, type Fingerprint, type VerifiedExcerpt } from "@ai-research/core";
import { ledgerStub } from "../src/ledger.ts";
import { runStub, type RunDO, type RunInspection } from "../src/run.ts";

export const ledger = () => ledgerStub(env);
export const run = (id: string) => runStub(env, id);

/** 偽の取得先の応答を上書きする */
export async function upstreamSet(spec: Record<string, unknown>): Promise<void> {
  await env.TEST_UPSTREAM!.fetch("https://control.test/set", { method: "POST", body: JSON.stringify(spec) });
}
export async function upstreamReset(): Promise<void> {
  await env.TEST_UPSTREAM!.fetch("https://control.test/reset", { method: "POST" });
}
export async function upstreamLog(): Promise<{ url: string; at: number; headers: Record<string, string> }[]> {
  return (await env.TEST_UPSTREAM!.fetch("https://control.test/log")).json();
}

/** 照合器を通して VerifiedExcerpt を作る（試験でも型を偽らない） */
export function excerptFrom(sourceText: string, quote: string, source: Partial<Source> = {}, fingerprint: Fingerprint = {}): VerifiedExcerpt {
  const r = verifyQuote({
    quote,
    sourceText,
    source: { kind: "web", url: "https://docs.example.com/x", locator: "https://docs.example.com/x", ...source },
    fingerprint,
    verifiedAt: new Date().toISOString(),
  });
  if (!r.ok) throw new Error(`照合できない: ${r.reason}`);
  return r.excerpt;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function inspect(stub: DurableObjectStub<RunDO>): Promise<RunInspection> {
  return JSON.parse(await stub.inspect()) as RunInspection;
}
