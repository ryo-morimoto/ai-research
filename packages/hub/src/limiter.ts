import { DurableObject } from "cloudflare:workers";
import { hostPolicy, POLICY, type HostPolicy } from "@ai-research/policy";
import type { Env } from "./env.ts";
import { sleep, timeScale } from "./time.ts";
import { timed } from "./obs.ts";

/**
 * 頻度制限（docs/03 §2.6.5、specs/limiter.qnt）。取得先ホストごとに1つ。
 *
 *   INV-6 同じホストへの取得の開始時刻は、全機械を通して minIntervalMs 以上あく
 *   INV-7 同時に有効な許可証は maxConcurrent 以下
 *
 * 開始時刻は DO が割り当てる。DO の中の時刻はすべて実時間（ミリ秒）。
 * 保存するのは間隔の判断に要る lastStart（と記録）だけ。許可証は期限つきなのでメモリだけに持ち、
 * 返すときに書き込まない（1回の取得あたりの書き込みを1回にする）。
 * 試験で時間を縮めたとき（TEST_TIME_SCALE）は、方針の間隔も同じ割合で縮める。
 */
type Lease = { leaseId: string; startAt: number; expiresAt: number };

export type AcquireResult = { granted: true; leaseId: string; startAt: number; now: number } | { granted: false; retryAfterMs: number };

export class HostLimiterDO extends DurableObject<Env> {
  private leases: Lease[] = [];
  private lastStart = Number.NEGATIVE_INFINITY;
  /** 取得先に間を空けるよう求められた（429・503）ときの、再開の時刻（実時間。設計 v1.5 §8.3.5） */
  private cooldownUntil = 0;
  private starts: number[] = [];
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const s = await timed("limiter.load", () => this.ctx.storage.get<{ lastStart: number; starts: number[]; cooldownUntil?: number }>("state"));
    if (s) {
      this.lastStart = s.lastStart;
      this.starts = s.starts;
      this.cooldownUntil = s.cooldownUntil ?? 0;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const state = { lastStart: this.lastStart, starts: this.starts.slice(-200), cooldownUntil: this.cooldownUntil };
    await timed("limiter.save", () => this.ctx.storage.put("state", state));
  }

  async acquire(policy: HostPolicy, ttlMs: number): Promise<AcquireResult> {
    await this.load();
    const now = Date.now();
    const scale = timeScale(this.env);
    const minInterval = policy.minIntervalMs * scale;
    // 期限切れの許可証を回収する（機械が落ちても回収される）
    this.leases = this.leases.filter((l) => l.expiresAt > now);
    if (this.leases.length >= policy.maxConcurrent) {
      const soonest = Math.min(...this.leases.map((l) => l.expiresAt));
      return { granted: false, retryAfterMs: Math.max(1, Math.min(soonest - now, 1_000 * scale)) };
    }
    const startAt = Math.max(now, this.lastStart + minInterval, this.cooldownUntil);
    const lease: Lease = { leaseId: crypto.randomUUID(), startAt, expiresAt: startAt + ttlMs * scale };
    this.leases.push(lease);
    this.lastStart = startAt;
    this.starts.push(startAt);
    await this.save();
    return { granted: true, leaseId: lease.leaseId, startAt, now };
  }

  /** 取得先が間を空けるよう求めた。ms（方針の時間）のあいだ、全体でその取得先への取得を止める。再開の時刻（実時間）を返す */
  async cooldown(ms: number): Promise<number> {
    await this.load();
    const until = Date.now() + ms * timeScale(this.env);
    if (until > this.cooldownUntil) {
      this.cooldownUntil = until;
      await this.save();
    }
    return this.cooldownUntil;
  }

  async release(leaseId: string): Promise<void> {
    await this.load();
    this.leases = this.leases.filter((l) => l.leaseId !== leaseId);
  }

  /** 試験と点検用：これまでに割り当てた開始時刻 */
  async history(): Promise<{ starts: number[]; active: number; scale: number }> {
    await this.load();
    return { starts: [...this.starts], active: this.leases.length, scale: timeScale(this.env) };
  }
}

/**
 * 取得先が 429・503 を返したときの冷却（設計 v1.5 §8.3.5）。Retry-After（秒か日時）に従う。なければ既定、上限つき。
 * 返すのは冷却の長さ（方針の時間）と再開の時刻
 */
export async function cooldownHost(env: Env, host: string, retryAfter: string | null): Promise<{ ms: number; until: number }> {
  const P = POLICY.backoff;
  let ms: number = P.defaultMs;
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec)) ms = sec * 1_000;
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) ms = at - Date.now();
    }
  }
  ms = Math.min(P.maxMs, Math.max(P.minMs, ms));
  const stub = env.LIMITER.get(env.LIMITER.idFromName(host.toLowerCase()));
  return { ms, until: await stub.cooldown(ms) };
}

export class LeaseTimeout extends Error {
  constructor(host: string) {
    super(`許可証を待つ時間が上限を超えた: ${host}`);
  }
}

/**
 * 許可証を取ってから fn を実行する。開始時刻まで待ち、終わったら返す。
 * waitLimitMs（方針の時間）を過ぎても許可されなければ LeaseTimeout。
 */
export async function withLease<T>(
  env: Env,
  host: string,
  fn: () => Promise<T>,
  opts: { waitLimitMs: number; signal?: AbortSignal },
): Promise<T> {
  const policy = hostPolicy(host);
  const stub = env.LIMITER.get(env.LIMITER.idFromName(host.toLowerCase()));
  const scale = timeScale(env);
  const startedAt = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const r = await stub.acquire(policy, POLICY.leaseTtlMs);
    if (r.granted) {
      const wait = r.startAt - r.now; // 実時間
      if (wait > opts.waitLimitMs * scale) {
        await stub.release(r.leaseId);
        throw new LeaseTimeout(host);
      }
      await sleep(wait / scale, env, opts.signal);
      try {
        return await fn();
      } finally {
        await stub.release(r.leaseId);
      }
    }
    const waited = Date.now() - startedAt; // 実時間
    if (waited + r.retryAfterMs > opts.waitLimitMs * scale) throw new LeaseTimeout(host);
    await sleep(r.retryAfterMs / scale, env, opts.signal);
  }
}
