import { attachLeadIns, blocksFromMarkdown, blocksFromPlainText, docText, markReferences, textHash, type Block, type Fingerprint, type Source } from "@ai-research/core";
import { POLICY, isForbidden, isExcluded, isPreferred } from "@ai-research/policy";
import type { Cutoff } from "@ai-research/sandbox-api";
import type { Env } from "./env.ts";
import { withLease, LeaseTimeout } from "./limiter.ts";
import { parseRobots, isAllowed, type RobotsRules } from "./robots.ts";
import { extractHtml, metaRefreshTarget } from "./extract.ts";
import { deadlines, timeScale } from "./time.ts";
import {
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
export type Doc = { source: Source; blocks: Block[]; text: string; fingerprint: Fingerprint };

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
  ) {}

  /** 同じ実行の出口を、作業ごとの中止の合図つきで使う（方向を変えたら古い作業の取得を止める） */
  withSignal(signal: AbortSignal): Gateway {
    return new Gateway(this.env, { ...this.opts, signal }, this.failed, this.robots);
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? deadlines(this.env).fetchMs;
  }

  /** 外への1回の取得。頻度制限・時間上限つき */
  private async raw(url: string, init: RequestInit = {}): Promise<Response> {
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
    if (e instanceof LeaseTimeout) return { what: url, why: "timeout", detail: "頻度制限の順番待ちが時間上限を超えた" };
    const name = (e as { name?: string })?.name;
    if (name === "AbortError" || /abort/i.test(String(e))) return { what: url, why: "timeout" };
    return { what: url, why: "error", detail: String(e).slice(0, 200) };
  }

  /** 出典を取得する。conditional を渡すと条件付きで取得し、変わっていなければ notModified */
  async fetchDoc(url: string, conditional?: Fingerprint): Promise<FetchResult> {
    if (this.failed.has(url)) return { ok: false, cutoff: { what: url, why: "error", detail: "同じ実行の中で失敗済み" } };
    const pc = this.policyCutoff(url);
    if (pc) return this.fail(url, pc);
    const c = classifyUrl(url);
    try {
      if (c.kind === "github") return await this.fetchGithub(c);
      if (c.kind === "arxiv") return await this.fetchArxiv(c);
      if (c.kind === "work") return await this.fetchWork(c);
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

  private async json(url: string): Promise<unknown | null> {
    const r = await this.raw(url, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    try {
      return await r.json();
    } catch {
      return null;
    }
  }

  /** 論文を DOI か Europe PMC の識別で引く。Europe PMC と Crossref を並べて引き、1つにまとめる */
  private async fetchWork(c: Extract<Classified, { kind: "work" }>): Promise<FetchResult> {
    const q = c.doi ? `DOI:"${c.doi}"` : `EXT_ID:${c.epmc!.id} AND SRC:${c.epmc!.source}`;
    const [ej, cj] = await Promise.all([
      this.json(epmcSearchUrl(q, 1)).catch(() => null),
      c.doi ? this.json(crossrefWorkUrl(c.doi)).catch(() => null) : Promise.resolve(null),
    ]);
    const match = (w: Work) => (c.doi ? w.meta.doi === c.doi : w.epmc?.id === c.epmc!.id);
    const works = mergeWorks(worksFromEpmc(ej).filter(match), worksFromCrossref(cj).filter(match));
    const w = works[0];
    if (!w) return this.fail(c.url, { what: c.url, why: "error", detail: "書誌が見つからない（Europe PMC、Crossref）" });
    return { ok: true, doc: await this.workDoc(w) };
  }

  async workDoc(w: Work): Promise<Doc> {
    const { source, blocks } = workSource(w);
    return makeDoc(source, blocks);
  }

  /**
   * 論文の検索（設計 v1.4 §8.2.2）。Europe PMC と Crossref を並べて引き、DOI で1つにまとめる。
   * 片方が失敗しても、もう片方の結果を返す。両方失敗したときだけ打ち切り
   */
  async searchScholarly(query: string, n: number): Promise<{ ok: true; works: Work[] } | { ok: false; cutoff: Cutoff }> {
    const [ej, cj] = await Promise.all([
      this.json(epmcSearchUrl(query, n)).catch(() => null),
      this.json(crossrefSearchUrl(query, n)).catch(() => null),
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
    if (!r.ok) return this.fail(c.url, { what: c.url, why: r.status === 404 ? "error" : "blocked", detail: `HTTP ${r.status}` });
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
    if (!r.ok) return this.fail(c.url, { what: c.url, why: "unsupported", detail: `HTML 版がない（HTTP ${r.status}）。PDF は未対応` });
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
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      return this.fail(url, { what: url, why: "blocked", detail: `HTTP ${r.status}` });
    }
    if (!r.ok) return this.fail(url, { what: url, why: "error", detail: `HTTP ${r.status}` });
    const ct = r.headers.get("content-type") ?? "";
    if (/pdf/i.test(ct)) return this.fail(url, { what: url, why: "unsupported", detail: "PDF は未対応" });
    const body = (await r.text()).slice(0, MAX_BODY_CHARS);
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
