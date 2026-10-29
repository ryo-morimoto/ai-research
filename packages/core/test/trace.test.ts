/**
 * 調査の記録の整形（docs/05 §3、C-04）
 *   T1 どんな入力でも、残るのはその種類に許した欄だけ（本文の欄 text は残らない）
 *   T2 どんな入力でも、文字列は上限を超えない。配列は listMax を超えない
 *   T3 整形は冪等（整形したものをもう一度整形しても変わらない）
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TRACE_EVENT_TYPES, TRACE_LIMITS, clipChars, hostOf, sanitizeTraceEvent, traceFields, type TraceEventType } from "../src/index.ts";

const runs = Number(process.env.FC_RUNS ?? 300);
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const params = { numRuns: runs, ...(seed !== undefined ? { seed } : {}) };

const longText = fc.string({ unit: "binary", maxLength: 3000 });
const anyValue = fc.oneof(longText, fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.array(longText, { maxLength: 80 }));
const claimLike = fc.record({ status: longText, reason: longText, passageIds: fc.array(longText, { maxLength: 80 }), recorded: fc.array(longText, { maxLength: 80 }), text: longText });

/** 種類ごとの欄に、ありとあらゆる値と余計な欄（text・body など）を混ぜた入力 */
const eventLike = fc
  .record({
    type: fc.constantFrom<TraceEventType>(...TRACE_EVENT_TYPES),
    runId: fc.string({ minLength: 1, maxLength: 400 }),
    at: fc.integer({ min: 0 }),
    ev: fc.integer({ min: 0 }),
    v: fc.integer({ min: 0 }),
    extra: fc.dictionary(fc.constantFrom("text", "body", "html", "passage", "raw", "content"), longText),
    fields: fc.dictionary(
      fc.constantFrom("question", "mode", "sources", "queries", "urls", "procedure", "procedureVersion", "client", "why", "query", "provider", "ok", "hits", "sourceId", "url", "host", "kind", "tier", "title", "origin", "ms", "passageId", "context", "chars", "via", "recordId", "status", "reason", "what", "detail", "searched", "found", "fetched", "failed", "elapsedMs"),
      anyValue,
    ),
    claims: fc.array(claimLike, { maxLength: 80 }),
  })
  .map(({ extra, fields, claims, ...rest }) => ({ ...extra, ...fields, claims, ...rest }));

function maxStringLength(x: unknown): number {
  if (typeof x === "string") return x.length;
  if (Array.isArray(x)) return Math.max(0, ...x.map(maxStringLength));
  if (x && typeof x === "object") return Math.max(0, ...Object.values(x).map(maxStringLength));
  return 0;
}
function maxArrayLength(x: unknown): number {
  if (Array.isArray(x)) return Math.max(x.length, ...x.map(maxArrayLength));
  if (x && typeof x === "object") return Math.max(0, ...Object.values(x).map(maxArrayLength));
  return 0;
}

describe("記録の整形（性質）", () => {
  it("T1：許した欄だけが残る。本文の欄は残らない", () => {
    fc.assert(
      fc.property(eventLike, (input) => {
        const out = sanitizeTraceEvent(input);
        if (!out) return;
        const allowed = new Set(traceFields(out.type));
        for (const k of Object.keys(out)) expect(allowed.has(k), k).toBe(true);
        expect(JSON.stringify(out)).not.toMatch(/"(text|body|html|passage|raw|content)":/);
      }),
      params,
    );
  });

  it("T2：文字列と配列は上限を超えない", () => {
    const L = TRACE_LIMITS;
    fc.assert(
      fc.property(eventLike, (input) => {
        const out = sanitizeTraceEvent(input);
        if (!out) return;
        for (const [k, val] of Object.entries(out)) {
          const max = k === "question" ? L.questionMaxChars : k === "url" || k === "what" || k === "urls" ? L.urlMaxChars : L.shortMaxChars;
          // サロゲートの組は2単位なので、コードポイントで数えた上限の2倍を超えない
          expect(maxStringLength(val), k).toBeLessThanOrEqual(max * 2);
          if (typeof val === "string") expect(Array.from(val).length, k).toBeLessThanOrEqual(max);
        }
        expect(maxArrayLength(out)).toBeLessThanOrEqual(L.listMax);
      }),
      params,
    );
  });

  it("T3：整形は冪等", () => {
    fc.assert(
      fc.property(eventLike, (input) => {
        const once = sanitizeTraceEvent(input);
        if (!once) return;
        expect(sanitizeTraceEvent(once)).toEqual(once);
      }),
      params,
    );
  });
});

describe("記録の整形（例）", () => {
  const base = { runId: "run_1", at: 1, ev: 1, v: 1 };

  it("種類が分からない・共通の欄がない・必須の欄がない事象は捨てる", () => {
    expect(sanitizeTraceEvent({ ...base, type: "passage.text", text: "x" })).toBeNull();
    expect(sanitizeTraceEvent({ type: "run.deepened", at: 1, ev: 1, v: 1 })).toBeNull();
    expect(sanitizeTraceEvent({ ...base, type: "source.fetched", sourceId: "s1" })).toBeNull();
    expect(sanitizeTraceEvent({ ...base, type: "__proto__" })).toBeNull();
  });

  it("段落の事象は本文を持たず、長さだけを持つ", () => {
    const out = sanitizeTraceEvent({ ...base, type: "passage.selected", passageId: "p1", sourceId: "s1", text: "本文".repeat(500), chars: 1000, via: "bundle" });
    expect(out).toEqual({ ...base, type: "passage.selected", passageId: "p1", sourceId: "s1", chars: 1000, via: "bundle" });
  });

  it("数は 0 以上の整数に丸める", () => {
    const out = sanitizeTraceEvent({ ...base, type: "search.sent", query: "q", provider: "web", ok: true, hits: -3.6 });
    expect(out).toMatchObject({ hits: 0 });
  });

  it("サロゲートの組を割らずに切る", () => {
    // 絵文字はエスケープ表記で書く：生のサロゲートペアのリテラルがこのファイルにあると、
    // pkspec-adapter-vitest の discover が SIGABRT で落ちる（上流の不具合。issues/009 の最小再現）
    const face = "\u{1F600}";
    expect(clipChars(face.repeat(3), 2)).toBe(face.repeat(2));
  });

  it("ホスト名は小文字。URL でなければ undefined", () => {
    expect(hostOf("https://Docs.Example.COM/a")).toBe("docs.example.com");
    expect(hostOf("検索で見つけたページ 3 件")).toBeUndefined();
  });
});
