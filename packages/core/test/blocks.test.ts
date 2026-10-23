import { describe, expect, it } from "vitest";
import { blocksFromMarkdown, candidateParagraphs } from "../src/index.ts";

describe("blocksFromMarkdown（設計 v1.3 D10）", () => {
  it("フロントマターは日付の項目だけメタデータにし、残りは捨てる", () => {
    const b = blocksFromMarkdown("---\ntitle: Limits\npcx_content_type: concept\nupdated: 2026-09-30\n---\n\n本文の文。");
    expect(b).toEqual([
      { kind: "meta", text: "updated: 2026-09-30" },
      { kind: "prose", text: "本文の文。" },
    ]);
  });

  it("表の行は1行ずつの塊にし、見出しと見出し行を context に持つ。<br> と | は表示の形にする", () => {
    const md = "## Worker limits\n\n| Feature | Workers Free | Workers Paid |\n| --- | --- | --- |\n| CPU time | 10 ms | 5 min<br>(default 30 s) |\n| Memory | 128 MB | 128 MB |";
    const rows = blocksFromMarkdown(md).filter((x) => x.kind === "row");
    expect(rows).toEqual([
      { kind: "row", text: "CPU time | 10 ms | 5 min (default 30 s)", context: "Worker limits — Feature | Workers Free | Workers Paid" },
      { kind: "row", text: "Memory | 128 MB | 128 MB", context: "Worker limits — Feature | Workers Free | Workers Paid" },
    ]);
  });

  it("箇条は1項目ずつ（長い箇条が1つの段落にまとまって切れない）。リンクは文字だけ、タグだけの行は捨てる", () => {
    const md = "## principles\n\n<details>\n<summary>all</summary>\n\n- **Fix Root Causes.** Debugging. Trace each symptom back.\n- **Prove It Works.** Verify against the [real artifact](./x.md).\n  continued line.\n\n</details>";
    const items = blocksFromMarkdown(md).filter((x) => x.kind === "item");
    expect(items.map((x) => x.text)).toEqual([
      "Fix Root Causes. Debugging. Trace each symptom back.",
      "Prove It Works. Verify against the real artifact. continued line.",
    ]);
    expect(items[0]!.context).toBe("principles");
  });

  it("見出し・コードは段落の候補にしない。記号だけの塊も候補にしない", () => {
    const blocks = blocksFromMarkdown("# CPU time (ms)\n\n```json\n{\"@context\": \"https://schema.org\"}\n```\n\n---\n\n本文。");
    const c = candidateParagraphs("s1", blocks);
    expect(c.map((x) => x.text)).toEqual(["本文。"]);
    // index は塊の位置（取り直しても同じ）
    expect(c[0]!.index).toBe(blocks.findIndex((x) => x.text === "本文。"));
  });
});
