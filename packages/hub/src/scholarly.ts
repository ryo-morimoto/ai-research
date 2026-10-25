import type { Block, Source, WorkMeta } from "@ai-research/core";

/**
 * 論文の書誌と抄録（設計 v1.4 D13、§8.2.2）。
 *
 * 外の API の応答は、ここで論文（Work）に直す（Boundary Discipline）。取得の出口（gateway.ts）が呼ぶ。
 * - Europe PMC REST（キー不要）：検索・DOI での引き当て。resultType=core で抄録つき
 * - Crossref REST（キー不要）：検索・DOI での引き当て。抄録は出版社が預けたときだけ（JATS）
 * 同じ入力から同じ塊ができるよう、抄録は Europe PMC を先、なければ Crossref と決めて使う。
 */

export type Work = {
  meta: WorkMeta;
  title: string;
  abstract?: string;
  /** 抄録の出どころ（どちらの API の値か） */
  abstractFrom?: "europepmc" | "crossref";
  /** Europe PMC の識別（DOI がないときの URL に使う） */
  epmc?: { source: string; id: string };
  isOpenAccess?: boolean;
};

export const EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
export const CROSSREF_BASE = "https://api.crossref.org";

/** Crossref の種類のうち、論文・本の章などとして扱うもの（データセットや査読記録は外す） */
const CROSSREF_TYPES = new Set([
  "journal-article",
  "proceedings-article",
  "book-chapter",
  "posted-content",
  "book",
  "monograph",
  "edited-book",
  "reference-book",
  "report",
  "dissertation",
]);

const DOI_RE = /\b(10\.\d{4,9}\/[^\s?#&"'<>]+)/i;

/** URL や文字列に含まれる DOI（小文字にそろえる）。出版社の URL の末尾の飾り（/full、/abstract、.pdf）は外す */
export function doiOf(input: string): string | null {
  let s = input;
  try {
    s = decodeURIComponent(input);
  } catch {
    // そのまま使う
  }
  const m = s.match(DOI_RE);
  if (!m?.[1]) return null;
  let doi = m[1].replace(/[.,;)\]]+$/, "");
  doi = doi.replace(/(\/(full|abstract|abs|pdf|epdf|html|fulltext|summary|references|figures))+$/i, "").replace(/\.pdf$/i, "");
  return doi.toLowerCase();
}

export const workUrl = (w: Work): string =>
  w.meta.doi ? `https://doi.org/${w.meta.doi}` : w.epmc ? `https://europepmc.org/article/${w.epmc.source}/${w.epmc.id}` : "";

/** HTML・JATS のタグを外して、表示される文字にする */
export function stripTags(s: string): string {
  return s
    .replace(/<(jats:)?title>(.*?)<\/(jats:)?title>/gi, "$2: ")
    .replace(/<\/(jats:)?p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

type EpmcResult = {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: { author?: { fullName?: string; lastName?: string; initials?: string }[] };
  pubYear?: string;
  journalInfo?: { journal?: { title?: string } };
  journalTitle?: string;
  bookOrReportDetails?: { publisher?: string };
  abstractText?: string;
  isOpenAccess?: string;
};

export function worksFromEpmc(json: unknown): Work[] {
  const list = (json as { resultList?: { result?: EpmcResult[] } })?.resultList?.result ?? [];
  const out: Work[] = [];
  for (const r of list) {
    const title = stripTags(r.title ?? "").replace(/\.$/, "");
    if (!title) continue;
    const authors =
      r.authorList?.author?.map((a) => a.fullName ?? [a.lastName, a.initials].filter(Boolean).join(" ")).filter(Boolean) ??
      (r.authorString ?? "")
        .replace(/\.$/, "")
        .split(/,\s*/)
        .filter(Boolean);
    const meta: WorkMeta = { authors };
    const year = Number(r.pubYear);
    if (Number.isFinite(year) && year > 0) meta.year = year;
    const venue = r.journalInfo?.journal?.title ?? r.journalTitle ?? r.bookOrReportDetails?.publisher;
    if (venue) meta.venue = venue;
    if (r.doi) meta.doi = r.doi.toLowerCase();
    if (r.pmid) meta.pmid = r.pmid;
    if (r.pmcid) meta.pmcid = r.pmcid;
    const w: Work = { meta, title };
    if (r.id && r.source) w.epmc = { source: r.source, id: r.id };
    const abs = stripTags(r.abstractText ?? "");
    if (abs) {
      w.abstract = abs;
      w.abstractFrom = "europepmc";
    }
    if (r.isOpenAccess === "Y") w.isOpenAccess = true;
    out.push(w);
  }
  return out;
}

type CrossrefItem = {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { "date-parts"?: (number | null)[][] };
  "container-title"?: string[];
  abstract?: string;
  type?: string;
};

export function worksFromCrossref(json: unknown): Work[] {
  const msg = (json as { message?: { items?: CrossrefItem[] } & CrossrefItem })?.message;
  const items: CrossrefItem[] = msg?.items ?? (msg?.DOI ? [msg] : []);
  const out: Work[] = [];
  for (const it of items) {
    if (it.type && !CROSSREF_TYPES.has(it.type)) continue;
    const title = stripTags(it.title?.[0] ?? "");
    if (!title || !it.DOI) continue;
    const authors = (it.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
    const meta: WorkMeta = { authors, doi: it.DOI.toLowerCase() };
    const year = it.issued?.["date-parts"]?.[0]?.[0];
    if (typeof year === "number") meta.year = year;
    if (it["container-title"]?.[0]) meta.venue = it["container-title"][0];
    const w: Work = { meta, title };
    const abs = stripTags(it.abstract ?? "").replace(/^(Abstract|ABSTRACT):?\s*/, "");
    if (abs) {
      w.abstract = abs;
      w.abstractFrom = "crossref";
    }
    out.push(w);
  }
  return out;
}

/** DOI で1つにまとめる。抄録は Europe PMC を先に使う。抄録のあるものを前に並べる（並びは安定） */
export function mergeWorks(epmc: Work[], crossref: Work[]): Work[] {
  const byKey = new Map<string, Work>();
  const order: string[] = [];
  const keyOf = (w: Work) => w.meta.doi ?? (w.epmc ? `${w.epmc.source}:${w.epmc.id}` : w.title.toLowerCase());
  for (const w of [...epmc, ...crossref]) {
    const k = keyOf(w);
    const have = byKey.get(k);
    if (!have) {
      byKey.set(k, { ...w, meta: { ...w.meta } });
      order.push(k);
      continue;
    }
    if (!have.abstract && w.abstract) {
      have.abstract = w.abstract;
      have.abstractFrom = w.abstractFrom!;
    }
    if (!have.meta.venue && w.meta.venue) have.meta.venue = w.meta.venue;
    if (have.meta.year === undefined && w.meta.year !== undefined) have.meta.year = w.meta.year;
    if (have.meta.authors.length === 0) have.meta.authors = w.meta.authors;
  }
  const all = order.map((k) => byKey.get(k)!);
  return [...all.filter((w) => w.abstract), ...all.filter((w) => !w.abstract)];
}

/** 書誌の1行（照合の対象。API の値をそのまま並べる） */
export function citationLine(w: Work): string {
  const m = w.meta;
  const authors = m.authors.length > 6 ? `${m.authors.slice(0, 6).join(", ")}, et al.` : m.authors.join(", ");
  const end = (x: string) => (/[.?!。]$/.test(x) ? x : `${x}.`);
  const parts = [authors && `${authors}${m.year ? ` (${m.year})` : ""}.`, end(w.title), m.venue && end(m.venue), m.doi && `doi:${m.doi}`];
  return parts.filter(Boolean).join(" ");
}

/** 抄録を、文の切れ目で 500 字までの塊に分ける（文の途中で切らない） */
export function abstractBlocks(abs: string, maxChars = 500): Block[] {
  const out: Block[] = [];
  for (const para of abs.split(/\n\s*\n+/)) {
    const sentences = para.split(/(?<=[.!?。])\s+(?=[A-Z0-9"“(\p{Script=Han}\p{Script=Katakana}])/u).map((s) => s.trim()).filter(Boolean);
    let cur = "";
    for (const s of sentences) {
      if (cur && (cur + " " + s).length > maxChars) {
        out.push({ kind: "prose", text: cur, context: "Abstract" });
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push({ kind: "prose", text: cur, context: "Abstract" });
  }
  return out;
}

/** 書誌の1行の順位の重み（抄録・本文より下） */
export const BIB_WEIGHT = 0.4;

/** 論文の出典と塊 */
export function workSource(w: Work): { source: Source; blocks: Block[] } {
  const url = workUrl(w);
  const source: Source = {
    kind: "work",
    url,
    title: w.title,
    locator: w.meta.doi ? `doi:${w.meta.doi}` : w.epmc ? `${w.epmc.source}:${w.epmc.id}` : url,
    work: w.meta,
  };
  // 書誌は出典の work にも構造で入っているので、段落としては内容（抄録）より下に並べる
  const blocks: Block[] = [{ kind: "meta", text: citationLine(w), context: "書誌", weight: BIB_WEIGHT }];
  if (w.abstract) {
    blocks.push({ kind: "heading", text: "Abstract" });
    blocks.push(...abstractBlocks(w.abstract));
  }
  return { source, blocks };
}

export const epmcSearchUrl = (query: string, pageSize: number) =>
  `${EPMC_BASE}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=${pageSize}`;
export const crossrefSearchUrl = (query: string, rows: number) =>
  `${CROSSREF_BASE}/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,issued,container-title,abstract,type`;
export const crossrefWorkUrl = (doi: string) => `${CROSSREF_BASE}/works/${doi.split("/").map(encodeURIComponent).join("/")}`;
