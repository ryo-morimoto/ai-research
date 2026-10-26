/**
 * 調査の記録（事象）の型と、保存の前に通す整形（docs/05 §3）。純粋な関数。
 *
 * - 段落の本文の欄を持たない（C-04）。台帳が主張・要約の欄を持たないことで Q-03 を守るのと同じやり方
 * - 種類ごとに許した欄だけを残し、文字列は上限で切る。許していない欄（text など）は捨てる
 * - 数は 0 以上の整数に丸める。種類が分からない事象は捨てる
 */

export const TRACE_LIMITS = {
  /** 解釈した問い */
  questionMaxChars: 500,
  /** 検索語・題・見出し・理由の説明など、短い文字列 */
  shortMaxChars: 200,
  /** URL */
  urlMaxChars: 2048,
  /** 1つの事象に入れる配列の長さ（検索語・URL・主張・段落 ID） */
  listMax: 50,
} as const;

export type TraceLimits = { -readonly [K in keyof typeof TRACE_LIMITS]: number };

export type TraceOrigin = "url" | "ledger" | "search" | "system";

type Base = { runId: string; at: number; ev: number; v: number };

export type TraceClaim = { status: string; reason?: string; passageIds: string[]; recorded: string[] };

/** 必須の欄（REQUIRED）のほかは、整形で落ちることがあるので任意にする */
export type TraceEvent =
  | (Base & {
      type: "run.started";
      question: string;
      mode: string;
      sources?: string[];
      queries?: string[];
      urls?: string[];
      procedure?: string;
      procedureVersion?: string;
      client?: string;
    })
  | (Base & { type: "run.steered"; question: string; queries?: string[]; urls?: string[] })
  | (Base & { type: "run.deepened" })
  | (Base & { type: "run.done"; why: string; searched?: number; found?: number; fetched?: number; failed?: number; elapsedMs?: number })
  | (Base & { type: "search.sent"; query: string; provider: string; ok?: boolean; hits?: number })
  | (Base & {
      type: "source.fetched";
      sourceId: string;
      url: string;
      host?: string;
      kind?: string;
      tier?: string;
      title?: string;
      origin?: string;
      ms?: number;
      reused?: boolean;
    })
  | (Base & { type: "passage.selected"; passageId: string; sourceId: string; context?: string; chars?: number; via?: string })
  | (Base & { type: "ledger.hit"; recordId: string; status: string; url?: string; reason?: string })
  | (Base & { type: "verify.done"; claims?: TraceClaim[] })
  | (Base & { type: "cutoff"; what: string; why: string; host?: string; kind?: string; tier?: string; origin?: string; detail?: string });

export type TraceEventType = TraceEvent["type"];

/** 欄の種類。q は問い、s は短い文字列、u は URL、n は数、b は真偽、ss は文字列の並び、us は URL の並び、c は主張の並び */
type FieldKind = "q" | "s" | "u" | "n" | "b" | "ss" | "us" | "c";

const COMMON: Record<string, FieldKind> = { runId: "s", at: "n", ev: "n", v: "n" };

/** 種類ごとに残す欄。ここにない欄は保存しない */
const SCHEMA: Record<TraceEventType, Record<string, FieldKind>> = {
  "run.started": { question: "q", mode: "s", sources: "ss", queries: "ss", urls: "us", procedure: "s", procedureVersion: "s", client: "s" },
  "run.steered": { question: "q", queries: "ss", urls: "us" },
  "run.deepened": {},
  "run.done": { why: "s", searched: "n", found: "n", fetched: "n", failed: "n", elapsedMs: "n" },
  "search.sent": { query: "s", provider: "s", ok: "b", hits: "n" },
  "source.fetched": { sourceId: "s", url: "u", host: "s", kind: "s", tier: "s", title: "s", origin: "s", ms: "n", reused: "b" },
  "passage.selected": { passageId: "s", sourceId: "s", context: "s", chars: "n", via: "s" },
  "ledger.hit": { recordId: "s", url: "u", status: "s", reason: "s" },
  "verify.done": { claims: "c" },
  cutoff: { what: "u", why: "s", host: "s", kind: "s", tier: "s", origin: "s", detail: "s" },
};

/** 欄の型が必須か（ない・形が違うなら事象ごと捨てる）。それ以外は任意 */
const REQUIRED: Record<TraceEventType, string[]> = {
  "run.started": ["question", "mode"],
  "run.steered": ["question"],
  "run.deepened": [],
  "run.done": ["why"],
  "search.sent": ["query", "provider"],
  "source.fetched": ["sourceId", "url"],
  "passage.selected": ["passageId", "sourceId"],
  "ledger.hit": ["recordId", "status"],
  "verify.done": [],
  cutoff: ["what", "why"],
};

export const TRACE_EVENT_TYPES = Object.keys(SCHEMA) as TraceEventType[];

/** 書記素ではなくコードポイントで切る（サロゲートの片割れを残さない） */
export function clipChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, Math.max(0, max)).join("");
}

/** URL のホスト名。URL でなければ undefined */
export function hostOf(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function str(x: unknown, max: number): string | undefined {
  return typeof x === "string" ? clipChars(x, max) : undefined;
}

function count(x: unknown): number | undefined {
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  return Math.max(0, Math.round(x));
}

function strs(x: unknown, max: number, L: TraceLimits): string[] | undefined {
  if (!Array.isArray(x)) return undefined;
  return x
    .filter((s): s is string => typeof s === "string")
    .slice(0, L.listMax)
    .map((s) => clipChars(s, max));
}

function claims(x: unknown, L: TraceLimits): TraceClaim[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: TraceClaim[] = [];
  for (const c of x.slice(0, L.listMax)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const status = str(o.status, L.shortMaxChars);
    if (!status) continue;
    const claim: TraceClaim = {
      status,
      passageIds: strs(o.passageIds, L.shortMaxChars, L) ?? [],
      recorded: strs(o.recorded, L.shortMaxChars, L) ?? [],
    };
    const reason = str(o.reason, L.shortMaxChars);
    if (reason) claim.reason = reason;
    out.push(claim);
  }
  return out;
}

function field(kind: FieldKind, x: unknown, L: TraceLimits): unknown {
  switch (kind) {
    case "q":
      return str(x, L.questionMaxChars);
    case "s":
      return str(x, L.shortMaxChars);
    case "u":
      return str(x, L.urlMaxChars);
    case "n":
      return count(x);
    case "b":
      return typeof x === "boolean" ? x : undefined;
    case "ss":
      return strs(x, L.shortMaxChars, L);
    case "us":
      return strs(x, L.urlMaxChars, L);
    case "c":
      return claims(x, L);
  }
}

/**
 * 保存してよい形に整える。種類が分からない・共通の欄や必須の欄がない事象は null。
 * 返すのは、その種類に許した欄だけ（C-04）
 */
export function sanitizeTraceEvent(input: unknown, limits: TraceLimits = TRACE_LIMITS): TraceEvent | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== "string" || !Object.hasOwn(SCHEMA, type)) return null;
  const t = type as TraceEventType;
  const out: Record<string, unknown> = { type: t };
  for (const [k, kind] of Object.entries(COMMON)) {
    const val = field(kind, o[k], limits);
    if (val === undefined || val === "") return null;
    out[k] = val;
  }
  for (const [k, kind] of Object.entries(SCHEMA[t])) {
    const val = field(kind, o[k], limits);
    if (val !== undefined) out[k] = val;
  }
  for (const k of REQUIRED[t]) if (out[k] === undefined) return null;
  return out as TraceEvent;
}

/** その種類に許した欄の名前（試験と文書の一覧に使う） */
export function traceFields(type: TraceEventType): string[] {
  return ["type", ...Object.keys(COMMON), ...Object.keys(SCHEMA[type])];
}
