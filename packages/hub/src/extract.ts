import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { blocksFromPlainText, type Block } from "@ai-research/core";

/**
 * HTML を型つきの塊にする（設計 v1.3 D10）。要約は挟まない（S-03）。
 *
 * - 本文は Readability で取り出し、要素の順に塊にする（見出し・文・箇条の1項目・表の1行・コード）
 * - 表の見出し行と直前の見出しは context に持つ
 * - 公開日・更新日は、ページの属性（meta 要素、JSON-LD）の値を原文どおりにメタデータの塊にする
 */

type El = {
  tagName: string;
  textContent: string | null;
  parentElement: El | null;
  children: ArrayLike<El>;
  childNodes: ArrayLike<{ nodeType: number; textContent: string | null; tagName?: string }>;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
};

const BLOCK_SEL = "h1, h2, h3, h4, h5, h6, p, li, tr, pre, blockquote, dt, dd, figcaption";
const CONTAINERS = new Set(["LI", "TR", "PRE", "DT", "DD", "FIGCAPTION", "P"]);
const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function hasContainerAncestor(el: El): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (CONTAINERS.has(p.tagName)) return true;
  return false;
}

/** li の文から、入れ子の箇条を除く */
function ownText(el: El): string {
  let s = "";
  const walk = (n: El) => {
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i]!;
      if (c.nodeType === 3) s += c.textContent ?? "";
      else if (c.nodeType === 1 && !["UL", "OL"].includes(c.tagName ?? "")) walk(c as unknown as El);
    }
  };
  walk(el);
  return clean(s);
}

const DATE_META = [
  "article:published_time",
  "article:modified_time",
  "og:updated_time",
  "date",
  "dc.date",
  "datePublished",
  "dateModified",
  "last-modified",
];

/** 公開日・更新日（ページの属性の値を、名前と一緒に原文どおりに） */
function metaBlocks(doc: El): Block[] {
  const out: Block[] = [];
  const seen = new Set<string>();
  const add = (key: string, value: string | null | undefined) => {
    const v = clean(value);
    if (!v || seen.has(key)) return;
    seen.add(key);
    out.push({ kind: "meta", text: `${key}: ${v}`, context: "ページのメタデータ" });
  };
  const metas = doc.querySelectorAll("meta");
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i]!;
    const key = m.getAttribute("property") ?? m.getAttribute("name") ?? m.getAttribute("itemprop");
    if (key && DATE_META.includes(key)) add(key, m.getAttribute("content"));
  }
  const ld = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < ld.length; i++) {
    try {
      const j = JSON.parse(ld[i]!.textContent ?? "") as unknown;
      for (const o of Array.isArray(j) ? j : [j]) {
        const r = o as Record<string, unknown>;
        if (typeof r.datePublished === "string") add("datePublished", r.datePublished);
        if (typeof r.dateModified === "string") add("dateModified", r.dateModified);
      }
    } catch {
      // 壊れた JSON-LD は使わない
    }
  }
  const time = doc.querySelector("article time[datetime], main time[datetime]");
  if (time) add("time", time.getAttribute("datetime"));
  return out;
}

/** <meta http-equiv="refresh" content="0; url=…"> の転送先（あれば） */
export function metaRefreshTarget(html: string, base: string): string | null {
  const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i);
  if (!m?.[1]) return null;
  try {
    return new URL(m[1], base).toString();
  } catch {
    return null;
  }
}

export function extractHtml(html: string, url: string): { title: string | null; blocks: Block[] } {
  const { document } = parseHTML(html);
  const doc = document as unknown as El;
  let title: string | null = clean(document.querySelector("title")?.textContent) || null;
  const meta = metaBlocks(doc);

  let root: El | null = null;
  try {
    // Readability は document を書き換えるので、本文用に別に解析する
    const { document: forReadability } = parseHTML(html);
    const article = new Readability(forReadability as never, { charThreshold: 200 }).parse();
    if (article?.content) {
      title = article.title?.trim() || title;
      root = parseHTML(`<html><body>${article.content}</body></html>`).document as unknown as El;
    }
  } catch {
    root = null;
  }
  if (!root) {
    const all = doc.querySelectorAll("script, style, noscript, nav, footer, header, aside");
    for (let i = 0; i < all.length; i++) (all[i] as unknown as { remove(): void }).remove();
    root = doc;
  }

  const blocks: Block[] = [...meta];
  let heading: string | undefined;
  let table: El | null = null;
  let header: string | undefined;
  const nodes = root.querySelectorAll(BLOCK_SEL);
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    const tag = el.tagName;
    if (tag !== "LI" && tag !== "TR" && hasContainerAncestor(el)) continue;
    if (/^H[1-6]$/.test(tag)) {
      const t = clean(el.textContent);
      if (t) {
        heading = t;
        blocks.push({ kind: "heading", text: t });
      }
      continue;
    }
    if (tag === "TR") {
      let t: El | null = el.parentElement;
      while (t && t.tagName !== "TABLE") t = t.parentElement;
      if (t !== table) {
        table = t;
        header = undefined;
      }
      const cells: string[] = [];
      let allTh = true;
      for (let k = 0; k < el.children.length; k++) {
        const c = el.children[k]!;
        if (c.tagName !== "TH" && c.tagName !== "TD") continue;
        if (c.tagName !== "TH") allTh = false;
        cells.push(clean(c.textContent));
      }
      const text = cells.join(" | ");
      if (!text.replace(/[|\s]/g, "")) continue;
      if (allTh || el.parentElement?.tagName === "THEAD") {
        header = text;
        continue;
      }
      const context = [heading, header].filter(Boolean).join(" — ");
      blocks.push(context ? { kind: "row", text, context } : { kind: "row", text });
      continue;
    }
    if (tag === "PRE") {
      const t = (el.textContent ?? "").trim();
      if (t) blocks.push({ kind: "code", text: t });
      continue;
    }
    if (tag === "BLOCKQUOTE" && el.querySelector("p, li")) continue;
    const text = tag === "LI" ? ownText(el) : clean(el.textContent);
    if (!text) continue;
    const kind = tag === "LI" ? "item" : "prose";
    blocks.push(heading ? { kind, text, context: heading } : { kind, text });
  }
  if (blocks.length === meta.length) blocks.push(...blocksFromPlainText(clean(document.body?.textContent)));
  void url;
  return { title, blocks };
}
