import { DurableObject } from "cloudflare:workers";
import type { VerifiedExcerpt, Volatility, Fingerprint, SourceKind } from "@ai-research/core";
import type { Env } from "./env.ts";

/**
 * 台帳（docs/03 §2.4.1）。利用者全体で1つ（idFromName("ledger")）。
 *
 * 不変条件：
 *   INV-1 抜き書きは、照合器が作った VerifiedExcerpt からしか書かれない（型と依存の規則）
 *   INV-2 追記のみ。UPDATE はしない。DELETE は purge だけ
 *   INV-3 墓標の付いたものは、それ以降の検索に出ない
 *   INV-4 検索は snapshotSeq までしか読まない
 */
export type LedgerRecord = {
  seq: number;
  recordId: string;
  kind: SourceKind;
  url: string;
  title: string | null;
  locator: string;
  excerpt: string;
  ctxBefore: string;
  ctxAfter: string;
  fingerprint: Fingerprint;
  verifiedAt: string;
  volatility: Volatility;
  originRun: string;
};

type Row = {
  seq: number;
  record_id: string;
  kind: string;
  url: string;
  title: string | null;
  locator: string;
  excerpt: string;
  ctx_before: string;
  ctx_after: string;
  fp_etag: string | null;
  fp_last_modified: string | null;
  fp_text_hash: string | null;
  fp_commit: string | null;
  fp_arxiv_version: string | null;
  verified_at: string;
  volatility: string;
  origin_run: string;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO seq_counter (id, next) VALUES (1, 1)`,
  `CREATE TABLE IF NOT EXISTS records (
     seq INTEGER PRIMARY KEY,
     record_id TEXT UNIQUE NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('web','github','arxiv')),
     url TEXT NOT NULL,
     title TEXT,
     locator TEXT NOT NULL,
     excerpt TEXT NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 300),
     ctx_before TEXT NOT NULL CHECK (length(ctx_before) <= 50),
     ctx_after TEXT NOT NULL CHECK (length(ctx_after) <= 50),
     fp_etag TEXT, fp_last_modified TEXT, fp_text_hash TEXT, fp_commit TEXT, fp_arxiv_version TEXT,
     verified_at TEXT NOT NULL,
     volatility TEXT NOT NULL CHECK (volatility IN ('stable','normal','volatile')),
     origin_run TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS records_url ON records (url)`,
  `CREATE TABLE IF NOT EXISTS tombstones (
     seq INTEGER PRIMARY KEY,
     target_record TEXT,
     target_url TEXT,
     reason TEXT,
     at TEXT NOT NULL,
     CHECK (target_record IS NOT NULL OR target_url IS NOT NULL)
   )`,
];

const FTS_SCHEMA = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(excerpt, title, content='records', content_rowid='seq', tokenize='trigram')`,
  `CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
     INSERT INTO records_fts(rowid, excerpt, title) VALUES (new.seq, new.excerpt, coalesce(new.title, ''));
   END`,
  `CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
     INSERT INTO records_fts(records_fts, rowid, excerpt, title) VALUES ('delete', old.seq, old.excerpt, coalesce(old.title, ''));
   END`,
];

export class LedgerDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private fts = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const s of SCHEMA) this.sql.exec(s);
      try {
        for (const s of FTS_SCHEMA) this.sql.exec(s);
        this.fts = true;
      } catch {
        this.fts = false;
      }
    });
  }

  /** 全文検索が trigram で使えているか（docs/03 §4 の Known Unknown の確認用） */
  hasFts(): boolean {
    return this.fts;
  }

  /** 次に払い出す番号の1つ前（＝これまでの最大の番号） */
  currentSeq(): number {
    const row = this.sql.exec<{ next: number }>(`SELECT next FROM seq_counter WHERE id = 1`).one();
    return row.next - 1;
  }

  private allocSeq(): number {
    const row = this.sql.exec<{ next: number }>(`SELECT next FROM seq_counter WHERE id = 1`).one();
    this.sql.exec(`UPDATE seq_counter SET next = next + 1 WHERE id = 1`);
    return row.next;
  }

  /**
   * 照合器を通った抜き書きを追記する（INV-1、INV-2）。
   * 同じ URL・同じ抜き書き・同じ指紋のレコードが既にあれば、それを返す。
   */
  appendVerified(ve: VerifiedExcerpt, volatility: Volatility, originRun: string): { recordId: string; seq: number } {
    const fp = ve.fingerprint;
    const existing = this.sql
      .exec<{ record_id: string; seq: number }>(
        `SELECT record_id, seq FROM records WHERE url = ? AND excerpt = ? AND coalesce(fp_text_hash,'') = ? AND coalesce(fp_commit,'') = ? AND coalesce(fp_arxiv_version,'') = ? ORDER BY seq DESC LIMIT 1`,
        ve.source.url,
        ve.excerpt,
        fp.textHash ?? "",
        fp.commit ?? "",
        fp.arxivVersion ?? "",
      )
      .toArray()[0];
    if (existing && !this.isTombstoned(existing.record_id, ve.source.url, Number.MAX_SAFE_INTEGER, existing.seq)) {
      return { recordId: existing.record_id, seq: existing.seq };
    }
    const seq = this.allocSeq();
    const recordId = `r_${seq.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
    this.sql.exec(
      `INSERT INTO records (seq, record_id, kind, url, title, locator, excerpt, ctx_before, ctx_after,
         fp_etag, fp_last_modified, fp_text_hash, fp_commit, fp_arxiv_version, verified_at, volatility, origin_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      recordId,
      ve.source.kind,
      ve.source.url,
      ve.source.title ?? null,
      ve.source.locator,
      ve.excerpt,
      ve.ctxBefore,
      ve.ctxAfter,
      fp.etag ?? null,
      fp.lastModified ?? null,
      fp.textHash ?? null,
      fp.commit ?? null,
      fp.arxivVersion ?? null,
      ve.verifiedAt,
      volatility,
      originRun,
    );
    return { recordId, seq };
  }

  private isTombstoned(recordId: string, url: string, uptoSeq: number, recordSeq: number): boolean {
    const row = this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM tombstones WHERE seq <= ? AND seq > ? AND (target_record = ? OR target_url = ?)`,
        uptoSeq,
        // 墓標より後に新しく確かめ直したレコードは生きている
        recordSeq,
        recordId,
        url,
      )
      .one();
    return row.n > 0;
  }

  /**
   * 検索（INV-3、INV-4）。snapshotSeq より後のレコードと、snapshotSeq までに墓標が付いたものは返さない。
   */
  search(text: string, opts: { snapshotSeq: number; limit: number }): LedgerRecord[] {
    const q = text.trim();
    let rows: Row[] = [];
    if (q.length === 0) return [];
    if (this.fts && Array.from(q).length >= 3) {
      const terms = q
        .split(/\s+/)
        .filter((t) => Array.from(t).length >= 3)
        .map((t) => `"${t.replace(/"/g, '""')}"`);
      if (terms.length > 0) {
        try {
          rows = this.sql
            .exec<Row>(
              `SELECT r.* FROM records_fts f JOIN records r ON r.seq = f.rowid
               WHERE records_fts MATCH ? AND r.seq <= ? ORDER BY bm25(records_fts) LIMIT ?`,
              terms.join(" OR "),
              opts.snapshotSeq,
              opts.limit * 4,
            )
            .toArray();
        } catch {
          rows = [];
        }
      }
    }
    if (rows.length === 0) {
      const likes = q.split(/\s+/).filter((t) => t.length > 0).slice(0, 8);
      const where = likes.map(() => `(excerpt LIKE ? OR coalesce(title,'') LIKE ? OR url LIKE ?)`).join(" OR ");
      const params = likes.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
      rows = this.sql
        .exec<Row>(`SELECT * FROM records WHERE seq <= ? AND (${where}) ORDER BY seq DESC LIMIT ?`, opts.snapshotSeq, ...params, opts.limit * 4)
        .toArray();
    }
    const out: LedgerRecord[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.seq > opts.snapshotSeq) continue;
      if (this.isTombstoned(r.record_id, r.url, opts.snapshotSeq, r.seq)) continue;
      const key = `${r.url}\u{0}${r.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(toRecord(r));
      if (out.length >= opts.limit) break;
    }
    return out;
  }

  get(recordId: string): LedgerRecord | null {
    const r = this.sql.exec<Row>(`SELECT * FROM records WHERE record_id = ?`, recordId).toArray()[0];
    return r ? toRecord(r) : null;
  }

  /** 取り消し（墓標の追記、U-02） */
  forget(target: { recordId?: string; url?: string; reason?: string }): { seq: number } {
    if (!target.recordId && !target.url) throw new Error("recordId か url が要る");
    const seq = this.allocSeq();
    this.sql.exec(
      `INSERT INTO tombstones (seq, target_record, target_url, reason, at) VALUES (?, ?, ?, ?, ?)`,
      seq,
      target.recordId ?? null,
      target.url ?? null,
      target.reason ?? null,
      new Date().toISOString(),
    );
    return { seq };
  }

  /** 物理的な消去（誤って長く残したときなど）。INV-2 の唯一の例外 */
  purge(recordId: string): { deleted: number } {
    const before = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM records WHERE record_id = ?`, recordId).one().n;
    this.sql.exec(`DELETE FROM records WHERE record_id = ?`, recordId);
    return { deleted: before };
  }

  /** JSONL での書き出し（U-02） */
  exportJsonl(): string {
    const lines: string[] = [];
    for (const r of this.sql.exec<Row>(`SELECT * FROM records ORDER BY seq`)) lines.push(JSON.stringify({ type: "record", ...toRecord(r) }));
    for (const t of this.sql.exec(`SELECT * FROM tombstones ORDER BY seq`)) lines.push(JSON.stringify({ type: "tombstone", ...t }));
    return lines.join("\n");
  }

  /** 試験と点検用：全件 */
  all(): LedgerRecord[] {
    return this.sql.exec<Row>(`SELECT * FROM records ORDER BY seq`).toArray().map(toRecord);
  }
}

function toRecord(r: Row): LedgerRecord {
  const fingerprint: Fingerprint = {};
  if (r.fp_etag) fingerprint.etag = r.fp_etag;
  if (r.fp_last_modified) fingerprint.lastModified = r.fp_last_modified;
  if (r.fp_text_hash) fingerprint.textHash = r.fp_text_hash;
  if (r.fp_commit) fingerprint.commit = r.fp_commit;
  if (r.fp_arxiv_version) fingerprint.arxivVersion = r.fp_arxiv_version;
  return {
    seq: r.seq,
    recordId: r.record_id,
    kind: r.kind as SourceKind,
    url: r.url,
    title: r.title,
    locator: r.locator,
    excerpt: r.excerpt,
    ctxBefore: r.ctx_before,
    ctxAfter: r.ctx_after,
    fingerprint,
    verifiedAt: r.verified_at,
    volatility: r.volatility as Volatility,
    originRun: r.origin_run,
  };
}

export function ledgerStub(env: Env): DurableObjectStub<LedgerDO> {
  return env.LEDGER.get(env.LEDGER.idFromName("ledger"));
}
