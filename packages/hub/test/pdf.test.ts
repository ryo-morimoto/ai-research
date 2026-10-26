import { describe, it, expect } from "vitest";
import { pdfBlocks } from "../src/pdf.ts";

import { env } from "cloudflare:test";

// 偽の取得先（test/upstream.mjs）の PDF（2ページ。2ページ目は参考文献）
async function fixture(): Promise<Uint8Array> {
  const r = await env.TEST_UPSTREAM!.fetch("https://repo.example.edu/kd1996.pdf");
  return new Uint8Array(await r.arrayBuffer());
}

describe("PDF の文字（設計 v1.5 §8.3.4）", () => {
  it("行の間で段落に分け、ページを context にし、参考文献の見出しを見出しにする", async () => {
    const r = await pdfBlocks(await fixture(), { maxPages: 60, timeoutMs: 5_000 });
    expect(r.pages).toBe(2);
    expect(r.blocks).toContainEqual({
      kind: "prose",
      text: "Skilled intuitions develop when the environment is sufficiently regular and when people have an opportunity to learn these regularities through prolonged practice.",
      context: "p. 1",
    });
    expect(r.blocks).toContainEqual({ kind: "heading", text: "References" });
  });

  it("ページ数の上限を超えたら、読んだところまで（truncated）", async () => {
    const r = await pdfBlocks(await fixture(), { maxPages: 1, timeoutMs: 5_000 });
    expect(r).toMatchObject({ pages: 2, readPages: 1, truncated: true });
  });

  it("PDF でないものは失敗する（呼んだ側が unsupported にする）", async () => {
    await expect(pdfBlocks(new TextEncoder().encode("not a pdf"), { maxPages: 60, timeoutMs: 5_000 })).rejects.toThrow();
  });
});
