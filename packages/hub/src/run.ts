import { DurableObject } from "cloudflare:workers";
import {
  candidateParagraphs,
  coverage,
  queryScripts,
  scriptOf,
  scoreParagraphs,
  clip,
  normalize,
  selectPassages,
  verifyQuote,
  reverifyRecord,
  statusLabel,
  classifyVolatility,
  admit,
  advance,
  estimateJsonTokens,
  planRevalidation,
  judgeRevalidation,
  textHash,
  hostOf,
  type BudgetState,
  type Fingerprint,
  type TraceEvent,
  type TraceEventType,
  type Paragraph,
  type Phase,
  type Source,
} from "@ai-research/core";
import { EMPTY_NEXT, INPUT_BOUNDS, POLICY, VERIFY_NEXT, procedureVersion, tierOf } from "@ai-research/policy";

/**
 * 束に出す出典を軽くする（設計 v1.5 §8.3.7）：URL と同じ locator は省く。著者は POLICY.sourceAuthorsMax 人まで
 */
export function compactSource(s: SourceRef): SourceRef {
  const out: SourceRef = { ...s };
  // 論文の locator（doi:…）と work.doi は URL（https://doi.org/…）と同じ情報。PMID・PMCID は束では使わない
  if (out.locator === out.url || (out.kind === "work" && out.locator?.startsWith("doi:"))) delete (out as { locator?: string }).locator;
  if (out.work) {
    const { authors, year, venue, doi, abstract } = out.work;
    const w: NonNullable<SourceRef["work"]> = {
      authors: authors.length > POLICY.sourceAuthorsMax ? [...authors.slice(0, POLICY.sourceAuthorsMax), "et al."] : authors,
    };
    if (year !== undefined) w.year = year;
    if (venue) w.venue = venue;
    if (doi && !out.url.endsWith(doi)) w.doi = doi;
    if (abstract === false) w.abstract = false;
    out.work = w;
  }
  return out;
}

const QUERY_LANGUAGE_NEXT =
  "問いと検索語に、この出典の言語の語がない（ハブは翻訳しない）。出典の言語の語で queries を渡して steer するか、find で出典の言語の語句を探す。";

const POLICY_FIND_EMPTY = "その出典に、語句に当たる段落がない。別の語句で find するか、cutoffs の no_passage の URL は WebFetch で読める（経路外）。";
import type {
  Mode,
  AroundResult,
  Bundle,
  ClaimInput,
  ClaimStatus,
  Cutoff,
  EmptyReason,
  LedgerHit,
  Notice,
  Passage,
  Pending,
  Progress,
  QuestionInput,
  SourceRef,
  SourceSet,
  VerifyResult,
} from "@ai-research/sandbox-api";
import type { Env } from "./env.ts";
import { Gateway, classifyUrl, type Doc } from "./gateway.ts";
import { workUrl } from "./scholarly.ts";
import { ledgerStub, type LedgerRecord } from "./ledger.ts";
import { routeStub, urlKey } from "./route.ts";
import { deadlines, timeScale } from "./time.ts";
import { timed } from "./obs.ts";
import { presentCutoffs, type CutoffItem, type CutoffOrigin } from "./cutoffs.ts";
import { traceStub } from "./trace.ts";

/**
 * 1つの調査の実行（docs/03 §2.5.1、specs/run.qnt）。1依頼に1つ（idFromName(runId)）。
 *
 * 不変条件：
 *   INV-5  確認済の印は、その回に原文と照合できたものにだけ付く
 *   INV-8  締め切りで終わっていなかった現在の版の作業は、その束の cutoffs に必ず現れる
 *   INV-9  使用量は段階の上限を超えない
 *   INV-10 現在の結果として返すのは、現在の版の作業の結果だけ
 *   INV-11 深掘りでなければ、続きの上限（4分）を過ぎて作業を始めない
 *   INV-13 原文の全文はストレージに書かない（メモリだけ）
 */

/** origin：その出典を何から取ったか（利用者の URL・検索・台帳）。段落が選ばれなかったときの見せ方に使う */
type SourceEntry = { sourceId: string; doc: Doc; v: number; origin?: CutoffOrigin };
type ParaEntry = { passageId: string; sourceId: string; text: string; context?: string; weight?: number; v: number; index: number; delivered: boolean };
type HitEntry = {
  passageId: string;
  v: number;
  record: LedgerRecord;
  /** 照合中は内部だけの状態。束には決着してから出す（設計 v1.5 §8.3.2） */
  status: LedgerHit["status"] | "照合中";
  reason?: string;
  deliveredStatus: LedgerHit["status"] | "照合中" | null;
  /** 照らし直せたときの、照合に使える原文（抜き書きと前後の文脈） */
  verifiedText?: string;
  fingerprint?: Fingerprint;
};
type TaskEntry = {
  id: number;
  v: number;
  label: string;
  origin: CutoffOrigin;
  /** 取得の作業なら、その URL（打ち切りとして見せるときに使う） */
  url?: string;
  done: boolean;
  controller: AbortController;
  deep: boolean;
  startedAt: number;
};
/** 現在の版の進み具合（設計 v1.4 §8.2.4）。searchFailed は0件の理由を決めるためだけに持つ */
type ProgressCounts = Omit<Progress, "running"> & { searchFailed: number };
const zeroProgress = (): ProgressCounts => ({ searched: 0, found: 0, fetched: 0, failed: 0, searchFailed: 0 });
type CutoffEntry = { cutoff: Cutoff; origin: CutoffOrigin; v: number; delivered: boolean };

type Manifest = {
  runId: string;
  procedureVersion: string;
  hubVersion: string;
  ledgerSnapshotSeq: number;
  interpretedQuestionHash: string;
  searchProfile: string;
  egress: "hub";
  createdAt: string;
  client?: string;
};

type Meta = {
  runId: string;
  createdAtMs: number;
  version: number;
  question: string;
  scope?: string;
  exclusions?: string[];
  queries: string[];
  urls: string[];
  mode: Mode;
  /** 1つの束で返す段落の上限（呼んだ側が小さくしたとき。設計 v1.5 §8.3.7） */
  maxPassages?: number;
  /** 探す先（設計 v1.4 §8.2.2）。古い記録にはないので既定は ["web"] */
  sources?: SourceSet[];
  deep: boolean;
  budget: BudgetState;
  done: boolean;
  firstReturned: boolean;
  manifest: Manifest;
  /** 段落のメタデータ（本文は持たない。INV-13） */
  passageMeta: Record<string, { sourceId: string; url: string; locator: string; v: number; index: number }>;
  /** ID の払い出しの続き。退避の後も同じ ID を使い回さないために保存する */
  counters?: { task: number; source: number; passage: number; hit: number; trace?: number };
  progress?: ProgressCounts;
};

type RunEvent = { ev: number; at: number; type: string; [k: string]: unknown };

const MAX_EVENTS = 500;

export class RunDO extends DurableObject<Env> {
  private meta: Meta | null = null;
  private loaded = false;
  private sources = new Map<string, SourceEntry>();
  private paras = new Map<string, ParaEntry>();
  private hits = new Map<string, HitEntry>();
  private tasks = new Map<number, TaskEntry>();
  private cutoffs: CutoffEntry[] = [];
  private fetchedUrls = new Set<string>();
  private waiters: (() => void)[] = [];
  private gateway: Gateway | null = null;
  private counters = { task: 0, source: 0, passage: 0, hit: 0, ev: 0, trace: 0 };
  /** この実行で足した論文の数（POLICY.scholarly.maxWorks まで） */
  private workCount = 0;
  /** 公開の版（本文）を読みに行った論文の数と、抄録・公開の版を補った論文の数（設計 v1.5 §8.3.4） */
  private oaFollowed = 0;
  private enrichCount = 0;
  private events: RunEvent[] = [];
  /** 言語の違いを知らせた出典（`${版}:${sourceId}`）。二度知らせない */
  private langNotified = new Set<string>();
  /** 段落が選ばれなかったと知らせた出典（`${版}:${sourceId}`）。二度知らせない */
  private noPassageReported = new Set<string>();
  /** 版ごとに、束に入れた段落の本文（正規化後）。同じ文を二度届けない */
  private shownTexts = new Map<number, Set<string>>();
  /** 調査の記録（docs/05）。送る前の事象と、送っている最中か。送れなかった数 */
  private traceBuf: Record<string, unknown>[] = [];
  private traceFlushing = false;
  private traceDropped = 0;
  /** 打ち切り（gave_up）として記録した作業。二度記録しない */
  private gaveUpTraced = new Set<number>();

  // ---- 状態の読み書き -------------------------------------------------------

  private async load(): Promise<Meta | null> {
    if (!this.loaded) {
      this.meta = (await timed("run.load.meta", () => this.ctx.storage.get<Meta>("meta"))) ?? null;
      this.events = (await timed("run.load.events", () => this.ctx.storage.get<RunEvent[]>("events"))) ?? [];
      this.counters.ev = this.events.at(-1)?.ev ?? 0;
      if (this.meta?.counters) Object.assign(this.counters, this.meta.counters);
      this.loaded = true;
    }
    return this.meta;
  }

  private async save(): Promise<void> {
    if (this.meta) {
      const { task, source, passage, hit, trace } = this.counters;
      this.meta.counters = { task, source, passage, hit, trace };
      const meta = this.meta;
      await timed("run.save.meta", () => this.ctx.storage.put("meta", meta));
    }
    await timed("run.save.events", () => this.ctx.storage.put("events", this.events.slice(-MAX_EVENTS)));
  }

  private log(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ ev: ++this.counters.ev, at: Date.now(), type, ...data });
  }

  /**
   * 調査の記録に事象を1件積む（docs/05）。送るのは待たない（C-03）。
   * 段落の本文は渡さない（C-04）。TraceDO の側でも整形で落とす。
   * 欄は core/trace.ts の TraceEvent で型を強制する（欄の名前の誤りは整形で黙って落ちるため、ここで防ぐ）
   */
  private trace<T extends TraceEventType>(type: T, data: Omit<Extract<TraceEvent, { type: T }>, "type" | "runId" | "at" | "ev">): void {
    const m = this.meta;
    if (!m) return;
    this.traceBuf.push({ type, runId: m.runId, at: Date.now(), ev: ++this.counters.trace, ...data });
    this.flushTrace();
  }

  private flushTrace(): void {
    if (this.traceFlushing) return;
    this.traceFlushing = true;
    this.ctx.waitUntil(
      (async () => {
        // 同じ同期の区切りで積まれた事象をまとめて送る
        await Promise.resolve();
        try {
          while (this.traceBuf.length) {
            const batch = this.traceBuf.splice(0, POLICY.trace.flushBatch);
            try {
              await traceStub(this.env).append(JSON.stringify(batch));
            } catch (e) {
              this.traceDropped += batch.length;
              console.log(JSON.stringify({ event: "trace_dropped", n: batch.length, total: this.traceDropped, error: String(e).slice(0, 200) }));
            }
          }
        } finally {
          this.traceFlushing = false;
        }
      })(),
    );
  }

  private traceCutoff(v: number, cutoff: Cutoff, origin: CutoffOrigin): void {
    const host = hostOf(cutoff.what);
    // 取れなかった出典の種類（V-04 の tier ごとの数）。URL でなければ付けない
    let where: { kind: string; tier: string } | null = null;
    if (host) {
      try {
        const kind = classifyUrl(cutoff.what).kind;
        where = { kind, tier: tierOf({ kind, url: cutoff.what }) };
      } catch {
        where = null;
      }
    }
    this.trace("cutoff", { v, what: cutoff.what, why: cutoff.why, origin, ...(host ? { host } : {}), ...(where ?? {}), ...(cutoff.detail ? { detail: cutoff.detail } : {}) });
  }

  private gw(): Gateway {
    if (!this.gateway) this.gateway = new Gateway(this.env);
    return this.gateway;
  }

  private notify(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** predicate が真になるか、ms（方針の時間）が過ぎるまで待つ */
  private async waitUntil(predicate: () => boolean, ms: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, ms) * timeScale(this.env);
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** 段階ごとの上限（R-01）。試験では縮められる */
  private caps(): Record<Phase, number> {
    const s = Number(this.env.TEST_CAP_SCALE ?? "1");
    const k = Number.isFinite(s) && s > 0 ? s : 1;
    return { first: Math.floor(POLICY.caps.first * k), continue: Math.floor(POLICY.caps.continue * k), deep: Math.floor(POLICY.caps.deep * k) };
  }

  private elapsedPolicyMs(): number {
    return this.meta ? (Date.now() - this.meta.createdAtMs) / timeScale(this.env) : 0;
  }

  // ---- 作業 -----------------------------------------------------------------

  /** 作業を始める（INV-11：深掘りでなければ4分を過ぎて始めない） */
  private spawn(v: number, label: string, origin: CutoffOrigin, fn: (signal: AbortSignal) => Promise<void>, url?: string): boolean {
    const m = this.meta!;
    if (m.done) return false;
    if (!m.deep && this.elapsedPolicyMs() >= deadlines(this.env).continueUntilMs) return false;
    const id = ++this.counters.task;
    const controller = new AbortController();
    const task: TaskEntry = { id, v, label, origin, done: false, controller, deep: m.deep, startedAt: Date.now() };
    if (url) task.url = url;
    this.tasks.set(id, task);
    this.log("task_start", { id, v, label });
    fn(controller.signal)
      .catch((e) => {
        if (v === this.meta?.version && !controller.signal.aborted) {
          const cutoff: Cutoff = { what: url ?? label, why: "error", detail: String(e).slice(0, 200) };
          this.cutoffs.push({ cutoff: { ...cutoff, what: label }, origin, v, delivered: false });
          this.traceCutoff(v, cutoff, origin);
        }
      })
      .finally(() => {
        task.done = true;
        this.log("task_done", { id, v });
        // 終わりは作業の状態で決める（設計 v1.4 D15）。現在の版の作業が尽きたら、それ以上は届かない
        if (this.current(v) && this.unfinished(v).length === 0) this.finish("idle");
        this.notify();
      });
    return true;
  }

  private prog(): ProgressCounts {
    const m = this.meta!;
    m.progress ??= zeroProgress();
    return m.progress;
  }

  private current(v: number): boolean {
    return this.meta !== null && this.meta.version === v;
  }

  /** 取得した原文を登録する。古い版の作業の結果は混ぜない（INV-10） */
  private addDoc(v: number, doc: Doc, origin?: CutoffOrigin, info: { ms?: number; reused?: boolean } = {}): string | null {
    if (!this.current(v)) return null;
    const sourceId = `s${++this.counters.source}`;
    this.sources.set(sourceId, origin ? { sourceId, doc, v, origin } : { sourceId, doc, v });
    this.prog().fetched++;
    const src = doc.source;
    this.trace("source.fetched", {
      v,
      sourceId,
      url: src.url,
      host: hostOf(src.url) ?? "",
      kind: src.kind,
      tier: tierOf(src),
      origin: origin ?? "system",
      ...(src.title ? { title: src.title } : {}),
      ...(info.ms !== undefined ? { ms: info.ms } : {}),
      ...(info.reused ? { reused: true } : {}),
    });
    for (const p of candidateParagraphs(sourceId, doc.blocks)) {
      const passageId = `p${++this.counters.passage}`;
      const e: ParaEntry = { passageId, sourceId, text: p.text, v, index: p.index, delivered: false };
      if (p.context) e.context = p.context;
      if (p.weight !== undefined) e.weight = p.weight;
      this.paras.set(passageId, e);
      this.meta!.passageMeta[passageId] = { sourceId, url: doc.source.url, locator: doc.source.locator, v, index: p.index };
    }
    this.notify();
    return sourceId;
  }

  private addCutoff(v: number, cutoff: Cutoff, origin: CutoffOrigin): void {
    if (!this.current(v)) return;
    this.cutoffs.push({ cutoff, origin, v, delivered: false });
    this.traceCutoff(v, cutoff, origin);
    this.noteRouteCutoff(cutoff);
    this.notify();
  }

  /** ai-research で取れなかった URL は、組み込みの取得に回してよい（U-03 の例外。理由は policy で絞る） */
  private noteRouteCutoff(cutoff: Cutoff): void {
    if (/^https?:\/\//.test(cutoff.what)) {
      this.ctx.waitUntil(routeStub(this.env).noteCutoff(cutoff.what, cutoff.why).catch(() => {}));
    }
  }

  /**
   * 論文の公開の版（本文）を読む（設計 v1.5 §8.3.4）。候補を順に試し、最初に取れたものを、その論文の書誌つきの出典にする。
   * 1回の調査で読む論文の数は POLICY.scholarly.openAccessPages まで
   */
  private followRelated(v: number, doc: Doc, origin: CutoffOrigin): void {
    const m = this.meta!;
    const cap = POLICY.scholarly.openAccessPages[m.mode];
    const candidates = (doc.related ?? []).filter((u) => !this.fetchedUrls.has(u));
    if (candidates.length === 0 || this.oaFollowed >= cap) return;
    this.oaFollowed++;
    for (const u of candidates) this.fetchedUrls.add(u);
    this.spawn(v, `公開の版: ${doc.source.title ?? doc.source.url}`, origin, async (signal) => {
      const gw = this.gw().withSignal(signal);
      const failures: string[] = [];
      for (const u of candidates) {
        const r = await gw.fetchDoc(u);
        if (!this.current(v)) return;
        if (r.ok && "doc" in r) {
          const d = r.doc;
          d.source = { ...d.source, title: `${doc.source.title ?? ""}（公開の版）`, ...(doc.source.work ? { work: doc.source.work } : {}) };
          this.addDoc(v, d, origin);
          return;
        }
        if (!r.ok) {
          failures.push(`${r.cutoff.why}: ${u}`);
          // 取れなかった公開の版の URL は、経路外で読めるようにする（cutoffs の urls に出る）
          this.noteRouteCutoff(r.cutoff);
        }
      }
      this.prog().failed++;
      this.addCutoff(v, { what: doc.source.url, why: "unsupported", detail: `公開の版を読めなかった（${failures.join("、").slice(0, 200)}）`, urls: candidates }, origin);
    });
  }

  private launch(v: number, opts: { queries: string[]; urls: string[]; question: string; extra?: boolean }): void {
    const m = this.meta!;
    const maxSources = POLICY.search.maxSourcesPerRun * (m.deep ? 2 : 1);

    const mode = POLICY.modes[m.mode];
    const fetchUrl = (url: string, origin: CutoffOrigin) => {
      if (this.fetchedUrls.has(url) || this.fetchedUrls.size >= maxSources) return;
      this.fetchedUrls.add(url);
      this.spawn(
        v,
        `取得: ${url}`,
        origin,
        async (signal) => {
          const t0 = Date.now();
          const r = await this.gw().withSignal(signal).fetchDoc(url);
          if (!this.current(v)) return;
          if (r.ok && "doc" in r) {
            this.addDoc(v, r.doc, origin, { ms: Date.now() - t0 });
            this.followRelated(v, r.doc, origin);
            // ページは取れず、DOI から書誌と抄録に取り直した。ページは経路外で読めるようにする（束の打ち切りには出さない）
            if (r.fallbackFrom) this.noteRouteCutoff(r.fallbackFrom);
          }
          else if (!r.ok) {
            this.prog().failed++;
            this.addCutoff(v, r.cutoff, origin);
          }
        },
        url,
      );
    };

    // 台帳から候補を選び、照らし直す（W-03、Q-02）
    this.spawn(v, "台帳の検索", "system", async () => {
      const ledger = ledgerStub(this.env);
      const records = await ledger.search([opts.question, ...opts.queries], { snapshotSeq: m.manifest.ledgerSnapshotSeq, limit: mode.ledgerShow });
      if (!this.current(v)) return;
      for (const record of records) {
        if ([...this.hits.values()].some((h) => h.v === v && h.record.recordId === record.recordId)) continue;
        const passageId = `h${++this.counters.hit}`;
        const hit: HitEntry = { passageId, v, record, status: "照合中", deliveredStatus: null };
        this.hits.set(passageId, hit);
        // 調査が先に終わっていたら照らし直しは始められない。照合中のまま残さず、決着させる（設計 v1.5 §8.3.2）
        if (!this.spawn(v, `照らし直し: ${record.url}`, "ledger", async (signal) => this.revalidate(v, hit, signal))) {
          hit.status = "取得できず未照合";
          hit.reason = "調査の終わりまでに照らし直せなかった";
        }
      }
      this.notify();
    });

    for (const url of opts.urls) fetchUrl(url, "url");

    // lookup で URL があれば検索しない（利用者が示した出典だけを読む。設計 v1.3 §8.1.2）
    const queries = opts.urls.length > 0 && !mode.searchWithUrls ? [] : opts.queries;
    const sources = m.sources ?? ["web"];

    // 論文の検索（設計 v1.4 §8.2.2）。書誌と抄録は検索の応答にあるので、取得し直さずに出典にする
    if (sources.includes("scholarly")) {
      const S = POLICY.scholarly;
      const oaCap = S.openAccessPages[m.mode];
      for (const q of queries.slice(0, S.queriesMax)) {
        this.spawn(v, `論文の検索: ${q}`, "system", async (signal) => {
          const r = await this.gw().withSignal(signal).searchScholarly(q, S.perQuery);
          if (!this.current(v)) return;
          this.trace("search.sent", { v, query: q, provider: "scholarly", ok: r.ok, hits: r.ok ? r.works.length : 0 });
          const p = this.prog();
          p.searched++;
          if (!r.ok) {
            p.searchFailed++;
            return this.addCutoff(v, r.cutoff, "system");
          }
          const gw = this.gw().withSignal(signal);
          for (const w0 of r.works) {
            const url = workUrl(w0);
            if (!this.current(v) || this.fetchedUrls.has(url) || this.workCount >= S.maxWorks) continue;
            this.fetchedUrls.add(url);
            this.workCount++;
            p.found++;
            // 補う前に、題名と抄録に関連の下限を当てる（関係のない論文の公開の版を取りに行かない。設計 v1.6 §8.4.4）
            const relevant = coverage(`${w0.title} ${w0.abstract ?? ""}`, [m.question, ...m.queries]) >= POLICY.relevance.minCoverage;
            if (relevant && this.enrichCount < S.enrichMax) {
              // 上位の論文だけ、抄録と公開の版を補う（API への負荷を抑える。設計 v1.5 §8.3.4）。
              // 論文ごとの作業にして、時間の上限つきで並べる（検索の作業を止めない。締め切りを守る）
              this.enrichCount++;
              this.spawn(v, `論文を補う: ${w0.title.slice(0, 60)}`, "search", async (sig) => {
                const { work } = await this.gw().withSignal(sig).enrichWithin(w0, { oa: this.oaFollowed < oaCap });
                if (!this.current(v)) return;
                const doc = await this.gw().workDoc(work);
                this.addDoc(v, doc, "search");
                this.followRelated(v, doc, "search");
              });
              continue;
            }
            const doc = await gw.workDoc(w0);
            this.addDoc(v, doc, "search");
          }
        });
      }
    }
    if (!sources.includes("web")) return;
    for (const q of queries) {
      this.spawn(v, `検索: ${q}`, "system", async (signal) => {
        const r = await this.gw().withSignal(signal).search(q);
        if (!this.current(v)) return;
        this.trace("search.sent", { v, query: q, provider: "web", ok: r.ok, hits: r.ok ? r.hits.length : 0 });
        const p = this.prog();
        p.searched++;
        if (!r.ok) {
          p.searchFailed++;
          // ai-research の検索が使えないときは、組み込みの検索を通す（設計 v1.4 §8.2.4）
          if (!signal.aborted) this.ctx.waitUntil(routeStub(this.env).noteSearchDown().catch(() => {}));
          return this.addCutoff(v, r.cutoff, "system");
        }
        p.found += r.hits.length;
        for (const h of r.hits) fetchUrl(h.url, "search");
      });
    }
  }

  /** 照らし直しの規則（docs/02 §6）。LLM を使わない */
  private async revalidate(v: number, hit: HitEntry, signal: AbortSignal): Promise<void> {
    const rec = hit.record;
    const method = planRevalidation(rec.kind, rec.volatility);
    const gw = this.gw().withSignal(signal);
    const finish = (status: HitEntry["status"], reason?: string) => {
      if (!this.current(v)) return;
      hit.status = status;
      if (reason) hit.reason = reason;
      this.notify();
    };
    const markUnchanged = (fingerprint: Fingerprint) => {
      hit.verifiedText = `${rec.ctxBefore}${rec.excerpt}${rec.ctxAfter}`;
      hit.fingerprint = fingerprint;
      finish("引用確認済");
    };
    const recheckWith = (doc: Doc) => {
      const r = reverifyRecord({
        excerpt: rec.excerpt,
        ctxBefore: rec.ctxBefore,
        ctxAfter: rec.ctxAfter,
        sourceText: doc.text,
        source: doc.source,
        fingerprint: doc.fingerprint,
        verifiedAt: new Date().toISOString(),
      });
      if (r.ok) {
        hit.verifiedText = `${r.excerpt.ctxBefore}${r.excerpt.excerpt}${r.excerpt.ctxAfter}`;
        hit.fingerprint = doc.fingerprint;
        finish("引用確認済");
      } else if (doc.partial) {
        // 論文の抄録を補いきれなかった（取得の問題）。原文が変わったとは決めつけない
        finish("取得できず未照合", "論文の抄録を取り直せなかった");
      } else {
        finish("照合失敗", "出典が変わり、抜き書きが見つからない");
      }
    };

    if (method === "github-commit") {
      const c = classifyUrl(rec.url);
      if (c.kind === "github") {
        const sha = await gw.githubLatestCommit(c.owner, c.repo, c.path, c.ref).catch(() => null);
        if (sha) {
          const j = judgeRevalidation(rec.fingerprint, { method: "github-commit", commit: sha });
          if (j === "unchanged") return markUnchanged({ ...rec.fingerprint, commit: sha });
        }
      }
    } else if (method === "arxiv-version") {
      const c = classifyUrl(rec.url);
      if (c.kind === "arxiv") {
        const ver = await gw.arxivLatestVersion(c.id).catch(() => null);
        if (ver && judgeRevalidation(rec.fingerprint, { method: "arxiv-version", version: ver }) === "unchanged") {
          return markUnchanged({ ...rec.fingerprint, arxivVersion: ver });
        }
      }
    }
    const r = await gw.fetchDoc(rec.url, method === "conditional-get" ? rec.fingerprint : undefined, { forCheck: true });
    if (!r.ok) return finish("取得できず未照合", `取得できない（${r.cutoff.why}）`);
    if ("notModified" in r) {
      if (judgeRevalidation(rec.fingerprint, { method: "conditional-get", status: 304 }) === "unchanged") return markUnchanged(rec.fingerprint);
      return finish("取得できず未照合", "変わったかどうか判定できない");
    }
    const doc = r.doc;
    if (method === "conditional-get" && doc.fingerprint.textHash) {
      const j = judgeRevalidation(rec.fingerprint, {
        method: "conditional-get",
        status: 200,
        textHash: doc.fingerprint.textHash,
      });
      if (j === "unchanged") return markUnchanged(doc.fingerprint);
    }
    recheckWith(doc);
  }

  // ---- 束 -------------------------------------------------------------------

  private unfinished(v: number): TaskEntry[] {
    return [...this.tasks.values()].filter((t) => t.v === v && !t.done);
  }

  private hasNews(v: number): boolean {
    return (
      [...this.paras.values()].some((p) => p.v === v && !p.delivered) ||
      [...this.hits.values()].some((h) => h.v === v && h.status !== "照合中" && h.deliveredStatus !== h.status) ||
      this.cutoffs.some((c) => c.v === v && !c.delivered)
    );
  }

  private sourceRef(sourceId: string, passageId: string): SourceRef {
    const s = this.sources.get(sourceId);
    const src: Source = s?.doc.source ?? { kind: "web", url: this.meta!.passageMeta[passageId]?.url ?? "", locator: "" };
    return compactSource({ ...src, tier: tierOf(src) } as SourceRef);
  }

  /** 段落と、その出典（束の sources に1回だけ置く。設計 v1.4 §8.2.7） */
  private toPassage(p: ParaEntry, sources: Record<string, SourceRef>): Passage {
    sources[p.sourceId] ??= this.sourceRef(p.sourceId, p.passageId);
    const out: Passage = { passageId: p.passageId, sourceId: p.sourceId, text: p.text };
    if (p.context) out.context = p.context;
    return out;
  }

  private buildBundle(): Bundle {
    const m = this.meta!;
    const v = m.version;
    const notices: Notice[] = [];
    const phase = m.budget.phase;
    const caps = this.caps();
    const cap = caps[phase];

    const hitSources: Record<string, SourceRef> = {};
    const hitSourceByUrl = new Map<string, string>();
    const hitsOut: LedgerHit[] = [...this.hits.values()]
      .filter((h) => h.v === v && h.status !== "照合中" && h.deliveredStatus !== h.status)
      .map((h) => {
        // 同じ URL の候補は、出典を1つにまとめる
        const sid = hitSourceByUrl.get(h.record.url) ?? h.passageId;
        hitSourceByUrl.set(h.record.url, sid);
        hitSources[sid] ??= compactSource({
          kind: h.record.kind,
          url: h.record.url,
          locator: h.record.locator,
          tier: tierOf(h.record),
          ...(h.record.title ? { title: h.record.title } : {}),
        });
        const out: LedgerHit = {
          passageId: h.passageId,
          sourceId: sid,
          excerpt: h.record.excerpt,
          status: h.status as LedgerHit["status"],
          verifiedAt: h.record.verifiedAt,
        };
        if (h.reason) out.reason = h.reason;
        return out;
      });

    // INV-8（設計 v1.5 §8.3.2）：締め切りで終わっていない現在の版の作業は、
    // done でなければ pending（まだ集めている）、done なら cutoffs（gave_up）に必ず入れる
    const unfinished = this.unfinished(v);
    const pending: Pending[] = m.done ? [] : unfinished.map((t) => ({ what: t.url ?? t.label, since: new Date(t.startedAt).toISOString() }));
    const gaveUp = m.done
      ? unfinished.map((t) => ({ origin: t.origin, cutoff: { what: t.url ?? t.label, why: "gave_up", detail: "調査の終わりまでに終わらなかった" } as Cutoff }))
      : [];
    const pendingCutoffs = this.cutoffs.filter((c) => c.v === v && !c.delivered);
    const cutoffItems = [...pendingCutoffs.map((c) => ({ cutoff: c.cutoff, origin: c.origin })), ...gaveUp];
    // 答えに影響しうるものは1件ずつ、検索で見つけたページの失敗はまとめる（Q-04）
    const cutoffs = presentCutoffs(cutoffItems);

    const base: Bundle = {
      runId: m.runId,
      mode: m.mode,
      question: { version: v },
      procedure: POLICY.revision,
      sources: { ...hitSources },
      ledgerHits: hitsOut,
      passages: [],
      pending,
      cutoffs,
      progress: this.progressNow(v),
      done: m.done,
      notices,
    };
    const deliveredBefore = (this.shownTexts.get(v)?.size ?? 0) > 0 || [...this.hits.values()].some((h) => h.v === v && h.deliveredStatus !== null);

    // 予算の残りに収まるように段落を選ぶ（INV-9）
    const remaining = Math.max(0, cap - m.budget.used - estimateJsonTokens(base));
    // 同じ本文の段落（同じページの重複、同じ文書の別の URL）は1つだけ候補にする。
    // 既に届けた本文と同じものは、届けたことにして外す（予算を使わない）
    const shown = this.shownTexts.get(v) ?? new Set<string>();
    this.shownTexts.set(v, shown);
    const seen = new Set<string>();
    const candidates: Paragraph[] = [];
    for (const p of this.paras.values()) {
      if (p.v !== v || p.delivered) continue;
      const key = normalize(p.text);
      if (shown.has(key) || seen.has(key)) {
        p.delivered = true;
        continue;
      }
      seen.add(key);
      const src = this.sources.get(p.sourceId)?.doc.source;
      const weight = (src ? POLICY.tierWeight[tierOf(src)] : 1) * (p.weight ?? 1);
      candidates.push({ sourceId: p.sourceId, index: p.index, text: p.text, weight, passageId: p.passageId, ...(p.context ? { context: p.context } : {}) } as Paragraph & { passageId: string });
    }
    const selected = selectPassages(candidates, [m.question, ...m.queries], {
      passageMaxChars: POLICY.limits.passageMaxChars,
      passagesPerBundle: Math.min(POLICY.modes[m.mode].passagesPerBundle, m.maxPassages ?? Infinity),
      passagesPerSource: POLICY.modes[m.mode].passagesPerSource,
      maxTokens: Math.min(POLICY.limits.bundleMaxTokens, remaining),
      minRatio: POLICY.passages.minRatio,
      minCoverage: POLICY.relevance.minCoverage,
    });
    const byKey = new Map(candidates.map((c) => [`${c.sourceId}#${c.index}`, c as Paragraph & { passageId: string }]));
    const paraOf = (s: { sourceId: string; index: number }) => this.paras.get(byKey.get(`${s.sourceId}#${s.index}`)!.passageId)!;
    let chosen = selected;
    const assemble = (list: typeof selected): Bundle => {
      const sources = { ...hitSources };
      const passages = list.map((s) => ({ ...this.toPassage(paraOf(s), sources), text: s.text }));
      // 台帳の候補と段落が同じ出典なら、出典を1つにまとめる（段落の sourceId に寄せる）
      const byUrl = new Map(Object.entries(sources).filter(([k]) => !k.startsWith("h")).map(([k, v]) => [v.url, k]));
      const ledgerHits = base.ledgerHits.map((h) => {
        const to = byUrl.get(sources[h.sourceId]?.url ?? "");
        return to && to !== h.sourceId ? { ...h, sourceId: to } : h;
      });
      for (const k of Object.keys(sources)) if (k.startsWith("h") && !ledgerHits.some((h) => h.sourceId === k)) delete sources[k];
      return { ...base, sources, passages, ledgerHits };
    };
    let bundle = assemble(chosen);
    let want = estimateJsonTokens(bundle);
    let a = admit(m.budget, want, caps);
    while (a.allowed < want && chosen.length > 0) {
      chosen = chosen.slice(0, -1);
      bundle = assemble(chosen);
      want = estimateJsonTokens(bundle);
      a = admit(m.budget, want, caps);
    }
    m.budget = a.state;
    if (a.stop) {
      notices.push({ kind: "budget_stopped", phase });
      if (a.allowed < want) bundle = { ...base, sources: {}, passages: [], ledgerHits: [] };
    }
    // 終わった調査で、取得できたのに段落が1つも届かなかった出典を知らせる（設計 v1.5 §8.3.3、P-07）
    if (m.done) {
      const noPassage = this.noPassageItems(v, new Set(bundle.passages.map((p) => p.sourceId)));
      if (noPassage.length) {
        bundle.cutoffs = presentCutoffs([...cutoffItems, ...noPassage]);
        for (const it of noPassage) {
          this.noteRouteCutoff(it.cutoff);
          this.traceCutoff(v, it.cutoff, it.origin);
        }
      }
    }
    // 問いと出典の言語が違い、語で段落を選べない出典を知らせる（設計 v1.6 §8.4.1、S-06）
    const langMismatch = this.languageMismatch(v, new Set(bundle.passages.map((p) => p.sourceId)));
    if (langMismatch.length) notices.push({ kind: "query_language", sourceIds: langMismatch, next: QUERY_LANGUAGE_NEXT });
    if (!deliveredBefore && bundle.passages.length === 0 && bundle.ledgerHits.length === 0) {
      const why = this.emptyReason(bundle.progress);
      notices.push({ kind: "empty", why, next: EMPTY_NEXT[why] });
    }

    // 届けた印を付ける
    for (const p of bundle.passages) {
      const e = this.paras.get(p.passageId);
      if (e) {
        e.delivered = true;
        shown.add(normalize(e.text));
        this.trace("passage.selected", { v, passageId: e.passageId, sourceId: e.sourceId, chars: p.text.length, via: "bundle", ...(e.context ? { context: e.context } : {}) });
      }
    }
    for (const h of bundle.ledgerHits) {
      const e = this.hits.get(h.passageId);
      if (e) {
        e.deliveredStatus = e.status;
        this.trace("ledger.hit", { v, recordId: e.record.recordId, url: e.record.url, status: e.status, ...(e.reason ? { reason: e.reason } : {}) });
      }
    }
    // 締め切りで終わらなかった作業（gave_up）を1回だけ記録する
    if (m.done) {
      for (const t of unfinished) {
        if (this.gaveUpTraced.has(t.id)) continue;
        this.gaveUpTraced.add(t.id);
        this.traceCutoff(v, { what: t.url ?? t.label, why: "gave_up", detail: "調査の終わりまでに終わらなかった" }, t.origin);
      }
    }
    for (const c of pendingCutoffs) c.delivered = true;
    this.log("bundle", {
      v,
      passages: bundle.passages.map((p) => p.passageId),
      passageVersions: bundle.passages.map((p) => this.paras.get(p.passageId)?.v ?? -1),
      hits: bundle.ledgerHits.map((h) => h.passageId),
      unfinishedTasks: unfinished.map((t) => t.id),
      done: m.done,
      pending: pending.length,
      cutoffs: bundle.cutoffs.length,
      cutoffItems: cutoffItems.length,
      used: m.budget.used,
      phase,
      cap,
    });
    return bundle;
  }

  /** 段落が1つも届いていない出典のうち、問いと検索語にその出典の言語の語がないもの（1回だけ知らせる） */
  private languageMismatch(v: number, inThisBundle: Set<string>): string[] {
    const m = this.meta!;
    const qs = queryScripts([m.question, ...m.queries]);
    const delivered = new Set([...this.paras.values()].filter((p) => p.v === v && p.delivered).map((p) => p.sourceId));
    const out: string[] = [];
    for (const s of this.sources.values()) {
      const key = `${v}:${s.sourceId}`;
      if (s.v !== v || this.langNotified.has(key) || delivered.has(s.sourceId) || inThisBundle.has(s.sourceId)) continue;
      if (qs.has(scriptOf(s.doc.text))) continue;
      this.langNotified.add(key);
      out.push(s.sourceId);
    }
    return out;
  }

  /** 取得できたが段落が1つも届いていない出典（論文の書誌は除く：出典の work に書誌がある） */
  private noPassageItems(v: number, inThisBundle: Set<string>): CutoffItem[] {
    const delivered = new Set([...this.paras.values()].filter((p) => p.v === v && p.delivered && this.shownTexts.get(v)?.has(normalize(p.text))).map((p) => p.sourceId));
    const out: CutoffItem[] = [];
    for (const s of this.sources.values()) {
      if (s.v !== v || s.doc.source.kind === "work") continue;
      const key = `${v}:${s.sourceId}`;
      if (this.noPassageReported.has(key) || delivered.has(s.sourceId) || inThisBundle.has(s.sourceId)) continue;
      this.noPassageReported.add(key);
      out.push({
        origin: s.origin === "url" ? "url" : "search",
        cutoff: { what: s.doc.source.url, why: "no_passage", sourceId: s.sourceId, detail: "取得できたが、問いに合う段落が選ばれなかった。research.find で語句を探せる" },
      });
    }
    return out;
  }

  private progressNow(v: number): Progress {
    const { searched, found, fetched, failed } = this.prog();
    return { searched, found, fetched, failed, running: this.unfinished(v).length };
  }

  /** 0件の理由（設計 v1.4 §8.2.4）。束の状態から規則で決める */
  private emptyReason(p: Progress): EmptyReason {
    const m = this.meta!;
    if (!m.done && p.running > 0) return "still_running";
    const sf = this.prog().searchFailed;
    // 締め切りで打ち切った取得は、取得できなかったものに数える
    const failed = p.failed + p.running;
    if (p.fetched === 0 && failed > 0) return "all_failed";
    if (p.fetched === 0 && sf > 0 && sf >= p.searched) return "search_failed";
    if (p.fetched === 0) return "no_hits";
    return "not_relevant";
  }

  private async manifestFor(runId: string, input: QuestionInput, client?: string): Promise<Manifest> {
    const ledger = ledgerStub(this.env);
    const iq = JSON.stringify({ question: input.question, scope: input.scope ?? null, exclusions: input.exclusions ?? [] });
    const m: Manifest = {
      runId,
      procedureVersion: await procedureVersion(),
      hubVersion: "dev",
      ledgerSnapshotSeq: await ledger.currentSeq(),
      interpretedQuestionHash: (await textHash(iq)).slice(0, 16),
      searchProfile: `${this.env.SEARCH_PROVIDER ?? "none"}:${POLICY.search.resultsPerQuery}`,
      egress: "hub",
      createdAt: new Date().toISOString(),
    };
    if (client) m.client = client;
    return m;
  }

  // ---- 公開の操作（RPC） ----------------------------------------------------

  async start(runId: string, input: QuestionInput, client?: string): Promise<Bundle> {
    await this.load();
    if (this.meta) return this.notFoundBundle(runId, { kind: "superseded", currentVersion: this.meta.version });
    const question = String(input.question ?? "").trim();
    const queries = (input.queries ?? []).map(String).map((q) => q.trim()).filter(Boolean).slice(0, 8);
    const urls = (input.urls ?? []).map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 8);
    if (!question) throw new Error("question が空");
    const meta: Meta = {
      runId,
      createdAtMs: Date.now(),
      version: 1,
      question,
      queries,
      urls,
      mode: input.mode,
      sources: input.sources?.length ? [...new Set(input.sources)] : ["web"],
      deep: false,
      budget: { used: 0, phase: "first", stopped: false },
      done: false,
      firstReturned: false,
      manifest: await this.manifestFor(runId, { ...input, question, queries }, client),
      passageMeta: {},
    };
    if (input.maxPassages) meta.maxPassages = Math.max(1, Math.floor(input.maxPassages));
    if (input.scope) meta.scope = input.scope;
    if (input.exclusions) meta.exclusions = input.exclusions;
    this.meta = meta;
    this.log("start", { v: 1 });
    this.trace("run.started", {
      v: 1,
      question,
      mode: meta.mode,
      sources: meta.sources ?? ["web"],
      queries,
      urls,
      procedure: POLICY.revision,
      procedureVersion: meta.manifest.procedureVersion,
      ...(client ? { client } : {}),
    });
    await timed("run.setAlarm", () => this.ctx.storage.setAlarm(Date.now() + deadlines(this.env).continueUntilMs * timeScale(this.env)));
    this.launch(1, { queries, urls, question });
    return this.firstBundle(1, input.waitMs);
  }

  /** 最初の束。待つのは種類の締め切り（startMs）まで。waitMs があればそれより短く（設計 v1.5 §8.3.2） */
  private async firstBundle(v: number, waitMs?: number): Promise<Bundle> {
    const m = this.meta!;
    const mode = POLICY.modes[m.mode];
    const wait = waitMs === undefined ? mode.startMs : Math.min(mode.startMs, Math.max(0, waitMs));
    await this.waitUntil(() => !this.current(v) || this.unfinished(v).length === 0, wait);
    // 続きを集めない種類（lookup）は、締め切り（startMs）で終える。残りの作業は止める（設計 v1.3 §8.1.2）。
    // waitMs で早く返したときは、締め切りまで集め続け、next で受け取れる（設計 v1.5 §8.3.2）
    let ends = !mode.continues && !m.deep;
    if (ends && wait < mode.startMs && this.unfinished(v).length > 0) {
      ends = false;
      const rest = (mode.startMs - wait) * timeScale(this.env);
      this.ctx.waitUntil(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (this.current(v) && !m.done) {
              this.finish("lookup");
              this.abortAll();
            }
            resolve();
          }, rest),
        ),
      );
    }
    if (ends) this.finish("lookup");
    const b = this.buildBundle();
    if (ends) this.abortAll();
    if (!m.firstReturned) {
      m.firstReturned = true;
      // 最初の結果を返したら「続き」の段階に進む（R-01 の上限が上がる）
      if (mode.continues) m.budget = advance(m.budget, "continue", this.caps());
    }
    await this.save();
    return b;
  }

  async next(waitMs = 0): Promise<Bundle> {
    const m = await this.load();
    if (!m) return this.notFoundBundle("", { kind: "run_not_found" });
    const v = m.version;
    if (!m.done && !m.deep && this.elapsedPolicyMs() >= deadlines(this.env).continueUntilMs) this.finish();
    if (!m.done) {
      const wait = Math.min(Math.max(0, waitMs), deadlines(this.env).nextMaxWaitMs);
      await this.waitUntil(() => m.done || this.hasNews(v) || this.unfinished(v).length === 0, wait);
    }
    if (!m.done && !m.deep && this.unfinished(v).length === 0 && this.elapsedPolicyMs() >= deadlines(this.env).continueUntilMs) this.finish();
    const b = this.buildBundle();
    await this.save();
    return b;
  }

  async steer(input: { question: string; queries: string[]; urls?: string[]; sources?: SourceSet[]; waitMs?: number }): Promise<Bundle> {
    const m = await this.load();
    if (!m) return this.notFoundBundle("", { kind: "run_not_found" });
    const question = String(input.question ?? "").trim() || m.question;
    const queries = (input.queries ?? []).map(String).filter(Boolean).slice(0, 8);
    const urls = (input.urls ?? []).map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 8);
    const old = m.version;
    const v = old + 1;
    m.version = v;
    m.question = question;
    m.queries = queries;
    m.urls = urls;
    if (input.sources?.length) m.sources = [...new Set(input.sources)];
    m.progress = zeroProgress();
    // 論文を補う数・公開の版を読む数は、問いの版ごと
    this.enrichCount = 0;
    this.oaFollowed = 0;
    if (m.done) m.done = false;
    // 古い版の作業を止める。終わっても結果には混ぜない（INV-10）
    for (const t of this.tasks.values()) if (t.v === old && !t.done) t.controller.abort();
    this.trace("run.steered", { v, question, queries, urls });
    // 取得済みの原文は、新しい版の作業として使い回す（新しい問いで選び直す）
    for (const s of [...this.sources.values()].filter((x) => x.v === old)) this.addDoc(v, s.doc, s.origin, { reused: true });
    this.log("steer", { v });
    this.launch(v, { queries, urls, question });
    return this.firstBundle(v, input.waitMs);
  }

  async deepen(): Promise<Bundle> {
    const m = await this.load();
    if (!m) return this.notFoundBundle("", { kind: "run_not_found" });
    m.deep = true;
    m.done = false;
    m.budget = advance(m.budget, "deep", this.caps());
    this.log("deepen", { v: m.version });
    this.trace("run.deepened", { v: m.version });
    this.launch(m.version, { queries: m.queries, urls: m.urls, question: m.question, extra: true });
    return this.firstBundle(m.version);
  }

  /**
   * 段落の前後を返す（設計 v1.4 §8.2.5）。同じ出典の前後の候補の塊を、照合できる段落として返す。
   * 切り詰める前の全文を返す（上限 POLICY.around.maxChars）。退避で原文を失っていれば取り直す
   */
  async around(passageId: string, before = 1, after = 1): Promise<AroundResult> {
    const m = await this.load();
    const none = (n: Partial<AroundResult>): AroundResult => ({ sources: {}, passages: [], cutoffs: [], notices: [], ...n });
    if (!m) return none({ notices: [{ kind: "run_not_found" }] });
    const pm = m.passageMeta[passageId];
    if (!pm) return none({ notices: [{ kind: "passage_not_found", passageId }] });
    let src = this.sources.get(pm.sourceId);
    if (!src) {
      const r = await this.gw().fetchDoc(pm.url);
      if (!r.ok) return none({ cutoffs: [r.cutoff] });
      if (!("doc" in r)) return none({ notices: [{ kind: "passage_not_found", passageId }] });
      src = { sourceId: pm.sourceId, doc: r.doc, v: m.version };
      this.sources.set(pm.sourceId, src);
    }
    const cands = candidateParagraphs(pm.sourceId, src.doc.blocks);
    const pos = cands.findIndex((c) => c.index === pm.index);
    if (pos < 0) return none({ notices: [{ kind: "passage_not_found", passageId }] });
    const k = POLICY.around.maxEach;
    const b = Math.min(k, Math.max(0, Math.floor(before)));
    const a = Math.min(k, Math.max(0, Math.floor(after)));
    const query = [m.question, ...m.queries];
    const picked = cands.slice(Math.max(0, pos - b), pos + a + 1);
    return this.deliverExtra(src, picked, query, "around", { passageId });
  }

  /**
   * 取得済みの出典の中を語句で探す（設計 v1.5 §8.3.3、P-07）。関連の下限を使わず、語の当たりの多い順に返す。
   * source は sourceId か URL。退避で原文を失っていれば取り直す
   */
  async find(source: string, text: string, limit = 5): Promise<AroundResult> {
    const m = await this.load();
    const none = (n: Partial<AroundResult>): AroundResult => ({ sources: {}, passages: [], cutoffs: [], notices: [], ...n });
    if (!m) return none({ notices: [{ kind: "run_not_found" }] });
    // 台帳の候補の出典（h…）は、その抜き書きの URL で探す
    const hit = this.hits.get(source);
    const want = hit ? hit.record.url : source;
    let src = [...this.sources.values()].find((s) => s.v === m.version && (s.sourceId === want || urlKey(s.doc.source.url) === urlKey(want)));
    if (!src) {
      const meta = Object.values(m.passageMeta).find((x) => x.v === m.version && (x.sourceId === want || urlKey(x.url) === urlKey(want)));
      const url = meta?.url ?? (/^https?:\/\//.test(want) ? want : null);
      if (!url) return none({ notices: [{ kind: "source_not_found", source }] });
      const r = await this.gw().fetchDoc(url);
      if (!r.ok) return none({ cutoffs: [r.cutoff] });
      if (!("doc" in r)) return none({ notices: [{ kind: "source_not_found", source }] });
      const sourceId = meta?.sourceId ?? `s${++this.counters.source}`;
      src = { sourceId, doc: r.doc, v: m.version };
      this.sources.set(sourceId, src);
    }
    const cands = candidateParagraphs(src.sourceId, src.doc.blocks);
    const scores = scoreParagraphs(cands, [text]);
    const n = Math.min(POLICY.find.maxResults, Math.max(1, Math.floor(limit)));
    const picked = cands
      .map((c) => ({ c, s: scores.get(c) ?? 0 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.index - b.c.index)
      .slice(0, n)
      .map((x) => x.c);
    const r = await this.deliverExtra(src, picked, [text], "find", { source: src.sourceId });
    if (r.passages.length === 0 && r.notices.length === 0) r.notices.push({ kind: "empty", why: "not_relevant", next: POLICY_FIND_EMPTY });
    return r;
  }

  /** around・find で選んだ塊を、照合できる段落として届ける（同じ位置の段落は同じ ID） */
  private async deliverExtra(
    src: SourceEntry,
    picked: (Paragraph & { context?: string })[],
    query: string[],
    event: string,
    data: Record<string, unknown>,
  ): Promise<AroundResult> {
    const m = this.meta!;
    const shown = this.shownTexts.get(m.version) ?? new Set<string>();
    this.shownTexts.set(m.version, shown);
    const passages: Passage[] = [];
    const sources: Record<string, SourceRef> = {};
    for (const c of picked) {
      let e = [...this.paras.values()].find((p) => p.v === m.version && p.sourceId === src.sourceId && p.index === c.index);
      if (!e) {
        const id = Object.entries(m.passageMeta).find(([, x]) => x.v === m.version && x.sourceId === src.sourceId && x.index === c.index)?.[0];
        const passageId = id ?? `p${++this.counters.passage}`;
        e = { passageId, sourceId: src.sourceId, text: c.text, v: m.version, index: c.index, delivered: false };
        if (c.context) e.context = c.context;
        this.paras.set(passageId, e);
        m.passageMeta[passageId] = { sourceId: src.sourceId, url: src.doc.source.url, locator: src.doc.source.locator, v: m.version, index: c.index };
      }
      e.delivered = true;
      shown.add(normalize(e.text));
      const text = clip(e.text, query, POLICY.around.maxChars);
      passages.push({ ...this.toPassage(e, sources), text });
      this.trace("passage.selected", { v: m.version, passageId: e.passageId, sourceId: e.sourceId, chars: text.length, via: event, ...(e.context ? { context: e.context } : {}) });
    }
    const notices: Notice[] = [];
    const want = estimateJsonTokens({ sources, passages });
    const adm = admit(m.budget, want, this.caps());
    m.budget = adm.state;
    if (adm.allowed < want) {
      notices.push({ kind: "budget_stopped", phase: m.budget.phase });
      passages.length = 0;
    }
    this.log(event, { v: m.version, ...data, n: passages.length });
    await this.save();
    return { sources: passages.length ? sources : {}, passages, cutoffs: [], notices };
  }

  /** 主張を照合する。照合できた引用だけを台帳に追記する（INV-1、INV-5） */
  async verify(claims: ClaimInput[]): Promise<VerifyResult> {
    const m = await this.load();
    if (!m) return { statuses: [], notices: [{ kind: "run_not_found" }] };
    const notices: Notice[] = [];
    const list = Array.isArray(claims) ? claims.slice(0, INPUT_BOUNDS.claimsMax) : [];
    const want = estimateJsonTokens(list) + list.length * 30;
    const a = admit(m.budget, want, this.caps());
    m.budget = a.state;
    if (a.allowed < want) {
      notices.push({ kind: "budget_stopped", phase: m.budget.phase });
      await this.save();
      return { statuses: list.map((_, index) => ({ index, status: "未照合", reason: "budget", next: VERIFY_NEXT.budget })), notices };
    }
    const ledger = ledgerStub(this.env);
    const statuses: ClaimStatus[] = [];
    for (let index = 0; index < list.length; index++) {
      const claim = list[index]!;
      const cites = Array.isArray(claim.cite) ? claim.cite : [];
      if (cites.length === 0) {
        statuses.push({ index, status: "未照合", reason: "no_citation", next: VERIFY_NEXT.no_citation });
        continue;
      }
      let allExact = true;
      let failure: ClaimStatus["reason"] | null = null;
      let nearest: ClaimStatus["nearest"];
      const recorded: string[] = [];
      for (const c of cites) {
        const target = await this.citationTarget(String(c.passageId ?? ""));
        if (!target.ok) {
          failure = target.reason;
          break;
        }
        const r = verifyQuote({
          quote: String(c.quote ?? ""),
          sourceText: target.text,
          source: target.source,
          fingerprint: target.fingerprint,
          verifiedAt: new Date().toISOString(),
        });
        if (!r.ok) {
          failure = r.reason;
          if (r.nearest) nearest = r.nearest;
          break;
        }
        if (statusLabel(r.excerpt.match) !== "引用確認済") allExact = false;
        const vol = classifyVolatility({ kind: target.source.kind, url: target.source.url, excerpt: r.excerpt.excerpt });
        const rec = await ledger.appendVerified(r.excerpt, vol, m.runId);
        recorded.push(rec.recordId);
      }
      if (failure)
        statuses.push({
          index,
          status: "照合失敗",
          reason: failure,
          next: VERIFY_NEXT[failure],
          ...(nearest ? { nearest } : {}),
          ...(recorded.length ? { recorded } : {}),
        });
      else statuses.push({ index, status: allExact ? "引用確認済" : "引用確認済（表記差あり）", recorded });
    }
    this.log("verify", { v: m.version, n: list.length, ok: statuses.filter((s) => s.status.startsWith("引用確認済")).length });
    this.trace("verify.done", {
      v: m.version,
      claims: statuses.map((st) => ({
        status: st.status,
        ...(st.reason ? { reason: st.reason } : {}),
        passageIds: (Array.isArray(list[st.index]?.cite) ? list[st.index]!.cite : []).map((c) => String(c.passageId ?? "")),
        recorded: st.recorded ?? [],
      })),
    });
    await this.save();
    return { statuses, notices };
  }

  private async citationTarget(
    passageId: string,
  ): Promise<
    | { ok: true; text: string; source: Source; fingerprint: Fingerprint }
    | { ok: false; reason: "unknown_passage" | "not_in_source" }
  > {
    const m = this.meta!;
    const hit = this.hits.get(passageId);
    // 版（steer の前後）は照合に関係しない。照合は、その段落の原文に引用があるかだけを見る（設計 v1.5 §8.3.7）
    if (hit) {
      if (hit.status !== "引用確認済" || !hit.verifiedText) return { ok: false, reason: "not_in_source" };
      const source: Source = { kind: hit.record.kind, url: hit.record.url, locator: hit.record.locator };
      if (hit.record.title) source.title = hit.record.title;
      return { ok: true, text: hit.verifiedText, source, fingerprint: hit.fingerprint ?? hit.record.fingerprint };
    }
    const para = this.paras.get(passageId);
    const pm = m.passageMeta[passageId];
    if (!para && !pm) return { ok: false, reason: "unknown_passage" };
    // 引用は、引いた段落（切り詰める前の全文）の中でだけ照合する。
    // 同じ文書の別の段落にある文を、見ていない段落の名で通さない
    const s = para ? this.sources.get(para.sourceId) : undefined;
    if (para && s) return { ok: true, text: para.text, source: s.doc.source, fingerprint: s.doc.fingerprint };
    // 退避でメモリの原文を失ったときは取り直す（INV-13 と両立させる）。
    // 取り直した原文で同じ位置の段落を使う。原文が変わっていれば照合に失敗する（安全側）
    const r = await this.gw().fetchDoc(pm!.url, undefined, { forCheck: true });
    if (r.ok && "doc" in r) {
      const again = candidateParagraphs(pm!.sourceId, r.doc.blocks).find((x) => x.index === pm!.index);
      if (again) return { ok: true, text: again.text, source: r.doc.source, fingerprint: r.doc.fingerprint };
    }
    return { ok: false, reason: "not_in_source" };
  }

  /** 4分の上限：残りの作業を止めて終える（W-04） */
  private finish(why: "idle" | "limit" | "close" | "lookup" = "limit"): void {
    const m = this.meta!;
    if (m.done) return;
    m.done = true;
    // 決着していない台帳の候補は、取り直せなかったものとして決着させる（照合中を外に出さない）
    for (const h of this.hits.values()) {
      if (h.v === m.version && h.status === "照合中") {
        h.status = "取得できず未照合";
        h.reason = "調査の終わりまでに照らし直せなかった";
      }
    }
    this.log("finish", { v: m.version, why, unfinished: this.unfinished(m.version).map((t) => t.id) });
    const p = this.prog();
    this.trace("run.done", { v: m.version, why, searched: p.searched, found: p.found, fetched: p.fetched, failed: p.failed, elapsedMs: Date.now() - m.createdAtMs });
    this.notify();
  }

  private abortAll(): void {
    for (const t of this.tasks.values()) if (!t.done) t.controller.abort();
  }

  override async alarm(): Promise<void> {
    const m = await this.load();
    if (!m || m.deep) return;
    this.finish();
    this.abortAll();
    await this.save();
  }

  /** 答えが出たら止める（survey。設計 v1.3 §3）。調査がなければ false */
  async close(): Promise<boolean> {
    const m = await this.load();
    if (!m) return false;
    this.finish("close");
    this.abortAll();
    this.log("close", { v: m.version });
    await this.save();
    return true;
  }

  private notFoundBundle(runId: string, notice: Notice): Bundle {
    return {
      runId,
      mode: "survey",
      question: { version: 0 },
      procedure: POLICY.revision,
      sources: {},
      ledgerHits: [],
      passages: [],
      pending: [],
      cutoffs: [],
      progress: { searched: 0, found: 0, fetched: 0, failed: 0, running: 0 },
      done: true,
      notices: [notice],
    };
  }

  // ---- 試験と点検用 ---------------------------------------------------------

  /** 状態と記録を JSON で返す（RPC の型に unknown を通さないため文字列にする） */
  async inspect(): Promise<string> {
    await this.load();
    return JSON.stringify({
      meta: this.meta,
      events: this.events,
      tasks: [...this.tasks.values()].map(({ id, v, label, done }) => ({ id, v, label, done })),
      paras: [...this.paras.values()].map(({ passageId, v, delivered }) => ({ passageId, v, delivered })),
    });
  }
}

export type RunInspection = {
  meta: Meta | null;
  events: RunEvent[];
  tasks: { id: number; v: number; label: string; done: boolean }[];
  paras: { passageId: string; v: number; delivered: boolean }[];
};

export function runStub(env: Env, runId: string): DurableObjectStub<RunDO> {
  return env.RUNS.get(env.RUNS.idFromName(runId));
}
