/**
 * 1回の調査の概念とずれの印（docs/05 §3.5、V-03、目的 1）。純粋な関数。LLM を使わない（C-02）。
 *
 * - 概念の種は、会話の Claude が start・steer で選んだ検索語そのもの。語の集合がよく似た検索語は1つの概念にまとめる。
 *   検索語がなければ、問いを1つの概念にする。表示名は検索語をそのまま使う（作文しない）
 * - 出典の語は、題・届けた段落の見出し・URL の道筋の語から取る（本文は記録にない。C-04）
 * - 「未到達」：その版のどの出典にも当たらなかった概念。「外れ」：問いと検索語の語を1つも含まない出典
 * - 語の分け方は段落選び（select.ts の discriminativeTerms）と同じ。ずれの印と段落の選ばれ方が食い違わないように
 *
 * 印は目安で、向きを決めるのは本人。
 */
import { discriminativeTerms } from "./select.ts";
import type { TraceEvent } from "./trace.ts";

export type DriftOptions = {
  /** 検索語どうしを1つの概念にまとめる、語の集合の Jaccard 係数の下限 */
  merge: number;
  /** 出典が概念に当たったとみなす、概念の語のうち出典に現れる割合の下限 */
  reach: number;
};

export const DRIFT_DEFAULTS: DriftOptions = { merge: 0.5, reach: 0.5 };

export type DriftConcept = {
  /** 表示名（まとめた検索語のうち最初のもの） */
  label: string;
  /** まとめた検索語（検索語がなければ問い） */
  queries: string[];
  terms: string[];
  /** この概念に当たった出典 */
  reachedBy: string[];
};

export type DriftSource = {
  sourceId: string;
  host?: string;
  title?: string;
  /** 当たった概念の表示名 */
  matched: string[];
  /** 問いと検索語の語を1つも含まない */
  off: boolean;
};

export type DriftVersion = {
  v: number;
  question: string;
  concepts: DriftConcept[];
  sources: DriftSource[];
  /** 未到達の概念の表示名 */
  unreached: string[];
  /** 外れの出典の sourceId */
  off: string[];
};

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** URL の道筋の語（スラッグの - と _ と / で区切る）。ホスト名は含めない */
function urlWords(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname).replace(/[-_/.]+/g, " ");
  } catch {
    return "";
  }
}

/** 検索語を概念にまとめる。入力の順を保ち、先に出た概念へ寄せる（決定的） */
function conceptsOf(question: string, queries: string[], opts: DriftOptions): DriftConcept[] {
  const seeds = queries.length ? queries : [question];
  const out: (DriftConcept & { set: Set<string> })[] = [];
  for (const q of seeds) {
    const set = new Set(discriminativeTerms(q));
    if (set.size === 0) continue;
    const near = out.find((c) => jaccard(c.set, set) >= opts.merge);
    if (near) {
      near.queries.push(q);
      for (const t of set) near.set.add(t);
      near.terms = [...near.set];
    } else out.push({ label: q, queries: [q], terms: [...set], reachedBy: [], set });
  }
  return out.map(({ set: _set, ...c }) => c);
}

/**
 * 事象の列から、問いの版ごとの概念とずれの印を計算する。同じ事象の列からは必ず同じ結果になる
 */
export function driftOf(events: readonly TraceEvent[], opts: DriftOptions = DRIFT_DEFAULTS): DriftVersion[] {
  type Src = { sourceId: string; host?: string; title?: string; url?: string; contexts: string[] };
  const versions = new Map<number, { question: string; queries: string[]; sources: Map<string, Src> }>();
  const ordered = [...events].sort((a, b) => a.ev - b.ev);
  for (const e of ordered) {
    if (e.type === "run.started" || e.type === "run.steered") {
      versions.set(e.v, { question: e.question, queries: e.queries ?? [], sources: new Map() });
      continue;
    }
    const ver = versions.get(e.v);
    if (!ver) continue;
    if (e.type === "source.fetched") {
      const s: Src = { sourceId: e.sourceId, contexts: [] };
      if (e.host) s.host = e.host;
      if (e.title) s.title = e.title;
      s.url = e.url;
      ver.sources.set(e.sourceId, s);
    } else if (e.type === "passage.selected" && e.context) {
      ver.sources.get(e.sourceId)?.contexts.push(e.context);
    }
  }

  const out: DriftVersion[] = [];
  for (const [v, ver] of [...versions.entries()].sort((a, b) => a[0] - b[0])) {
    const concepts = conceptsOf(ver.question, ver.queries, opts);
    const all = new Set([...concepts.flatMap((c) => c.terms), ...discriminativeTerms(ver.question)]);
    const sources: DriftSource[] = [];
    for (const s of ver.sources.values()) {
      const words = new Set(discriminativeTerms([s.title ?? "", ...s.contexts, urlWords(s.url)].join(" ")));
      const matched: string[] = [];
      for (const c of concepts) {
        const hit = c.terms.filter((t) => words.has(t)).length;
        if (hit > 0 && hit / c.terms.length >= opts.reach) {
          matched.push(c.label);
          c.reachedBy.push(s.sourceId);
        }
      }
      let off = true;
      for (const t of words) {
        if (all.has(t)) {
          off = false;
          break;
        }
      }
      const d: DriftSource = { sourceId: s.sourceId, matched, off };
      if (s.host) d.host = s.host;
      if (s.title) d.title = s.title;
      sources.push(d);
    }
    out.push({
      v,
      question: ver.question,
      concepts,
      sources,
      unreached: concepts.filter((c) => c.reachedBy.length === 0).map((c) => c.label),
      off: sources.filter((s) => s.off).map((s) => s.sourceId),
    });
  }
  return out;
}
