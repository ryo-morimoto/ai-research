import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

/**
 * HTML から本文を取り出す。段落の区切りは空行で表す（core の splitParagraphs が使う）。
 * 要約は挟まない（S-03）。
 */
export function extractHtml(html: string, url: string): { title: string | null; text: string } {
  const { document } = parseHTML(html);
  let title: string | null = document.querySelector("title")?.textContent?.trim() || null;
  let root: { querySelectorAll(sel: string): ArrayLike<{ textContent: string | null }> } | null = null;
  try {
    // Readability は document を書き換えるので、本文用に別に解析する
    const { document: forReadability } = parseHTML(html);
    const article = new Readability(forReadability as never, { charThreshold: 200 }).parse();
    if (article?.content) {
      title = article.title?.trim() || title;
      root = parseHTML(`<html><body>${article.content}</body></html>`).document;
    }
  } catch {
    root = null;
  }
  if (!root) {
    for (const el of document.querySelectorAll("script, style, noscript, nav, footer, header, aside")) el.remove();
  }
  const blocks: string[] = [];
  const nodes = (root ?? document).querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, th, dt, dd, figcaption");
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i]?.textContent?.replace(/\s+/g, " ").trim();
    if (t) blocks.push(t);
  }
  let text = blocks.join("\n\n");
  if (text.length === 0) text = (document.body?.textContent ?? "").replace(/[ \t]+/g, " ").trim();
  void url;
  return { title, text };
}
