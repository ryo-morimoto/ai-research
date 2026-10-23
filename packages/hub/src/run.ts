import { DurableObject } from "cloudflare:workers";
import {
  normalize,
  selectPassages,
  splitParagraphs,
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
  type BudgetState,
  type Fingerprint,
  type Paragraph,
  type Phase,
  type Source,
} from "@ai-research/core";
import { POLICY, procedureVersion } from "@ai-research/policy";
import type {
  Bundle,
  ClaimInput,
  ClaimStatus,
  Cutoff,
  LedgerHit,
  Notice,
  Passage,
  QuestionInput,
  VerifyResult,
} from "@ai-research/sandbox-api";
import type { Env } from "./env.ts";
import { Gateway, classifyUrl, type Doc } from "./gateway.ts";
import { ledgerStub, type LedgerRecord } from "./ledger.ts";
import { routeStub } from "./route.ts";
import { deadlines, timeScale } from "./time.ts";
import { timed } from "./obs.ts";

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

type SourceEntry = { sourceId: string; doc: Doc; v: number };
type ParaEntry = { passageId: string; sourceId: string; text: string; v: number; index: number; delivered: boolean };
type HitEntry = {
  passageId: string;
  v: number;
  record: LedgerRecord;
  status: LedgerHit["status"];
  reason?: string;
  deliveredStatus: LedgerHit["status"] | null;
  /** 照らし直せたときの、照合に使える原文（抜き書きと前後の文脈） */
  verifiedText?: string;
  fingerprint?: Fingerprint;
};
type TaskEntry = { id: number; v: number; label: string; done: boolean; controller: AbortController; deep: boolean; startedAt: number };
type CutoffEntry = { cutoff: Cutoff; v: number; delivered: boolean };

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
  depth: "first" | "standard";
  deep: boolean;
  budget: BudgetState;
  done: boolean;
  firstReturned: boolean;
  manifest: Manifest;
  /** 段落のメタデータ（本文は持たない。INV-13） */
  passageMeta: Record<string, { sourceId: string; url: string; locator: string; v: number; index: number }>;
  /** ID の払い出しの続き。退避の後も同じ ID を使い回さないために保存する */
  counters?: { task: number; source: number; passage: number; hit: number };
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
  private counters = { task: 0, source: 0, passage: 0, hit: 0, ev: 0 };
  private events: RunEvent[] = [];
  /** 版ごとに、束に入れた段落の本文（正規化後）。同じ文を二度届けない */
  private shownTexts = new Map<number, Set<string>>();

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
      const { task, source, passage, hit } = this.counters;
      this.meta.counters = { task, source, passage, hit };
      const meta = this.meta;
      await timed("run.save.meta", () => this.ctx.storage.put("meta", meta));
    }
    await timed("run.save.events", () => this.ctx.storage.put("events", this.events.slice(-MAX_EVENTS)));
  }

  private log(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ ev: ++this.counters.ev, at: Date.now(), type, ...data });
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
  private spawn(v: number, label: string, fn: (signal: AbortSignal) => Promise<void>): boolean {
    const m = this.meta!;
    if (m.done) return false;
    if (!m.deep && this.elapsedPolicyMs() >= deadlines(this.env).continueUntilMs) return false;
    const id = ++this.counters.task;
    const controller = new AbortController();
    const task: TaskEntry = { id, v, label, done: false, controller, deep: m.deep, startedAt: Date.now() };
    this.tasks.set(id, task);
    this.log("task_start", { id, v, label });
    fn(controller.signal)
      .catch((e) => {
        if (v === this.meta?.version && !controller.signal.aborted) {
          this.cutoffs.push({ cutoff: { what: label, why: "error", detail: String(e).slice(0, 200) }, v, delivered: false });
        }
      })
      .finally(() => {
        task.done = true;
        this.log("task_done", { id, v });
        this.notify();
      });
    return true;
  }

  private current(v: number): boolean {
    return this.meta !== null && this.meta.version === v;
  }

  /** 取得した原文を登録する。古い版の作業の結果は混ぜない（INV-10） */
  private addDoc(v: number, doc: Doc): string | null {
    if (!this.current(v)) return null;
    const sourceId = `s${++this.counters.source}`;
    this.sources.set(sourceId, { sourceId, doc, v });
    for (const p of splitParagraphs(sourceId, doc.text)) {
      const passageId = `p${++this.counters.passage}`;
      this.paras.set(passageId, { passageId, sourceId, text: p.text, v, index: p.index, delivered: false });
      this.meta!.passageMeta[passageId] = { sourceId, url: doc.source.url, locator: doc.source.locator, v, index: p.index };
    }
    this.notify();
    return sourceId;
  }

  private addCutoff(v: number, cutoff: Cutoff): void {
    if (!this.current(v)) return;
    this.cutoffs.push({ cutoff, v, delivered: false });
    // ai-research で取れなかった URL は、組み込みの取得に回してよい（U-03 の例外。理由は policy で絞る）
    if (/^https?:\/\//.test(cutoff.what)) {
      this.ctx.waitUntil(routeStub(this.env).noteCutoff(cutoff.what, cutoff.why).catch(() => {}));
    }
    this.notify();
  }

  private launch(v: number, opts: { queries: string[]; urls: string[]; question: string; extra?: boolean }): void {
    const m = this.meta!;
    const maxSources = POLICY.search.maxSourcesPerRun * (m.deep ? 2 : 1);

    const fetchUrl = (url: string) => {
      if (this.fetchedUrls.has(url) || this.fetchedUrls.size >= maxSources) return;
      this.fetchedUrls.add(url);
      this.spawn(v, `取得: ${url}`, async (signal) => {
        const r = await this.gw().withSignal(signal).fetchDoc(url);
        if (!this.current(v)) return;
        if (r.ok && "doc" in r) this.addDoc(v, r.doc);
        else if (!r.ok) this.addCutoff(v, r.cutoff);
      });
    };

    // 台帳から候補を選び、照らし直す（W-03、Q-02）
    this.spawn(v, "台帳の検索", async () => {
      const ledger = ledgerStub(this.env);
      const text = [opts.question, ...opts.queries].join(" ");
      const records = await ledger.search(text, { snapshotSeq: m.manifest.ledgerSnapshotSeq, limit: POLICY.search.maxLedgerCandidates });
      if (!this.current(v)) return;
      for (const record of records) {
        if ([...this.hits.values()].some((h) => h.v === v && h.record.recordId === record.recordId)) continue;
        const passageId = `h${++this.counters.hit}`;
        const hit: HitEntry = { passageId, v, record, status: "照合中", deliveredStatus: null };
        this.hits.set(passageId, hit);
        this.spawn(v, `照らし直し: ${record.url}`, async (signal) => this.revalidate(v, hit, signal));
      }
      this.notify();
    });

    for (const url of opts.urls) fetchUrl(url);

    for (const q of opts.queries) {
      this.spawn(v, `検索: ${q}`, async (signal) => {
        const r = await this.gw().withSignal(signal).search(q);
        if (!this.current(v)) return;
        if (!r.ok) return this.addCutoff(v, r.cutoff);
        for (const h of r.hits) fetchUrl(h.url);
      });
    }
  }

  /** 照らし直しの規則（docs/02 §6）。LLM を使わない */
  private async revalidate(v: number, hit: HitEntry, signal: AbortSignal): Promise<void> {
    const rec = hit.record;
    const method = planRevalidation(rec.kind, rec.volatility);
    const gw = this.gw().withSignal(signal);
    const finish = (status: LedgerHit["status"], reason?: string) => {
      if (!this.current(v)) return;
      hit.status = status;
      if (reason) hit.reason = reason;
      this.notify();
    };
    const markUnchanged = (fingerprint: Fingerprint) => {
      hit.verifiedText = `${rec.ctxBefore}${rec.excerpt}${rec.ctxAfter}`;
      hit.fingerprint = fingerprint;
      finish("確認済");
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
        finish("確認済");
      } else {
        finish("未確認", "出典が変わり、抜き書きが見つからない");
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
    const r = await gw.fetchDoc(rec.url, method === "conditional-get" ? rec.fingerprint : undefined);
    if (!r.ok) return finish("未確認", `取得できない（${r.cutoff.why}）`);
    if ("notModified" in r) {
      if (judgeRevalidation(rec.fingerprint, { method: "conditional-get", status: 304 }) === "unchanged") return markUnchanged(rec.fingerprint);
      return finish("未確認", "変わったかどうか判定できない");
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
      [...this.hits.values()].some((h) => h.v === v && h.deliveredStatus !== h.status) ||
      this.cutoffs.some((c) => c.v === v && !c.delivered)
    );
  }

  private toPassage(p: ParaEntry): Passage {
    const s = this.sources.get(p.sourceId);
    const src: Source = s?.doc.source ?? { kind: "web", url: this.meta!.passageMeta[p.passageId]?.url ?? "", locator: "" };
    return { passageId: p.passageId, text: p.text, source: { ...src } };
  }

  private buildBundle(): Bundle {
    const m = this.meta!;
    const v = m.version;
    const notices: Notice[] = [];
    const phase = m.budget.phase;
    const caps = this.caps();
    const cap = caps[phase];

    const hitsOut: LedgerHit[] = [...this.hits.values()]
      .filter((h) => h.v === v && h.deliveredStatus !== h.status)
      .map((h) => {
        const out: LedgerHit = {
          passageId: h.passageId,
          recordId: h.record.recordId,
          excerpt: h.record.excerpt,
          source: { kind: h.record.kind, url: h.record.url, locator: h.record.locator, ...(h.record.title ? { title: h.record.title } : {}) },
          status: h.status,
        };
        if (h.reason) out.reason = h.reason;
        return out;
      });

    // INV-8：締め切りで終わっていない現在の版の作業を、すべて cutoffs に入れる
    const running: Cutoff[] = this.unfinished(v).map((t) => ({
      what: t.label,
      why: "timeout",
      detail: m.done ? "4分の上限で打ち切った" : "締め切りまでに終わらず、続けて集めている",
    }));
    const pendingCutoffs = this.cutoffs.filter((c) => c.v === v && !c.delivered);
    const cutoffs = [...pendingCutoffs.map((c) => c.cutoff), ...running];

    const base: Bundle = {
      runId: m.runId,
      question: { version: v, text: m.question },
      ledgerHits: hitsOut,
      passages: [],
      cutoffs,
      budget: { phase, usedTokens: m.budget.used, capTokens: cap },
      done: m.done,
      notices,
    };

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
      candidates.push({ sourceId: p.sourceId, index: p.index, text: p.text, passageId: p.passageId } as Paragraph & { passageId: string });
    }
    const selected = selectPassages(candidates, [m.question, ...m.queries], {
      passageMaxChars: POLICY.limits.passageMaxChars,
      passagesPerBundle: POLICY.limits.passagesPerBundle,
      passagesPerSource: POLICY.limits.passagesPerSource,
      maxTokens: Math.min(POLICY.limits.bundleMaxTokens, remaining),
    });
    const byKey = new Map(candidates.map((c) => [`${c.sourceId}#${c.index}`, c as Paragraph & { passageId: string }]));
    let passages: Passage[] = selected.map((s) => {
      const para = this.paras.get(byKey.get(`${s.sourceId}#${s.index}`)!.passageId)!;
      return { ...this.toPassage(para), text: s.text };
    });

    let bundle: Bundle = { ...base, passages };
    let want = estimateJsonTokens(bundle);
    let a = admit(m.budget, want, caps);
    while (a.allowed < want && passages.length > 0) {
      passages = passages.slice(0, -1);
      bundle = { ...base, passages };
      want = estimateJsonTokens(bundle);
      a = admit(m.budget, want, caps);
    }
    m.budget = a.state;
    if (a.stop) {
      notices.push({ kind: "budget_stopped", phase });
      if (a.allowed < want) bundle = { ...base, passages: [], ledgerHits: [] };
    }
    bundle.budget = { phase, usedTokens: m.budget.used, capTokens: cap };
    if (m.done) notices.push({ kind: "done" });

    // 届けた印を付ける
    for (const p of bundle.passages) {
      const e = this.paras.get(p.passageId);
      if (e) {
        e.delivered = true;
        shown.add(normalize(e.text));
      }
    }
    for (const h of bundle.ledgerHits) {
      const e = this.hits.get(h.passageId);
      if (e) e.deliveredStatus = e.status;
    }
    for (const c of pendingCutoffs) c.delivered = true;
    this.log("bundle", {
      v,
      passages: bundle.passages.map((p) => p.passageId),
      passageVersions: bundle.passages.map((p) => this.paras.get(p.passageId)?.v ?? -1),
      hits: bundle.ledgerHits.map((h) => h.passageId),
      cutoffTasks: this.unfinished(v).map((t) => t.id),
      cutoffs: bundle.cutoffs.length,
      used: m.budget.used,
      phase,
      cap,
    });
    return bundle;
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
      depth: input.depth === "first" ? "first" : "standard",
      deep: false,
      budget: { used: 0, phase: "first", stopped: false },
      done: false,
      firstReturned: false,
      manifest: await this.manifestFor(runId, { ...input, question, queries }, client),
      passageMeta: {},
    };
    if (input.scope) meta.scope = input.scope;
    if (input.exclusions) meta.exclusions = input.exclusions;
    this.meta = meta;
    this.log("start", { v: 1 });
    await timed("run.setAlarm", () => this.ctx.storage.setAlarm(Date.now() + deadlines(this.env).continueUntilMs * timeScale(this.env)));
    this.launch(1, { queries, urls, question });
    return this.firstBundle(1);
  }

  private async firstBundle(v: number): Promise<Bundle> {
    await this.waitUntil(() => !this.current(v) || this.unfinished(v).length === 0, deadlines(this.env).startMs);
    const m = this.meta!;
    const b = this.buildBundle();
    if (!m.firstReturned) {
      m.firstReturned = true;
      // 最初の結果を返したら「続き」の段階に進む（R-01 の上限が上がる）
      if (m.depth === "standard") m.budget = advance(m.budget, "continue", this.caps());
      else m.done = true;
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

  async steer(input: { question: string; queries: string[]; urls?: string[] }): Promise<Bundle> {
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
    if (m.done) m.done = false;
    // 古い版の作業を止める。終わっても結果には混ぜない（INV-10）
    for (const t of this.tasks.values()) if (t.v === old && !t.done) t.controller.abort();
    // 取得済みの原文は、新しい版の作業として使い回す（新しい問いで選び直す）
    for (const s of [...this.sources.values()].filter((x) => x.v === old)) this.addDoc(v, s.doc);
    this.log("steer", { v });
    this.launch(v, { queries, urls, question });
    return this.firstBundle(v);
  }

  async deepen(): Promise<Bundle> {
    const m = await this.load();
    if (!m) return this.notFoundBundle("", { kind: "run_not_found" });
    m.deep = true;
    m.done = false;
    m.budget = advance(m.budget, "deep", this.caps());
    this.log("deepen", { v: m.version });
    this.launch(m.version, { queries: m.queries, urls: m.urls, question: m.question, extra: true });
    return this.firstBundle(m.version);
  }

  /** 主張を照合する。照合できた引用だけを台帳に追記する（INV-1、INV-5） */
  async verify(claims: ClaimInput[]): Promise<VerifyResult> {
    const m = await this.load();
    if (!m) return { statuses: [], notices: [{ kind: "run_not_found" }] };
    const notices: Notice[] = [];
    const list = Array.isArray(claims) ? claims.slice(0, 50) : [];
    const want = estimateJsonTokens(list) + list.length * 30;
    const a = admit(m.budget, want, this.caps());
    m.budget = a.state;
    if (a.allowed < want) {
      notices.push({ kind: "budget_stopped", phase: m.budget.phase });
      await this.save();
      return { statuses: list.map((_, index) => ({ index, status: "未確認", reason: "budget" })), notices };
    }
    const ledger = ledgerStub(this.env);
    const statuses: ClaimStatus[] = [];
    for (let index = 0; index < list.length; index++) {
      const claim = list[index]!;
      const cites = Array.isArray(claim.cite) ? claim.cite : [];
      if (cites.length === 0) {
        statuses.push({ index, status: "未確認", reason: "no_citation" });
        continue;
      }
      let allExact = true;
      let failure: ClaimStatus["reason"] | null = null;
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
          break;
        }
        if (statusLabel(r.excerpt.match) !== "確認済") allExact = false;
        const vol = classifyVolatility({ kind: target.source.kind, url: target.source.url, excerpt: r.excerpt.excerpt });
        const rec = await ledger.appendVerified(r.excerpt, vol, m.runId);
        recorded.push(rec.recordId);
      }
      if (failure) statuses.push({ index, status: "未確認", reason: failure, ...(recorded.length ? { recorded } : {}) });
      else statuses.push({ index, status: allExact ? "確認済" : "確認済（表記差あり）", recorded });
    }
    this.log("verify", { v: m.version, n: list.length, ok: statuses.filter((s) => s.status !== "未確認").length });
    await this.save();
    return { statuses, notices };
  }

  private async citationTarget(
    passageId: string,
  ): Promise<
    | { ok: true; text: string; source: Source; fingerprint: Fingerprint }
    | { ok: false; reason: "unknown_passage" | "stale_version" | "not_in_source" }
  > {
    const m = this.meta!;
    const hit = this.hits.get(passageId);
    if (hit) {
      if (hit.v !== m.version) return { ok: false, reason: "stale_version" };
      if (hit.status !== "確認済" || !hit.verifiedText) return { ok: false, reason: "not_in_source" };
      const source: Source = { kind: hit.record.kind, url: hit.record.url, locator: hit.record.locator };
      if (hit.record.title) source.title = hit.record.title;
      return { ok: true, text: hit.verifiedText, source, fingerprint: hit.fingerprint ?? hit.record.fingerprint };
    }
    const para = this.paras.get(passageId);
    const pm = m.passageMeta[passageId];
    if (!para && !pm) return { ok: false, reason: "unknown_passage" };
    if ((para?.v ?? pm?.v) !== m.version) return { ok: false, reason: "stale_version" };
    // 引用は、引いた段落（切り詰める前の全文）の中でだけ照合する。
    // 同じ文書の別の段落にある文を、見ていない段落の名で通さない
    const s = para ? this.sources.get(para.sourceId) : undefined;
    if (para && s) return { ok: true, text: para.text, source: s.doc.source, fingerprint: s.doc.fingerprint };
    // 退避でメモリの原文を失ったときは取り直す（INV-13 と両立させる）。
    // 取り直した原文で同じ位置の段落を使う。原文が変わっていれば照合に失敗する（安全側）
    const r = await this.gw().fetchDoc(pm!.url);
    if (r.ok && "doc" in r) {
      const again = splitParagraphs(pm!.sourceId, r.doc.text).find((x) => x.index === pm!.index);
      if (again) return { ok: true, text: again.text, source: r.doc.source, fingerprint: r.doc.fingerprint };
    }
    return { ok: false, reason: "not_in_source" };
  }

  /** 4分の上限：残りの作業を止めて終える（W-04） */
  private finish(): void {
    const m = this.meta!;
    if (m.done) return;
    m.done = true;
    this.log("finish", { v: m.version, unfinished: this.unfinished(m.version).map((t) => t.id) });
    this.notify();
  }

  override async alarm(): Promise<void> {
    const m = await this.load();
    if (!m || m.deep) return;
    this.finish();
    for (const t of this.tasks.values()) if (!t.done) t.controller.abort();
    await this.save();
  }

  private notFoundBundle(runId: string, notice: Notice): Bundle {
    return {
      runId,
      question: { version: 0, text: "" },
      ledgerHits: [],
      passages: [],
      cutoffs: [],
      budget: { phase: "first" as Phase, usedTokens: 0, capTokens: 0 },
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
