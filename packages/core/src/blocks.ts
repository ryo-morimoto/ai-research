import { normalize } from "./normalize.ts";
import type { Paragraph } from "./select.ts";

/**
 * 原文の型つきの塊（設計 v1.3 D10、§8.1.3）
 *
 * 取得した原文を、文・箇条の1項目・表の1行・見出し・コード・メタデータに分けて持つ。
 * 段落の候補にするのは、文として読める塊（prose、item、row、meta）だけ。
 * 見出しと表の見出し行は context として添える。照合の対象は text だけ。
 */
export type BlockKind = "prose" | "item" | "row" | "heading" | "code" | "meta" | "ref";

/** weight は段落の順位の重み（既定 1）。論文の書誌の1行のように、内容より下に並べたい塊に付ける */
export type Block = { kind: BlockKind; text: string; context?: string; weight?: number };

export const CANDIDATE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["prose", "item", "row", "meta"]);

/** 照合と照らし直しに使う文書の全文。塊の text を空行でつなぐ（塊の順番どおり） */
export function docText(blocks: Block[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

/** 段落の候補（index は塊の位置。取り直しても同じ原文なら同じ位置になる） */
export function candidateParagraphs(sourceId: string, blocks: Block[]): (Paragraph & { context?: string })[] {
  const out: (Paragraph & { context?: string })[] = [];
  blocks.forEach((b, index) => {
    if (!CANDIDATE_KINDS.has(b.kind)) return;
    const text = normalize(b.text);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const p: Paragraph & { context?: string } = { sourceId, index, text };
    if (b.context) p.context = b.context;
    if (b.weight !== undefined) p.weight = b.weight;
    out.push(p);
  });
  return out;
}

/**
 * 参考文献・脚注・関連項目・外部リンクの節の見出しか（設計 v1.4 §8.2.3）。
 * 節番号（"7."）と編集の印（"[edit]"、"[編集]"）は除いて比べる
 */
const REF_HEADING =
  /^(references?|notes?|footnotes?|endnotes?|see also|external links?|further reading|bibliography|sources|citations|works cited|literature cited|reference list|参考文献|脚注|注釈|注|関連項目|外部リンク|出典|引用文献|参照|関連文献)$/i;

export function isReferenceHeading(text: string): boolean {
  const t = normalize(text)
    .replace(/\[(edit|編集|ソースを編集)\]/gi, "")
    .replace(/^[\d.\s]+/, "")
    .replace(/[:：]$/, "")
    .trim();
  return REF_HEADING.test(t);
}

/**
 * 参考文献の並び（著者, 頭文字. (年). 題名）の形か。Wikipedia の「^」で始まる脚注も含む。
 * 文の途中に引用があるだけの文（"Gollwitzer (1990) showed …"）は当てない（年の後ろに "." が要る）
 */
const CITATION = /^[\^↑*]?\s*(\d+\.\s+)?[\p{Lu}][\p{L}'’-]+,\s+(\p{Lu}\.\s?){1,3}.{0,400}?\(\d{4}[a-z]?\)\.\s/u;

export function looksLikeCitation(text: string): boolean {
  return CITATION.test(normalize(text));
}

/**
 * 参考文献の塊に印を付ける（kind を "ref" にする。段落の候補にしない）。
 * 照合の全文（docText）には残すので、原文の順番は変わらない
 */
export function markReferences(blocks: Block[]): Block[] {
  let inRef = false;
  return blocks.map((b) => {
    if (b.kind === "heading") {
      inRef = isReferenceHeading(b.text);
      return b;
    }
    if (b.kind === "meta" || b.kind === "code") return b;
    if (inRef || (b.context !== undefined && isReferenceHeading(b.context.split(" — ").at(-1) ?? ""))) return { ...b, kind: "ref" };
    if ((b.kind === "item" || b.kind === "prose") && looksLikeCitation(b.text)) return { ...b, kind: "ref" };
    return b;
  });
}

/**
 * 「：」「:」で終わる導入の文を、続く箇条の context に添える（設計 v1.4 §8.2.5）。
 * 「次の二つの条件の両方が成り立つとき：」と条件の本体を、同じ候補として選べるようにする。導入の文そのものも残す
 */
export function attachLeadIns(blocks: Block[]): Block[] {
  let lead: string | undefined;
  return blocks.map((b) => {
    if (b.kind === "item" && lead) {
      return { ...b, context: b.context && !b.context.endsWith(lead) ? `${b.context} — ${lead}` : lead };
    }
    lead = b.kind === "prose" && /[:：]$/.test(b.text.trim()) ? b.text.trim() : undefined;
    return b;
  });
}

/** 空行で区切った文を prose の塊にする（形の分からない文書） */
export function blocksFromPlainText(text: string): Block[] {
  return text
    .split(/\n\s*\n+/)
    .map((t) => normalize(t))
    .filter((t) => t.length > 0)
    .map((t) => ({ kind: "prose" as const, text: t }));
}

const META_KEYS = /^(date|published|publishdate|pubdate|updated|lastmod|modified|last_modified|created)$/i;

/** Markdown の行内の記法を、表示される文字にする（リンクは文字だけ、画像とタグは除く） */
function inlineMd(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1");
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => normalize(inlineMd(c)));
}

/** Markdown（GitHub の README・docs、MDX）を塊にする */
export function blocksFromMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  let heading: string | undefined;
  const ctx = (extra?: string) => [heading, extra].filter(Boolean).join(" — ") || undefined;
  const push = (kind: BlockKind, raw: string, context?: string) => {
    const text = normalize(kind === "code" ? raw : inlineMd(raw));
    if (!text) return;
    const b: Block = { kind, text };
    if (context) b.context = context;
    out.push(b);
  };

  // フロントマター：日付の項目だけをメタデータにする
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = l.match(/^([A-Za-z_]+)\s*:\s*(.+)$/);
        if (m && META_KEYS.test(m[1] ?? "")) push("meta", `${m[1]}: ${m[2]!.trim()}`);
      }
      i = end + 1;
    }
  }

  let para: string[] = [];
  const flush = () => {
    if (para.length) push("prose", para.join(" "), heading);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      flush();
      const fence = t.slice(0, 3);
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence)) body.push(lines[i++] ?? "");
      i++;
      push("code", body.join("\n"));
      continue;
    }
    if (t === "") {
      flush();
      i++;
      continue;
    }
    const h = t.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      heading = normalize(inlineMd(h[1] ?? "")) || heading;
      push("heading", h[1] ?? "");
      i++;
      continue;
    }
    if (t.startsWith("|") && /^\|?\s*:?-{2,}/.test((lines[i + 1] ?? "").trim())) {
      flush();
      const header = cells(t).join(" | ");
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        push("row", cells(lines[i] ?? "").join(" | "), ctx(header));
        i++;
      }
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const indent = (li[1] ?? "").length;
      const body = [li[3] ?? ""];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.trim() === "" || /^(\s*)([-*+]|\d+[.)])\s+/.test(next) || /^#{1,6}\s/.test(next.trim())) break;
        if ((next.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
        body.push(next.trim());
        i++;
      }
      push("item", body.join(" "), heading);
      continue;
    }
    if (/^<\/?[a-z][^>]*>$/i.test(t)) {
      // タグだけの行（<details> など）
      flush();
      i++;
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return out;
}
