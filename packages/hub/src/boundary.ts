import { z } from "zod";
import { INPUT_BOUNDS as B, offPath } from "@ai-research/policy";
import type { ClaimInput, HubError, HubErrorCode, Notice, QuestionInput } from "@ai-research/sandbox-api";
import { emit } from "./obs.ts";

/**
 * 実行環境（会話の Claude が書いたコード）とハブの境界（設計 v1.3 D12、制約 P-05）。
 * - 入ってくる値はここで型に直す。内部では確かめ直さない（pstack: Boundary Discipline）
 * - 出ていく失敗はここで種別に直す。内部の事情の文だけを返さない
 * - 上限の数はここに書かない。正は policy の INPUT_BOUNDS（issue 002：境界が POLICY より狭くて往復していた）
 * - 直し方が自明な数値の超過は、拒まず丸めて clamped で知らせる（設計 v1.5 §8.3.7）。拒むのは型・形の誤りだけ
 */

const str = z.string().trim().min(1);
/** 件数の上限も丸める（clampList）。ここでは拒まない */
const strList = z.array(z.string()).optional();
/** 上限は丸める（clampMax）。ここでは拒まない */
const waitMs = z.number().min(0).optional();

const sourceSet = z.array(z.enum(["web", "scholarly"])).min(1).max(2).optional();

export const StartInput = z.object({
  question: str,
  mode: z.enum(["lookup", "survey"]),
  sources: sourceSet,
  waitMs,
  maxPassages: z.number().int().min(1).optional(),
  scope: z.string().optional(),
  exclusions: z.array(z.string()).optional(),
  queries: strList,
  urls: z.array(z.string().url()).optional(),
});
export const SteerInput = z.object({
  question: str,
  queries: strList,
  urls: z.array(z.string().url()).optional(),
  sources: sourceSet,
  waitMs,
});
/** 主張の数の上限（claimsMax）も丸める。超えた分は照合せず budget の未照合で返す（sandbox.ts） */
export const ClaimsInput = z.array(
  z.object({ text: z.string(), cite: z.array(z.object({ passageId: z.string(), quote: z.string() })).max(B.listMax) }),
);
export const RunIdInput = z.string().regex(/^run_[A-Za-z0-9-]{8,80}$/);
export const NextOpts = z.object({ waitMs }).optional();
export const PassageIdInput = z.string().regex(/^[ph]\d{1,9}$/);
export const FindInput = z.object({ source: z.string().min(1).max(B.sourceMaxChars), text: z.string().trim().min(1).max(B.findTextMaxChars) });
export const FindOpts = z.object({ limit: z.number().int().min(1).optional() }).optional();
export const AroundOpts = z.object({ before: z.number().int().min(0).optional(), after: z.number().int().min(0).optional() }).optional();

/** 上限を超えた数値は丸め、clamped で知らせる（bad_input で往復させない。設計 v1.5 §8.3.7、issue 002） */
export function clampMax(notices: Notice[], field: string, max: number, v: number | undefined): number | undefined {
  if (v === undefined || v <= max) return v;
  notices.push({ kind: "clamped", field, max });
  return max;
}

/** 件数の上限を超えたリストは先頭だけ使い、clamped で知らせる */
export function clampList<T>(notices: Notice[], field: string, max: number, v: T[] | undefined): T[] | undefined {
  if (!v || v.length <= max) return v;
  notices.push({ kind: "clamped", field, max });
  return v.slice(0, max);
}

export class BadInput extends Error {}

/** 本文になり得るキー。実引数ログには値を入れず長さだけ残す（C-04、E-01） */
const SENSITIVE_KEYS = new Set(["question", "text", "quote", "scope", "excerpt"]);

/** bad_input の切り分け用に、渡された値の形だけを文字列にする（issue 002：型違いの実態が分からなかった） */
export function describeArgs(value: unknown): string {
  try {
    const s = JSON.stringify(value, (key, v) => {
      if (typeof v === "string" && (SENSITIVE_KEYS.has(key) || v.length > 40)) return `<string ${v.length}字>`;
      if (typeof v === "function") return "<function>";
      return v;
    });
    return (s ?? String(typeof value)).slice(0, 120);
  } catch {
    return String(typeof value);
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 3).map((i) => `${[what, ...i.path].join(".")}: ${i.message}`);
    emit({ event: "bad_input", what, issues: issues.join("; ").slice(0, 300), args: describeArgs(value) });
    throw new BadInput(issues.join("; "));
  }
  return r.data;
}

const NEXT: Record<HubErrorCode, string> = {
  busy: `数秒おいて同じ呼び出しをもう一度してください。続けて失敗したら、組み込みの道具で調べ、答えの最後に「${offPath("ai-research に届かなかった")}」と書いてください。`,
  run_not_found: "research.start からやり直してください。",
  bad_input: "message のとおりに値を直して、もう一度呼んでください。",
  internal: `組み込みの道具で調べ、答えの最後に「${offPath("ai-research の内部の失敗")}」と書いてください。`,
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
