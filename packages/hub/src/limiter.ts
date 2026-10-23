import { DurableObject } from "cloudflare:workers";
import { hostPolicy, POLICY, type HostPolicy } from "@ai-research/policy";
import type { Env } from "./env.ts";
import { sleep, timeScale } from "./time.ts";

/**
 * 頻度制限（docs/03 §2.6.5、specs/limiter.qnt）。取得先ホストごとに1つ。
 *
 *   INV-6 同じホストへの取得の開始時刻は、全機械を通して minIntervalMs 以上あく
 *   INV-7 同時に有効な許可証は maxConcurrent 以下
 *
 * 開始時刻は DO が割り当てる。DO の中の時刻はすべて実時間（ミリ秒）。
 * 試験で時間を縮めたとき（TEST_TIME_SCALE）は、方針の間隔も同じ割合で縮める。
 */
type Lease = { leaseId: string; startAt: number; expiresAt: number };

export type AcquireResult = { granted: true; leaseId: string; startAt: number; now: number } | { granted: false; retryAfterMs: number };

export class HostLimiterDO extends DurableObject<Env> {
  private leases: Lease[] = [];
  private lastStart = Number.NEGATIVE_INFINITY;
  private starts: number[] = [];
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const s = await this.ctx.storage.get<{ leases: Lease[]; lastStart: number; starts: number[] }>("state");
    if (s) {
      this.leases = s.leases;
      this.lastStart = s.lastStart;
      this.starts = s.starts;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("state", { leases: this.leases, lastStart: this.lastStart, starts: this.starts.slice(-200) });
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
    const startAt = Math.max(now, this.lastStart + minInterval);
    const lease: Lease = { leaseId: crypto.randomUUID(), startAt, expiresAt: startAt + ttlMs * scale };
    this.leases.push(lease);
    this.lastStart = startAt;
    this.starts.push(startAt);
    await this.save();
    return { granted: true, leaseId: lease.leaseId, startAt, now };
  }

  async release(leaseId: string): Promise<void> {
    await this.load();
    const before = this.leases.length;
    this.leases = this.leases.filter((l) => l.leaseId !== leaseId);
    if (this.leases.length !== before) await this.save();
  }

  /** 試験と点検用：これまでに割り当てた開始時刻 */
  async history(): Promise<{ starts: number[]; active: number; scale: number }> {
    await this.load();
    return { starts: [...this.starts], active: this.leases.length, scale: timeScale(this.env) };
  }
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
