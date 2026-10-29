import { attachLeadIns, blocksFromMarkdown, blocksFromPlainText, docText, markReferences, textHash, type Block, type Fingerprint, type Source } from "@ai-research/core";
import { POLICY, isForbidden, isExcluded, isPreferred } from "@ai-research/policy";
import type { Cutoff } from "@ai-research/sandbox-api";
import type { Env } from "./env.ts";
import { withLease, LeaseTimeout, cooldownHost } from "./limiter.ts";
import { parseRobots, isAllowed, type RobotsRules } from "./robots.ts";
import { extractHtml, metaRefreshTarget } from "./extract.ts";
import { deadlines, timeScale } from "./time.ts";
import { pdfBlocks } from "./pdf.ts";
import {
  applyEnrichment,
  enrichFromOpenAlex,
  enrichFromSemanticScholar,
  enrichFromUnpaywall,
  openAlexWorkUrl,
  semanticScholarUrl,
  unpaywallUrl,
  type Enrichment,
  crossrefSearchUrl,
  crossrefWorkUrl,
  doiOf,
  epmcSearchUrl,
  mergeWorks,
  worksFromCrossref,
  worksFromEpmc,
  workSource,
  type Work,
} from "./scholarly.ts";

/**
 * 取得の出口（docs/02 §2.1、docs/03 §2.6）。外への取得はすべてここを通る（INV-12）。
 * - 取得先ごとの頻度制限（HostLimiterDO）、robots.txt、禁止・除外の方針
 * - 取得1件ごとの時間上限（P-02）。同じ実行の中で失敗した URL は再取得しない（INV-14）
 * - 要約を挟まない取得経路（S-03）：GitHub は raw、arXiv は HTML、Web は本文抽出
 */
/** 取得した原文。blocks が型つきの塊（設計 v1.3 D10）、text はその全文（照合と照らし直しに使う） */
/** related：この出典の本文が別の URL にあるときの候補（論文の公開の版。設計 v1.5 §8.3.4） */
export type Doc = { source: Source; blocks: Block[]; text: string; fingerprint: Fingerprint; related?: string[]; partial?: boolean };

const isMarkdownPath = (p: string) => /\.(md|mdx|markdown)$/i.test(p);

/** 原文の形から塊を作る（取得経路によらず1か所で決める） */
function toBlocks(body: string, format: "html" | "markdown" | "plain", url: string): { title: string | null; blocks: Block[] } {
  if (format === "html") return extractHtml(body, url);
  if (format === "markdown") return { title: null, blocks: blocksFromMarkdown(body) };
  return { title: null, blocks: blocksFromPlainText(body) };
}

async function makeDoc(source: Source, raw: Block[], fp: Omit<Fingerprint, "textHash"> = {}): Promise<Doc> {
  // 参考文献の塊は段落の候補にしない（設計 v1.4 §8.2.3）。どの取得経路でもここを通る
  // 導入の文は続く箇条の context にする（§8.2.5）
  const blocks = attachLeadIns(markReferences(raw));
  const text = docText(blocks);
  return { source, blocks, text, fingerprint: { ...fp, textHash: await textHash(text) } };
}

/** fallbackFrom：ページが取れず、DOI から書誌と抄録に取り直したときの、ページの打ち切り（設計 v1.4 §8.2.2） */
export type FetchResult =
  | { ok: true; doc: Doc; fallbackFrom?: Cutoff }
  | { ok: true; notModified: true; fingerprint: Fingerprint }
  | { ok: false; cutoff: Cutoff };

export type SearchHit = { url: string; title: string; snippet: string };

const MAX_BODY_CHARS = 2_000_000;

type Classified =
  | { kind: "github"; owner: string; repo: string; ref: string; path: string; url: string }
  | { kind: "arxiv"; id: string; version: string | null; url: string }
  | { kind: "work"; doi?: string; epmc?: { source: string; id: string }; url: string }
  | { kind: "web"; url: string };

export function classifyUrl(input: string): Classified {
  const u = new URL(input);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com" && parts.length >= 2) {
    const [owner, repo, kind, ref, ...rest] = parts;
    if (kind === "blob" && ref && rest.length > 0) {
      return { kind: "github", owner: owner!, repo: repo!, ref, path: rest.join("/"), url: input };
    }
    if (parts.length === 2) return { kind: "github", owner: owner!, repo: repo!, ref: "HEAD", path: "README.md", url: input };
  }
  if (host === "raw.githubusercontent.com" && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    return { kind: "github", owner: owner!, repo: repo!, ref: ref!, path: rest.join("/"), url: input };
  }
  // 論文の URL（https://doi.org/<DOI>、Europe PMC の記事）は書誌と抄録の API で読む（設計 v1.4 §8.2.2）
  if (host === "doi.org" || host === "dx.doi.org") {
    const doi = doiOf(u.pathname.slice(1));
    if (doi) return { kind: "work", doi, url: input };
  }
  // PubMed の記事のページは、書誌と抄録の API（Europe PMC）で読む（ページは自動の取得に本文を返さないことがある。設計 v1.5 §8.3.4）
  if (host === "pubmed.ncbi.nlm.nih.gov" && /^\d{1,9}$/.test(parts[0] ?? "")) {
    return { kind: "work", epmc: { source: "MED", id: parts[0]! }, url: input };
  }
  if (host === "europepmc.org" && parts[0] === "article" && parts.length >= 3) {
    return { kind: "work", epmc: { source: parts[1]!, id: parts[2]! }, url: input };
  }
  if (host === "arxiv.org" || host === "www.arxiv.org") {
    const m = u.pathname.match(/\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/);
    if (m) return { kind: "arxiv", id: m[1]!, version: m[2] ?? null, url: input };
  }
  return { kind: "web", url: input };
}

type GatewayOpts = { signal?: AbortSignal; timeoutMs?: number; leaseWaitMs?: number };

export class Gateway {
  constructor(
    private env: Env,
    private opts: GatewayOpts = {},
    /** 同じ実行の中で失敗した URL（INV-14）。withSignal で作った出口とも共有する */
    readonly failed = new Set<string>(),
    private robots = new Map<string, RobotsRules | null>(),
    /** 同じ実行の中で同じ論文を同時に引いたら、1回の取得を分け合う（照らし直しと取得が重なる） */
    private works = new Map<string, Promise<FetchResult>>(),
  ) {}

  /** 同じ実行の出口を、作業ごとの中止の合図つきで使う（方向を変えたら古い作業の取得を止める） */
  withSignal(signal: AbortSignal): Gateway {
    return new Gateway(this.env, { ...this.opts, signal }, this.failed, this.robots, this.works);
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? deadlines(this.env).fetchMs;
  }

  /**
   * 外への1回の取得。頻度制限・時間上限つき。
   * 429・503 なら取得先を冷却し（全体で間を空ける）、冷却が取得1件の締め切りに収まるときだけ1回取り直す（設計 v1.5 §8.3.5）
   */
  private async raw(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).hostname;
    const r = await this.rawOnce(url, init);
    if (!(POLICY.backoff.statuses as readonly number[]).includes(r.status) || this.env.TEST_NO_BACKOFF) return r;
    const c = await cooldownHost(this.env, host, r.headers.get("retry-after"));
    if (c.ms > deadlines(this.env).fetchMs || this.opts.signal?.aborted) return r;
    return this.rawOnce(url, init);
  }

  private async rawOnce(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).hostname;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (this.opts.signal?.aborted) controller.abort();
    this.opts.signal?.addEventListener("abort", onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await withLease(
        this.env,
        host,
        async () => {
          // 取得の時間上限は、順番が来て要求を出してから数える
          timer = setTimeout(() => controller.abort(), this.timeoutMs * timeScale(this.env));
          const headers = new Headers(init.headers);
          if (!headers.has("User-Agent")) headers.set("User-Agent", POLICY.userAgent);
          const req: RequestInit = { ...init, headers, signal: controller.signal, redirect: "follow" };
          const res = await (this.env.TEST_UPSTREAM ? this.env.TEST_UPSTREAM.fetch(url, req) : fetch(url, req));
          // 本文の読み取りも上限に含めるため、ここで読み切る
          const body = await res.arrayBuffer();
          return new Response(res.status === 304 || res.status === 204 ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
        },
        { waitLimitMs: this.opts.leaseWaitMs ?? deadlines(this.env).leaseWaitMs, signal: controller.signal },
      );
    } finally {
      if (timer) clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  private policyCutoff(url: string): Cutoff | null {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return { what: url, why: "error", detail: "URL として読めない" };
    }
    if (isForbidden(host)) return { what: url, why: "policy", detail: "自動取得を禁じる取得先" };
    if (isExcluded(host)) return { what: url, why: "policy", detail: "常設の方針で除外した取得先" };
    return null;
  }

  private async robotsAllow(url: string): Promise<boolean> {
    const u = new URL(url);
    const origin = u.origin;
    if (!this.robots.has(origin)) {
      let rules: RobotsRules | null = null;
      try {
        const r = await this.raw(`${origin}/robots.txt`);
        if (r.ok) rules = parseRobots(await r.text());
      } catch {
        rules = null;
      }
      this.robots.set(origin, rules);
    }
    const rules = this.robots.get(origin);
    return rules ? isAllowed(rules, u.pathname + u.search) : true;
  }

  private fail(url: string, cutoff: Cutoff): FetchResult {
    this.failed.add(url);
    return { ok: false, cutoff };
  }

  private errorCutoff(url: string, e: unknown): Cutoff {
    if (e instanceof LeaseTimeout && e.cooldownUntil)
      return { what: url, why: "blocked", detail: `取得先が間を空けるよう求めている（${new Date(e.cooldownUntil).toISOString()} まで）` };
    if (e instanceof LeaseTimeout) return { what: url, why: "timeout", detail: "頻度制限の順番待ちが時間上限を超えた" };
    const name = (e as { name?: string })?.name;
    if (name === "AbortError" || /abort/i.test(String(e))) return { what: url, why: "timeout" };
    return { what: url, why: "error", detail: String(e).slice(0, 200) };
  }

  /** 出典を取得する。conditional を渡すと条件付きで取得し、変わっていなければ notModified */
  /** forCheck：照らし直し・照合のための取り直し（論文の公開の版は探さない。抄録は同じ規則で補う） */
  async fetchDoc(url: string, conditional?: Fingerprint, opts: { forCheck?: boolean } = {}): Promise<FetchResult> {
    if (this.failed.has(url)) return { ok: false, cutoff: { what: url, why: "error", detail: "同じ実行の中で失敗済み" } };
    const pc = this.policyCutoff(url);
    if (pc) return this.fail(url, pc);
    const c = classifyUrl(url);
    try {
      if (c.kind === "github") return await this.fetchGithub(c);
      if (c.kind === "arxiv") return await this.fetchArxiv(c);
      if (c.kind === "work") {
        // 同じ論文を同時に引いたら1回の取得を分け合う。照らし直しは、ふつうの取得（公開の版も探したもの）があればそれを使う
        const id = c.doi ?? c.epmc?.id;
        const full = this.works.get(`${id}:full`);
        const key = `${id}:${opts.forCheck ? "check" : "full"}`;
        let p = opts.forCheck && full ? full : this.works.get(key);
        if (!p) {
          p = this.fetchWork(c, !opts.forCheck);
          this.works.set(key, p);
          // 中止・失敗した取得は分け合わない（次の作業で取り直せるように）
          void p.then((r) => {
            if (!r.ok || this.opts.signal?.aborted) this.works.delete(key);
          });
        }
        return await p;
      }
      const r = await this.fetchWeb(c.url, conditional);
      // 出版社のページが取れなくても、URL に DOI があれば書誌と抄録に取り直す（設計 v1.4 §8.2.2）
      const doi = !r.ok && r.cutoff.why !== "policy" ? doiOf(new URL(url).pathname) : null;
      if (!r.ok && doi) {
        const w = await this.fetchWork({ kind: "work", doi, url: `https://doi.org/${doi}` });
        if (w.ok && "doc" in w) return { ok: true, doc: w.doc, fallbackFrom: r.cutoff };
      }
      return r;
    } catch (e) {
      return this.fail(url, this.errorCutoff(url, e));
    }
  }

  /** PDF の文字を塊にする。大きさ・ページ数・時間に上限（POLICY.pdf） */
  private async pdfDoc(url: string, bytes: Uint8Array): Promise<{ ok: true; blocks: Block[] } | { ok: false; cutoff: Cutoff }> {
    const P = POLICY.pdf;
    if (bytes.byteLength > P.maxBytes) return { ok: false, cutoff: { what: url, why: "unsupported", detail: `PDF が大きすぎる（${Math.round(bytes.byteLength / 1e6)}MB。上限 ${P.maxBytes / 1e6}MB）` } };
    try {
      // 読み取りの時間は CPU の仕事なので、試験の時間の縮め（TEST_TIME_SCALE）を当てない
      const r = await pdfBlocks(bytes, { maxPages: P.maxPages, timeoutMs: P.timeoutMs });
      if (r.blocks.length === 0) return { ok: false, cutoff: { what: url, why: "unsupported", detail: "PDF に文字がない（画像だけの PDF など）" } };
      if (r.truncated) r.blocks.push({ kind: "meta", text: `PDF の ${r.pages} ページのうち、最初の ${r.readPages} ページだけを読んだ`, context: "取得の注記" });
      return { ok: true, blocks: r.blocks };
    } catch (e) {
      return { ok: false, cutoff: { what: url, why: "unsupported", detail: `PDF を読めない（${String((e as Error)?.message ?? e).slice(0, 120)}）` } };
    }
  }

  /**
   * 論文の抄録と公開の版を補う（設計 v1.5 §8.3.4）。抄録がなければ OpenAlex（キーがあれば）→ Semantic Scholar。
   * 公開の版は、oa が真のときだけ Unpaywall（連絡先があれば）・OpenAlex・Semantic Scholar から集める
   */
  async enrich(w: Work, opts: { oa: boolean }): Promise<Work> {
    const doi = w.meta.doi;
    if (!doi) return w;
    const needAbstract = !w.abstract;
    const none: Enrichment = { oaUrls: [] };
    const [oa, up] = await Promise.all([
      this.env.OPENALEX_API_KEY && (needAbstract || opts.oa)
        ? this.json(openAlexWorkUrl(doi, this.env.OPENALEX_API_KEY)).then((j) => (j ? enrichFromOpenAlex(j) : none))
        : Promise.resolve(none),
      opts.oa && this.env.CONTACT_EMAIL ? this.json(unpaywallUrl(doi, this.env.CONTACT_EMAIL)).then((j) => (j ? enrichFromUnpaywall(j) : none)) : Promise.resolve(none),
    ]);
    // Semantic Scholar はキーなしの共有の上限なので、ほかで足りなかったときだけ
    let s2 = none;
    const still = needAbstract && !oa.abstract;
    const noOa = opts.oa && !(w.oaUrls?.length || up.oaUrls.length || oa.oaUrls.length);
    if (still || noOa) {
      const j = await this.json(semanticScholarUrl(doi));
      if (j) s2 = enrichFromSemanticScholar(j);
    }
    // 並びは決まった順（同じ入力から同じ塊にする。設計 v1.5 §8.3.4）。
    // 抄録：OpenAlex → Semantic Scholar。公開の版：論文がもともと持つ候補（PMC・Europe PMC）→ Unpaywall → OpenAlex → Semantic Scholar
    const abstracts: Enrichment[] = [
      { oaUrls: [], ...(oa.abstract ? { abstract: oa.abstract, abstractFrom: oa.abstractFrom } : {}) },
      { oaUrls: [], ...(s2.abstract ? { abstract: s2.abstract, abstractFrom: s2.abstractFrom } : {}) },
    ];
    return applyEnrichment(w, [...abstracts, { oaUrls: up.oaUrls }, { oaUrls: oa.oaUrls }, { oaUrls: s2.oaUrls }]);
  }

  /** JSON の API を引く。応答が得られなければ undefined（取得の失敗）、得られて中身がなければ null（見つからない） */
  private async json(url: string): Promise<unknown | null | undefined> {
    let r: Response;
    try {
      r = await this.raw(url, { headers: { Accept: "application/json" } });
    } catch {
      return undefined;
    }
    if (r.status === 404 || r.status === 410) return null;
    if (!r.ok) return undefined;
    try {
      return await r.json();
    } catch {
      return undefined;
    }
  }

  /** 論文を DOI か Europe PMC の識別で引く。Europe PMC と Crossref を並べて引き、1つにまとめる */
  private async fetchWork(c: Extract<Classified, { kind: "work" }>, oa = true): Promise<FetchResult> {
    const q = c.doi ? `DOI:"${c.doi}"` : `EXT_ID:${c.epmc!.id} AND SRC:${c.epmc!.source}`;
    const [ej, cj] = await Promise.all([
      this.json(epmcSearchUrl(q, 1)),
      c.doi ? this.json(crossrefWorkUrl(c.doi, this.env.CONTACT_EMAIL)) : Promise.resolve(null),
    ]);
    const match = (w: Work) => (c.doi ? w.meta.doi === c.doi : w.epmc?.id === c.epmc!.id);
    const works = mergeWorks(worksFromEpmc(ej).filter(match), worksFromCrossref(cj).filter(match));
    const w = works[0];
    if (!w) {
      // 応答が得られなかった（頻度制限・時間切れ）なら error、得られて載っていないなら not_found（DataCite の DOI など）
      const failed = ej === undefined || (c.doi !== undefined && cj === undefined);
      return this.fail(
        c.url,
        failed
          ? { what: c.url, why: "error", detail: "書誌の API（Europe PMC、Crossref）から応答が得られなかった" }
          : { what: c.url, why: "not_found", detail: "Europe PMC にも Crossref にも書誌がない（DataCite などの DOI かもしれない）" },
      );
    }
    // DOI で引いた論文は、抄録と公開の版を補う（設計 v1.5 §8.3.4）
    const { work: enriched, partial } = await this.enrichWithin(w, { oa });
    const doc = await this.workDoc(enriched);
    if (partial) doc.partial = true;
    return { ok: true, doc };
  }

  /**
   * 補うのに時間の上限を付ける。間に合わなければ、補わずに返す（締め切りを守る）。
   * partial：補いきれなかった（抄録がほかの API にあるかもしれない）。照らし直しでは「変わった」と決めつけない
   */
  async enrichWithin(w: Work, opts: { oa: boolean }): Promise<{ work: Work; partial: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), POLICY.scholarly.enrichTimeoutMs * timeScale(this.env));
    });
    try {
      const r = await Promise.race([this.enrich(w, opts), late]);
      if (!r) return { work: w, partial: !w.abstract };
      // 決めた経路をすべて試して抄録がなかった印（時間切れのときは付けない。設計 v1.6 §8.4.3）
      if (!r.abstract && r.meta.doi) return { work: { ...r, meta: { ...r.meta, abstract: false } }, partial: false };
      return { work: r, partial: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async workDoc(w: Work): Promise<Doc> {
    const { source, blocks } = workSource(w);
    const doc = await makeDoc(source, blocks);
    if (w.oaUrls?.length) doc.related = w.oaUrls.slice(0, POLICY.scholarly.relatedMax);
    return doc;
  }

  /**
   * 論文の検索（設計 v1.4 §8.2.2）。Europe PMC と Crossref を並べて引き、DOI で1つにまとめる。
   * 片方が失敗しても、もう片方の結果を返す。両方失敗したときだけ打ち切り
   */
  async searchScholarly(query: string, n: number): Promise<{ ok: true; works: Work[] } | { ok: false; cutoff: Cutoff }> {
    const [ej, cj] = await Promise.all([
      this.json(epmcSearchUrl(query, n)).catch(() => null),
      this.json(crossrefSearchUrl(query, n, this.env.CONTACT_EMAIL)).catch(() => null),
    ]);
    if (ej === null && cj === null) return { ok: false, cutoff: { what: `論文の検索: ${query}`, why: "error", detail: "Europe PMC と Crossref の両方に届かない" } };
    return { ok: true, works: mergeWorks(worksFromEpmc(ej), worksFromCrossref(cj)) };
  }

  private githubHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (this.env.GITHUB_TOKEN) h.Authorization = `Bearer ${this.env.GITHUB_TOKEN}`;
    return h;
  }

  /** パスの最新コミット SHA（照らし直しの指紋） */
  async githubLatestCommit(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    const api = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`;
    const r = await this.raw(api, { headers: this.githubHeaders() });
    if (!r.ok) return null;
    const j = (await r.json()) as { sha?: string }[];
    return j[0]?.sha ?? null;
  }

  private async fetchGithub(c: Extract<Classified, { kind: "github" }>): Promise<FetchResult> {
    const sha = (await this.githubLatestCommit(c.owner, c.repo, c.path, c.ref).catch(() => null)) ?? null;
    const rawUrl = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${sha ?? c.ref}/${c.path}`;
    const r = await this.raw(rawUrl);
    if (!r.ok) return this.fail(c.url, { what: c.url, why: r.status === 404 ? "not_found" : "blocked", detail: `HTTP ${r.status}` });
    const body = (await r.text()).slice(0, MAX_BODY_CHARS);
    const { blocks } = toBlocks(body, isMarkdownPath(c.path) ? "markdown" : "plain", rawUrl);
    const source: Source = { kind: "github", url: c.url, title: `${c.owner}/${c.repo}/${c.path}`, locator: `${c.owner}/${c.repo}@${sha ?? c.ref}:${c.path}` };
    return { ok: true, doc: await makeDoc(source, blocks, sha ? { commit: sha } : {}) };
  }

  /** arXiv の最新の版番号（照らし直しの指紋） */
  async arxivLatestVersion(id: string): Promise<string | null> {
    const r = await this.raw(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const xml = await r.text();
    const m = [...xml.matchAll(/<id>https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(v\d+)<\/id>/g)];
    const last = m.find((x) => x[1] === id);
    return last?.[2] ?? null;
  }

  private async fetchArxiv(c: Extract<Classified, { kind: "arxiv" }>): Promise<FetchResult> {
    const version = c.version ?? (await this.arxivLatestVersion(c.id).catch(() => null));
    const htmlUrl = `https://arxiv.org/html/${c.id}${version ?? ""}`;
    if (!(await this.robotsAllow(htmlUrl))) return this.fail(c.url, { what: c.url, why: "robots" });
    const r = await this.raw(htmlUrl);
    if (r.status === 429 || r.status === 503 || r.status === 403) {
      return this.fail(c.url, { what: c.url, why: "blocked", detail: `HTTP ${r.status}` });
    }
    if (!r.ok) {
      // HTML 版がなければ（404 など）PDF を読む（設計 v1.5 §8.3.4）。PDF にも robots.txt を当てる
      const pdfUrl = `https://arxiv.org/pdf/${c.id}${version ?? ""}`;
      if (!(await this.robotsAllow(pdfUrl))) return this.fail(c.url, { what: c.url, why: "robots" });
      const p = await this.raw(pdfUrl);
      if (!p.ok) return this.fail(c.url, { what: c.url, why: "unsupported", detail: `HTML 版も PDF もない（HTTP ${r.status}・${p.status}）` });
      const pdf = await this.pdfDoc(c.url, new Uint8Array(await p.arrayBuffer()));
      if (!pdf.ok) return this.fail(c.url, pdf.cutoff);
      const source: Source = { kind: "arxiv", url: `https://arxiv.org/abs/${c.id}`, locator: `arXiv:${c.id}${version ?? ""}` };
      return { ok: true, doc: await makeDoc(source, pdf.blocks, version ? { arxivVersion: version } : {}) };
    }
    const html = (await r.text()).slice(0, MAX_BODY_CHARS);
    const { title, blocks } = toBlocks(html, "html", htmlUrl);
    const source: Source = { kind: "arxiv", url: `https://arxiv.org/abs/${c.id}`, locator: `arXiv:${c.id}${version ?? ""}` };
    if (title) source.title = title;
    return { ok: true, doc: await makeDoc(source, blocks, version ? { arxivVersion: version } : {}) };
  }

  private async fetchWeb(url: string, conditional?: Fingerprint, hops = 0): Promise<FetchResult> {
    if (!(await this.robotsAllow(url))) return this.fail(url, { what: url, why: "robots" });
    const headers: Record<string, string> = {};
    if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
    if (conditional?.lastModified) headers["If-Modified-Since"] = conditional.lastModified;
    const r = await this.raw(url, { headers });
    if (r.status === 304 && conditional) return { ok: true, notModified: true, fingerprint: conditional };
    if (r.status === 401 || r.status === 403 || r.status === 429 || r.status === 503) {
      const ra = r.headers.get("retry-after");
      return this.fail(url, { what: url, why: "blocked", detail: `HTTP ${r.status}${ra ? `（取得先が ${ra} 後の再開を求めた。ハブは間を空ける）` : ""}` });
    }
    if (r.status === 404 || r.status === 410) return this.fail(url, { what: url, why: "not_found", detail: `HTTP ${r.status}` });
    if (!r.ok) return this.fail(url, { what: url, why: "error", detail: `HTTP ${r.status}` });
    const ct = r.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await r.arrayBuffer());
    const fp0: Omit<Fingerprint, "textHash"> = {};
    if (r.headers.get("etag")) fp0.etag = r.headers.get("etag")!;
    if (r.headers.get("last-modified")) fp0.lastModified = r.headers.get("last-modified")!;
    // PDF（設計 v1.5 §8.3.4）：content-type か、先頭の %PDF で見分ける
    if (/pdf/i.test(ct) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      const pdf = await this.pdfDoc(url, bytes);
      if (!pdf.ok) return this.fail(url, pdf.cutoff);
      return { ok: true, doc: await makeDoc({ kind: "web", url, locator: url }, pdf.blocks, fp0) };
    }
    const body = new TextDecoder().decode(bytes).slice(0, MAX_BODY_CHARS);
    const isHtml = /html/i.test(ct) || /^\s*<(!doctype|html)/i.test(body);
    if (isHtml && hops === 0) {
      // <meta http-equiv="refresh"> の転送（例：…/releases/latest/）は1回だけ追う。転送先にも方針と robots を当てる
      const to = metaRefreshTarget(body, url);
      if (to && to !== url) {
        const pc = this.policyCutoff(to);
        if (pc) return this.fail(url, pc);
        return this.fetchWeb(to, undefined, 1);
      }
    }
    const format = isHtml ? "html" : /markdown/i.test(ct) || isMarkdownPath(new URL(url).pathname) ? "markdown" : "plain";
    const { title, blocks } = toBlocks(body, format, url);
    const fp: Omit<Fingerprint, "textHash"> = {};
    const etag = r.headers.get("etag");
    const lm = r.headers.get("last-modified");
    if (etag) fp.etag = etag;
    if (lm) fp.lastModified = lm;
    const source: Source = { kind: "web", url, locator: url };
    if (title) source.title = title;
    return { ok: true, doc: await makeDoc(source, blocks, fp) };
  }

  /** 検索。結果は保存しない。禁止・除外の取得先を外し、一次資料を前に並べる */
  async search(query: string): Promise<{ ok: true; hits: SearchHit[] } | { ok: false; cutoff: Cutoff }> {
    const provider = (this.env.SEARCH_PROVIDER ?? "none").toLowerCase();
    const n = POLICY.search.resultsPerQuery;
    let hits: SearchHit[] = [];
    try {
      if (provider === "brave") {
        if (!this.env.BRAVE_API_KEY) return { ok: false, cutoff: { what: `検索: ${query}`, why: "not_configured", detail: "BRAVE_API_KEY がない" } };
        const r = await this.raw(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
          headers: { Accept: "application/json", "X-Subscription-Token": this.env.BRAVE_API_KEY },
        });
        if (!r.ok) return { ok: false, cutoff: { what: `検索: ${query}`, why: "error", detail: `HTTP ${r.status}` } };
        const j = (await r.json()) as { web?: { results?: { url: string; title: string; description?: string }[] } };
        hits = (j.web?.results ?? []).map((x) => ({ url: x.url, title: x.title, snippet: x.description ?? "" }));
      } else if (provider === "tavily") {
        if (!this.env.TAVILY_API_KEY) return { ok: false, cutoff: { what: `検索: ${query}`, why: "not_configured", detail: "TAVILY_API_KEY がない" } };
        const r = await this.raw("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.env.TAVILY_API_KEY}` },
          body: JSON.stringify({ query, max_results: n }),
        });
        if (!r.ok) return { ok: false, cutoff: { what: `検索: ${query}`, why: "error", detail: `HTTP ${r.status}` } };
        const j = (await r.json()) as { results?: { url: string; title: string; content?: string }[] };
        hits = (j.results ?? []).map((x) => ({ url: x.url, title: x.title, snippet: x.content ?? "" }));
      } else if (provider === "searxng") {
        // 自前ホストの SearXNG（server の ADR-0017）。真正性は Cloudflare Access の service token で確かめる
        if (!this.env.SEARXNG_URL) return { ok: false, cutoff: { what: `検索: ${query}`, why: "not_configured", detail: "SEARXNG_URL がない" } };
        const u = `${this.env.SEARXNG_URL.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.env.SEARXNG_CF_ACCESS_CLIENT_ID && this.env.SEARXNG_CF_ACCESS_CLIENT_SECRET) {
          headers["CF-Access-Client-Id"] = this.env.SEARXNG_CF_ACCESS_CLIENT_ID;
          headers["CF-Access-Client-Secret"] = this.env.SEARXNG_CF_ACCESS_CLIENT_SECRET;
        }
        const r = await this.raw(u, { headers });
        if (!r.ok) return { ok: false, cutoff: { what: `検索: ${query}`, why: "error", detail: `HTTP ${r.status}` } };
        const j = (await r.json()) as { results?: { url: string; title: string; content?: string }[] };
        hits = (j.results ?? []).slice(0, n).map((x) => ({ url: x.url, title: x.title, snippet: x.content ?? "" }));
      } else if (provider === "test") {
        const r = await this.raw(`https://search.test/search?q=${encodeURIComponent(query)}`);
        const j = (await r.json()) as { results?: SearchHit[] };
        hits = j.results ?? [];
      } else {
        return { ok: false, cutoff: { what: `検索: ${query}`, why: "not_configured", detail: "SEARCH_PROVIDER が設定されていない" } };
      }
    } catch (e) {
      return { ok: false, cutoff: this.errorCutoff(`検索: ${query}`, e) };
    }
    return { ok: true, hits: rankHits(hits) };
  }
}

export function rankHits(hits: SearchHit[]): SearchHit[] {
  const kept = hits.filter((h) => {
    try {
      const host = new URL(h.url).hostname;
      return !isForbidden(host) && !isExcluded(host);
    } catch {
      return false;
    }
  });
  const preferred = kept.filter((h) => isPreferred(new URL(h.url).hostname));
  const others = kept.filter((h) => !isPreferred(new URL(h.url).hostname));
  return [...preferred, ...others];
}
