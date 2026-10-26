import { getDocumentProxy } from "unpdf";
import { isReferenceHeading, type Block } from "@ai-research/core";

/**
 * PDF の文字を塊にする（設計 v1.5 §8.3.4、制約 Q-08）。unpdf（pdf.js の serverless 版）を使う。
 *
 * - 行の縦の間が、ふつうの行の間より大きいところで段落を分ける（PDF には空行がない）
 * - 行末のハイフンでつながった語は戻す（"exam-" + "ple" → "example"）
 * - 参考文献の見出しだけの段落は見出しの塊にする（後で markReferences が参考文献の節を ref にする）
 * - 上限：ページ数（maxPages）と時間（timeoutMs）。超えたら読んだところまで（truncated）か失敗
 * 原文はメモリだけに置く（E-01、INV-13）。
 */
export type PdfResult = { blocks: Block[]; pages: number; readPages: number; truncated: boolean };

type Item = { str: string; hasEOL?: boolean; transform: number[] };

export async function pdfBlocks(bytes: Uint8Array, opts: { maxPages: number; timeoutMs: number }): Promise<PdfResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("PDF の読み取りが時間の上限を超えた")), opts.timeoutMs);
  });
  try {
    return await Promise.race([read(bytes, opts.maxPages), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function read(bytes: Uint8Array, maxPages: number): Promise<PdfResult> {
  const pdf = await getDocumentProxy(bytes);
  const pages = pdf.numPages;
  const readPages = Math.min(pages, maxPages);
  const blocks: Block[] = [];
  for (let n = 1; n <= readPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const lines = toLines(content.items as Item[]);
    for (const para of toParagraphs(lines)) {
      if (isReferenceHeading(para)) blocks.push({ kind: "heading", text: para });
      else blocks.push({ kind: "prose", text: para, context: `p. ${n}` });
    }
  }
  return { blocks, pages, readPages, truncated: readPages < pages };
}

type Line = { text: string; y: number };

/** 文字の断片を行にまとめる（hasEOL か、縦の位置が変わったところで切る） */
function toLines(items: Item[]): Line[] {
  const out: Line[] = [];
  let cur = "";
  let y: number | null = null;
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t && y !== null) out.push({ text: t, y });
    cur = "";
  };
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const iy = it.transform?.[5] ?? 0;
    if (y !== null && Math.abs(iy - y) > 2 && cur) flush();
    if (!cur) y = iy;
    cur += it.str;
    if (it.hasEOL) flush();
  }
  flush();
  return out;
}

/** 行を段落にまとめる。ふつうの行の間（最小の間）の 1.5 倍より広い間で切る */
function toParagraphs(lines: Line[]): string[] {
  if (lines.length === 0) return [];
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = Math.abs(lines[i - 1]!.y - lines[i]!.y);
    if (g > 0) gaps.push(g);
  }
  // ふつうの行の間：3ポイント以上の間の最小（段落の切れ目はそれより広い）。行が少ないページでも決まる
  const typical = Math.min(...gaps.filter((g) => g >= 3), Number.POSITIVE_INFINITY);
  const paras: string[] = [];
  let cur = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text;
    // 参考文献の見出しだけの行は、それだけで1つの段落
    if (isReferenceHeading(line)) {
      if (cur) paras.push(cur);
      paras.push(line);
      cur = "";
      continue;
    }
    if (i > 0 && cur) {
      const g = Math.abs(lines[i - 1]!.y - lines[i]!.y);
      const breakHere = Number.isFinite(typical) && (g > typical * 1.5 || lines[i]!.y > lines[i - 1]!.y + 1);
      if (breakHere) {
        if (cur) paras.push(cur);
        cur = "";
      }
    }
    if (!cur) cur = line;
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(line)) cur = cur.slice(0, -1) + line;
    else cur = `${cur} ${line}`;
  }
  if (cur) paras.push(cur);
  return paras.map((p) => p.trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
}
