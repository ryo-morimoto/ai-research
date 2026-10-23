import type { Cutoff } from "@ai-research/sandbox-api";

/**
 * 打ち切りの見せ方（制約 v0.7 Q-04、設計 v1.3 §8.1）。純粋な関数。
 * 答えに影響しうるもの（利用者が示した URL、台帳の候補の照らし直し、検索そのもの）は1件ずつ。
 * 検索で見つけたページの取得の失敗は、まとめて件数で1件にする。
 */
export type CutoffOrigin = "url" | "ledger" | "search" | "system";
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
    out.push({
      what: `検索で見つけたページ ${fromSearch.length} 件`,
      why: sorted[0]![0] as Cutoff["why"],
      detail: `取れなかった：${sorted.map(([w, n]) => `${w} ${n}`).join("、")}`,
    });
  }
  return out;
}
