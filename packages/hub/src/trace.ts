import { DurableObject } from "cloudflare:workers";
import { sanitizeTraceEvent, type TraceEvent } from "@ai-research/core";
import { POLICY } from "@ai-research/policy";
import type { Env } from "./env.ts";

/**
 * 調査の記録（docs/05）。1人に1つ（idFromName("trace")）。
 *
 * - RunDO が調査の各段を事象として送る。RunDO は待たない（C-03）。ここが失敗しても調査は止まらない
 * - 事象は追記のみ。取り消しは墓標の追記で表し、読み取りで突き合わせる（C-08、台帳と同じ規則）
 * - 保存の前に core の整形を通す。段落の本文の欄は型にも表にもない（C-04、INV-13 と同じ考え）
 * - 書き込みと同時に、調査ごとの集計（runs）を更新する。見る側は集計を読むだけで済む
 * - retentionDays を過ぎた事象と集計は消す（C-10）
 *
 * このモジュールは LLM にも取得の出口にも依存しない（V-01。scripts/check-deps.mjs の規則 4）
 */

export type RunSummary = {
  runId: string;
  startedAt: number;
  lastAt: number;
  question: string;
  mode: string;
  procedureVersion: string;
  client: string | null;
  version: number;
  done: boolean;
  doneWhy: string | null;
  sources: number;
  passages: number;
  cutoffs: number;
  verified: number;
  failedClaims: number;
  events: number;
};

type RunRow = {
  run_id: string;
  started_at: number;
  last_at: number;
  question: string;
  mode: string;
  procedure_version: string;
  client: string | null;
  version: number;
  done: number;
  done_why: string | null;
  sources: number;
  passages: number;
  cutoffs: number;
  verified: number;
  failed_claims: number;
  events: number;
};

const toSummary = (r: RunRow): RunSummary => ({
  runId: r.run_id,
  startedAt: r.started_at,
  lastAt: r.last_at,
  question: r.question,
  mode: r.mode,
  procedureVersion: r.procedure_version,
  client: r.client,
  version: r.version,
  done: r.done === 1,
  doneWhy: r.done_why,
  sources: r.sources,
  passages: r.passages,
  cutoffs: r.cutoffs,
  verified: r.verified,
  failedClaims: r.failed_claims,
  events: r.events,
});

export class TraceDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastPrune = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        ev INTEGER NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        json TEXT NOT NULL
      )`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS events_run ON events (run_id, ev)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS events_at ON events (at)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        question TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT '',
        procedure_version TEXT NOT NULL DEFAULT '',
        client TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        done INTEGER NOT NULL DEFAULT 0,
        done_why TEXT,
        sources INTEGER NOT NULL DEFAULT 0,
        passages INTEGER NOT NULL DEFAULT 0,
        cutoffs INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        failed_claims INTEGER NOT NULL DEFAULT 0,
        events INTEGER NOT NULL DEFAULT 0
      )`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS tombstones (run_id TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT)`);
    });
  }

  private forgotten(runId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM tombstones WHERE run_id = ?`, runId).toArray().length > 0;
  }

  /** 古い事象と集計を消す（C-10）。墓標は消さない（あとから届いた事象を捨てるため） */
  private prune(now: number): void {
    if (now - this.lastPrune < POLICY.trace.pruneEveryMs) return;
    this.lastPrune = now;
    const before = now - POLICY.trace.retentionDays * 86_400_000;
    this.sql.exec(`DELETE FROM events WHERE at < ?`, before);
    this.sql.exec(`DELETE FROM runs WHERE last_at < ?`, before);
  }

  /** 集計を事象1件ぶん進める */
  private summarize(e: TraceEvent): void {
    const id = e.runId;
    this.sql.exec(
      `INSERT INTO runs (run_id, started_at, last_at, events) VALUES (?, ?, ?, 1) ON CONFLICT(run_id) DO UPDATE SET last_at = max(last_at, excluded.last_at), events = events + 1`,
      id,
      e.at,
      e.at,
    );
    switch (e.type) {
      case "run.started":
        this.sql.exec(
          `UPDATE runs SET started_at = ?, question = ?, mode = ?, procedure_version = ?, client = ?, version = ? WHERE run_id = ?`,
          e.at,
          e.question,
          e.mode,
          e.procedureVersion ?? "",
          e.client ?? null,
          e.v,
          id,
        );
        break;
      case "run.steered":
        this.sql.exec(`UPDATE runs SET question = ?, version = max(version, ?), done = 0, done_why = NULL WHERE run_id = ?`, e.question, e.v, id);
        break;
      case "run.deepened":
        this.sql.exec(`UPDATE runs SET done = 0, done_why = NULL WHERE run_id = ?`, id);
        break;
      case "run.done":
        this.sql.exec(`UPDATE runs SET done = 1, done_why = ? WHERE run_id = ?`, e.why, id);
        break;
      case "source.fetched":
        if (!e.reused) this.sql.exec(`UPDATE runs SET sources = sources + 1 WHERE run_id = ?`, id);
        break;
      case "passage.selected":
        this.sql.exec(`UPDATE runs SET passages = passages + 1 WHERE run_id = ?`, id);
        break;
      case "cutoff":
        this.sql.exec(`UPDATE runs SET cutoffs = cutoffs + 1 WHERE run_id = ?`, id);
        break;
      case "verify.done": {
        const claims = e.claims ?? [];
        const ok = claims.filter((c) => c.status.startsWith("引用確認済")).length;
        this.sql.exec(`UPDATE runs SET verified = verified + ?, failed_claims = failed_claims + ? WHERE run_id = ?`, ok, claims.length - ok, id);
        break;
      }
    }
  }

  // ---- 公開の操作（RPC） ----------------------------------------------------

  /**
   * 事象を追記する。json は事象の配列（RPC の型に unknown を通さないため文字列で受ける）。
   * 整形で落ちたもの、墓標の付いた調査のもの、調査ごとの上限を超えたものは捨てて数える
   */
  append(json: string): { accepted: number; rejected: number } {
    if (this.env.TEST_TRACE_FAIL === "1") throw new Error("試験：記録の書き込みに失敗");
    const now = Date.now();
    this.prune(now);
    let input: unknown;
    try {
      input = JSON.parse(json);
    } catch {
      return { accepted: 0, rejected: 1 };
    }
    const list = Array.isArray(input) ? input : [input];
    let accepted = 0;
    let rejected = 0;
    const seen = new Map<string, number>();
    for (const raw of list.slice(0, POLICY.trace.flushBatch)) {
      const e = sanitizeTraceEvent(raw, POLICY.trace);
      if (!e || this.forgotten(e.runId)) {
        rejected++;
        continue;
      }
      const n =
        seen.get(e.runId) ??
        this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM events WHERE run_id = ?`, e.runId).one().n;
      if (n >= POLICY.trace.maxEventsPerRun) {
        rejected++;
        continue;
      }
      // 事象と集計は一緒に書く（片方だけ残さない）
      try {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`INSERT INTO events (run_id, ev, at, type, json) VALUES (?, ?, ?, ?, ?)`, e.runId, e.ev, e.at, e.type, JSON.stringify(e));
          this.summarize(e);
        });
      } catch (err) {
        console.log(JSON.stringify({ event: "trace_rejected", type: e.type, error: String(err).slice(0, 200) }));
        rejected++;
        continue;
      }
      seen.set(e.runId, n + 1);
      accepted++;
    }
    rejected += Math.max(0, list.length - POLICY.trace.flushBatch);
    return { accepted, rejected };
  }

  /** 調査の集計。新しい順。墓標の付いたものは返さない */
  runs(opts: { limit?: number; since?: number } = {}): RunSummary[] {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const rows = this.sql
      .exec<RunRow>(
        `SELECT * FROM runs WHERE started_at >= ? AND run_id NOT IN (SELECT run_id FROM tombstones) ORDER BY started_at DESC LIMIT ?`,
        opts.since ?? 0,
        limit,
      )
      .toArray();
    return rows.map(toSummary);
  }

  /**
   * 今日（JST）の調査（View の「今日」。docs/05 §3）。started は今日始まった数、running は終わりの記録がなく
   * runningWindowMs 以内に事象が届いているもの、recent は新しい順に recentRuns 件
   */
  today(now = Date.now()): { date: string; started: number; running: RunSummary[]; recent: RunSummary[] } {
    const JST = 9 * 3_600_000;
    const dayStart = Math.floor((now + JST) / 86_400_000) * 86_400_000 - JST;
    const date = new Date(dayStart + JST).toISOString().slice(0, 10);
    const alive = `run_id NOT IN (SELECT run_id FROM tombstones)`;
    const started = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM runs WHERE started_at >= ? AND ${alive}`, dayStart).one().n;
    const running = this.sql
      .exec<RunRow>(`SELECT * FROM runs WHERE done = 0 AND last_at >= ? AND ${alive} ORDER BY started_at DESC LIMIT 50`, now - POLICY.view.runningWindowMs)
      .toArray()
      .map(toSummary);
    const recent = this.sql.exec<RunRow>(`SELECT * FROM runs WHERE ${alive} ORDER BY started_at DESC LIMIT ?`, POLICY.view.recentRuns).toArray().map(toSummary);
    return { date, started, running, recent };
  }

  /** 1つの調査の集計と事象（View の「調査の流れ」）。墓標が付いていれば null と空 */
  run(runId: string): { summary: RunSummary | null; events: TraceEvent[] } {
    if (this.forgotten(runId)) return { summary: null, events: [] };
    const row = this.sql.exec<RunRow>(`SELECT * FROM runs WHERE run_id = ?`, runId).toArray()[0];
    return { summary: row ? toSummary(row) : null, events: this.events(runId) };
  }

  /** 1つの調査の事象（届いた順ではなく、調査の中の順）。墓標が付いていれば空 */
  events(runId: string): TraceEvent[] {
    if (this.forgotten(runId)) return [];
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM events WHERE run_id = ? ORDER BY ev, seq`, runId)
      .toArray()
      .map((r) => JSON.parse(r.json) as TraceEvent);
  }

  /** JSONL で書き出す（ledger_export と同じ形）。墓標の付いた調査は出さない。墓標そのものは最後に出す */
  exportJsonl(opts: { runId?: string } = {}): string {
    const lines: string[] = [];
    const rows = opts.runId
      ? this.sql.exec<{ json: string }>(
          `SELECT json FROM events WHERE run_id = ? AND run_id NOT IN (SELECT run_id FROM tombstones) ORDER BY ev, seq`,
          opts.runId,
        )
      : this.sql.exec<{ json: string }>(`SELECT json FROM events WHERE run_id NOT IN (SELECT run_id FROM tombstones) ORDER BY seq`);
    for (const r of rows) lines.push(r.json);
    for (const t of this.sql.exec(`SELECT * FROM tombstones ORDER BY at`)) lines.push(JSON.stringify({ type: "tombstone", ...t }));
    return lines.join("\n");
  }

  /** 調査の記録を取り消す（墓標を追記する。V-09） */
  forget(runId: string, reason?: string): { ok: boolean } {
    if (!runId) return { ok: false };
    this.sql.exec(`INSERT INTO tombstones (run_id, at, reason) VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING`, runId, Date.now(), reason ?? null);
    return { ok: true };
  }
}

export function traceStub(env: Env): DurableObjectStub<TraceDO> {
  return env.TRACE.get(env.TRACE.idFromName("trace"));
}
