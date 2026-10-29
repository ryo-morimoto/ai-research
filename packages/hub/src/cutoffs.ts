import type { Cutoff } from "@ai-research/sandbox-api";
import type { TraceOrigin } from "@ai-research/core";

/**
 * 打ち切りの見せ方（制約 v0.7 Q-04、設計 v1.3 §8.1）。純粋な関数。
 * 答えに影響しうるもの（利用者が示した URL、台帳の候補の照らし直し、検索そのもの）は1件ずつ。
 * 検索で見つけたページの取得の失敗は、まとめて件数で1件にする。まとめても URL は残す（経路外で読むため。設計 v1.4 §8.2.4）。
 */
/** 出典を何から取ったか。記録（trace）の origin と同じ1つの定義 */
export type CutoffOrigin = TraceOrigin;
export type CutoffItem = { cutoff: Cutoff; origin: CutoffOrigin };

export function presentCutoffs(items: CutoffItem[]): Cutoff[] {
  const out: Cutoff[] = [];
  const fromSearch: Cutoff[] = [];
  for (const it of items) (it.origin === "search" ? fromSearch : out).push(it.cutoff);
  if (fromSearch.length === 1) out.push(fromSearch[0]!);
  else if (fromSearch.length > 1) {
    const counts = new Map<string, number>();
    for (const c of fromSearch) counts.set(c.why, (counts.get(c.why) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const c: Cutoff = {
      what: `検索で見つけたページ ${fromSearch.length} 件`,
      why: sorted[0]![0] as Cutoff["why"],
      detail: `取れなかった：${sorted.map(([w, n]) => `${w} ${n}`).join("、")}`,
    };
    const urls = fromSearch.map((x) => x.what).filter((w) => /^https?:\/\//.test(w));
    if (urls.length) c.urls = urls;
    // 理由がすべて no_passage なら、まとめても理由は no_passage（find の対象が分かるように）
    if (fromSearch.every((x) => x.why === "no_passage")) c.detail = "取得できたが、問いに合う段落が選ばれなかった。research.find（URL で指定）で語句を探せる";
    out.push(c);
  }
  return out;
}
