import { z } from "zod";
import type { ClaimInput, HubError, HubErrorCode, QuestionInput } from "@ai-research/sandbox-api";

/**
 * 実行環境（会話の Claude が書いたコード）とハブの境界（設計 v1.3 D12、制約 P-05）。
 * - 入ってくる値はここで型に直す。内部では確かめ直さない（pstack: Boundary Discipline）
 * - 出ていく失敗はここで種別に直す。内部の事情の文だけを返さない
 */

const str = z.string().trim().min(1);
const strList = z.array(z.string()).max(8).optional();

export const StartInput = z.object({
  question: str,
  mode: z.enum(["lookup", "survey"]),
  scope: z.string().optional(),
  exclusions: z.array(z.string()).max(16).optional(),
  queries: strList,
  urls: z.array(z.string().url()).max(8).optional(),
});
export const SteerInput = z.object({ question: str, queries: strList, urls: z.array(z.string().url()).max(8).optional() });
export const ClaimsInput = z
  .array(z.object({ text: z.string(), cite: z.array(z.object({ passageId: z.string(), quote: z.string() })).max(8) }))
  .max(50);
export const RunIdInput = z.string().regex(/^run_[A-Za-z0-9-]{8,80}$/);
export const NextOpts = z.object({ waitMs: z.number().min(0).max(60_000).optional() }).optional();
export const PassageIdInput = z.string().regex(/^[ph]\d{1,9}$/);
export const AroundOpts = z.object({ before: z.number().int().min(0).max(3).optional(), after: z.number().int().min(0).max(3).optional() }).optional();

export class BadInput extends Error {}

export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 3).map((i) => `${[what, ...i.path].join(".")}: ${i.message}`);
    throw new BadInput(issues.join("; "));
  }
  return r.data;
}

const NEXT: Record<HubErrorCode, string> = {
  busy: "数秒おいて同じ呼び出しをもう一度してください。続けて失敗したら、組み込みの道具で調べ、答えの最後に「経路外（ai-research に届かなかった）」と書いてください。",
  run_not_found: "research.start からやり直してください。",
  bad_input: "message のとおりに値を直して、もう一度呼んでください。",
  internal: "組み込みの道具で調べ、答えの最後に「経路外（ai-research の内部の失敗）」と書いてください。",
};

/** Durable Object とランタイムの失敗の文から、種別を決める */
export function classify(e: unknown): HubErrorCode {
  if (e instanceof BadInput) return "bad_input";
  const o = e as { overloaded?: boolean; retryable?: boolean; message?: string } | undefined;
  const msg = String(o?.message ?? e);
  if (o?.overloaded || o?.retryable) return "busy";
  if (/overloaded|exceeded timeout|object to be reset|Network connection lost|reset because|Durable Object .*reset|internal error; reference/i.test(msg))
    return "busy";
  return "internal";
}

export function hubError(e: unknown, runId?: string): HubError {
  const code = classify(e);
  const message = String((e as { message?: string })?.message ?? e).slice(0, 300);
  const err: HubError["error"] = { code, retryable: code === "busy" || code === "bad_input", message, next: NEXT[code] };
  if (runId) err.runId = runId;
  return { error: err };
}

export function runNotFound(runId: string): HubError {
  return { error: { code: "run_not_found", retryable: false, message: `調査 ${runId} は見つからない`, next: NEXT.run_not_found, runId } };
}

export type { QuestionInput, ClaimInput };
