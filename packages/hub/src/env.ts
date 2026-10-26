import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { LedgerDO } from "./ledger.ts";
import type { RunDO } from "./run.ts";
import type { HostLimiterDO } from "./limiter.ts";
import type { RouteDO } from "./route.ts";
import type { TraceDO } from "./trace.ts";

export interface Env {
  LEDGER: DurableObjectNamespace<LedgerDO>;
  RUNS: DurableObjectNamespace<RunDO>;
  LIMITER: DurableObjectNamespace<HostLimiterDO>;
  /** 経路の判断（フックの受け口） */
  ROUTE: DurableObjectNamespace<RouteDO>;
  /** 調査の記録（docs/05）。見るためのもので、調査の結果には影響しない */
  TRACE: DurableObjectNamespace<TraceDO>;
  LOADER: WorkerLoader;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** 利用者本人だけが知る合言葉（OAuth の同意ページで確かめる） */
  OWNER_PASSPHRASE?: string;
  /** brave | tavily | none */
  SEARCH_PROVIDER?: string;
  BRAVE_API_KEY?: string;
  TAVILY_API_KEY?: string;
  GITHUB_TOKEN?: string;
  /** 試験用：外への取得をこのサービスに向ける（偽の取得先サーバー） */
  TEST_UPSTREAM?: Fetcher;
  /** 試験用：時間の縮尺（1 なら実時間。0.01 なら 100 倍速） */
  TEST_TIME_SCALE?: string;
  /** 試験用：方針の時間上限の一部を差し替える（JSON。例 {"fetchMs":20000}） */
  TEST_DEADLINES?: string;
  /** 試験用：予算の上限の縮尺（1 なら方針どおり） */
  TEST_CAP_SCALE?: string;
  /** OpenAlex のキー（抄録の索引と公開の版。なければ使わない。設計 v1.5 §8.3.4） */
  OPENALEX_API_KEY?: string;
  /** 連絡先（Crossref の polite pool と Unpaywall に送る。利用者が許した 2026-10-26。E-04） */
  CONTACT_EMAIL?: string;
  /** 試験用：記録の書き込みを失敗させる（C-03 の試験） */
  TEST_TRACE_FAIL?: string;
  /** 試験用：429・503 の冷却をしない */
  TEST_NO_BACKOFF?: string;
}
