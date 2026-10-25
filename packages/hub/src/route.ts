import { DurableObject } from "cloudflare:workers";
import { POLICY, ROUTE_ALLOW_CONTEXT, ROUTE_DENY_REASON } from "@ai-research/policy";
import type { Env } from "./env.ts";

/**
 * 経路の判断（制約 v0.6 U-03・Q-07、設計 v1.2 §7.6）。
 *
 * Claude Code / Cowork の http フックから呼ばれる受け口と、その状態を持つ DO。
 * - 止める・通すの判断はここだけで行う（D8。機械には判断の版を置かない）
 * - 覚えるのは、会話ごとの「明示」の印と、ai-research で取れなかった URL と、回数だけ。依頼文は保存しない
 * - 受け口が失敗すると、http フックは止めない側に倒れる（ハブに届かないときは組み込みの検索が動く）
 */

export type RouteDecision =
  | { kind: "deny"; reason: string }
  | { kind: "allow"; why: "explicit" | "cutoff" | "noConnector" | "searchDown"; context: string }
  | { kind: "pass" };

type Counts = {
  denied: number;
  allowedExplicit: number;
  allowedCutoff: number;
  allowedNoConnector: number;
  allowedSearchDown: number;
  passed: number;
  researchStarts: number;
};
type DayCounts = Record<string, Counts>;

const zero = (): Counts => ({ denied: 0, allowedExplicit: 0, allowedCutoff: 0, allowedNoConnector: 0, allowedSearchDown: 0, passed: 0, researchStarts: 0 });
const dayOf = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10); // JST の日付

const EXPLICIT = POLICY.routing.explicitPatterns.map((p) => new RegExp(p, "u"));
const CONNECTOR_TOOL = new RegExp(POLICY.routing.connectorToolPattern, "i");

/** ai-research の道具か（面によって接頭辞が違う） */
export function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL.test(name);
}

/** ツール検索の結果に ai-research の道具が含まれているか */
export function toolSearchFoundConnector(response: unknown): boolean {
  const s = typeof response === "string" ? response : JSON.stringify(response ?? "");
  return /mcp__[^"\s]*ai-?research[^"\s]*__/i.test(s);
}

/** 依頼文がウェブ検索を明示しているか（policy の言い方に当てる） */
export function isExplicitWebRequest(prompt: string): boolean {
  const t = prompt.normalize("NFKC").toLowerCase();
  return EXPLICIT.some((r) => r.test(t));
}

/** URL を比べる形（フラグメントと末尾の / を落とす） */
export function urlKey(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    let s = x.toString();
    if (s.endsWith("/") && x.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

export class RouteDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS explicit (session TEXT PRIMARY KEY, on_flag INTEGER NOT NULL, expires INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS cutoffs (url TEXT PRIMARY KEY, why TEXT NOT NULL, expires INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS counts (day TEXT PRIMARY KEY, json TEXT NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS no_connector (session TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS search_down (id INTEGER PRIMARY KEY CHECK (id = 1), expires INTEGER NOT NULL)`);
    });
  }

  private prune(now: number): void {
    this.sql.exec(`DELETE FROM explicit WHERE expires <= ?`, now);
    this.sql.exec(`DELETE FROM cutoffs WHERE expires <= ?`, now);
    this.sql.exec(`DELETE FROM no_connector WHERE expires <= ?`, now);
    this.sql.exec(`DELETE FROM search_down WHERE expires <= ?`, now);
    const n = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM explicit`).one().n;
    if (n > POLICY.routing.maxSessions) {
      this.sql.exec(`DELETE FROM explicit WHERE session IN (SELECT session FROM explicit ORDER BY expires ASC LIMIT ?)`, n - POLICY.routing.maxSessions);
    }
  }

  private bump(key: keyof Counts, now = Date.now()): void {
    const day = dayOf(now);
    const row = this.sql.exec<{ json: string }>(`SELECT json FROM counts WHERE day = ?`, day).toArray()[0];
    const c: Counts = row ? { ...zero(), ...(JSON.parse(row.json) as Counts) } : zero();
    c[key] += 1;
    this.sql.exec(`INSERT INTO counts (day, json) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET json = excluded.json`, day, JSON.stringify(c));
  }

  /** UserPromptSubmit：その回の依頼が明示しているかを覚える（次の依頼で上書きされる） */
  notePrompt(session: string, explicit: boolean): void {
    const now = Date.now();
    this.prune(now);
    this.sql.exec(
      `INSERT INTO explicit (session, on_flag, expires) VALUES (?, ?, ?) ON CONFLICT(session) DO UPDATE SET on_flag = excluded.on_flag, expires = excluded.expires`,
      session,
      explicit ? 1 : 0,
      now + POLICY.routing.explicitTtlMs,
    );
  }

  /** RunDO から：ai-research で取れなかった URL を覚える */
  noteCutoff(url: string, why: string): void {
    if (!(POLICY.routing.cutoffAllowReasons as readonly string[]).includes(why)) return;
    const now = Date.now();
    this.prune(now);
    this.sql.exec(
      `INSERT INTO cutoffs (url, why, expires) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET why = excluded.why, expires = excluded.expires`,
      urlKey(url),
      why,
      now + POLICY.routing.cutoffTtlMs,
    );
  }

  /** PostToolUse：ツール検索で ai-research が見つからなかった／ai-research の道具を使えた */
  noteConnector(session: string, available: boolean): void {
    const now = Date.now();
    this.prune(now);
    if (available) this.sql.exec(`DELETE FROM no_connector WHERE session = ?`, session);
    else
      this.sql.exec(
        `INSERT INTO no_connector (session, expires) VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET expires = excluded.expires`,
        session,
        now + POLICY.routing.noConnectorTtlMs,
      );
  }

  /** RunDO から：ai-research の検索が使えなかった（検索サービスの失敗・未設定。設計 v1.4 §8.2.4） */
  noteSearchDown(): void {
    const now = Date.now();
    this.prune(now);
    this.sql.exec(
      `INSERT INTO search_down (id, expires) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET expires = excluded.expires`,
      now + POLICY.routing.searchDownTtlMs,
    );
  }

  noteResearchStart(): void {
    this.bump("researchStarts");
  }

  /** PreToolUse：止めるか通すか（規則は設計 v1.2 §7.6 の順） */
  decide(input: { session: string; tool: string; url?: string }): RouteDecision {
    const now = Date.now();
    if (!(POLICY.routing.offPathTools as readonly string[]).includes(input.tool)) {
      this.bump("passed", now);
      return { kind: "pass" };
    }
    const ex = this.sql
      .exec<{ on_flag: number }>(`SELECT on_flag FROM explicit WHERE session = ? AND expires > ?`, input.session, now)
      .toArray()[0];
    if (ex?.on_flag === 1) {
      this.bump("allowedExplicit", now);
      return { kind: "allow", why: "explicit", context: ROUTE_ALLOW_CONTEXT.explicit };
    }
    if (input.url && (POLICY.routing.fetchTools as readonly string[]).includes(input.tool)) {
      const c = this.sql.exec(`SELECT why FROM cutoffs WHERE url = ? AND expires > ?`, urlKey(input.url), now).toArray()[0];
      if (c) {
        this.bump("allowedCutoff", now);
        return { kind: "allow", why: "cutoff", context: ROUTE_ALLOW_CONTEXT.cutoff };
      }
    }
    if (!(POLICY.routing.fetchTools as readonly string[]).includes(input.tool)) {
      const down = this.sql.exec(`SELECT 1 FROM search_down WHERE expires > ?`, now).toArray()[0];
      if (down) {
        this.bump("allowedSearchDown", now);
        return { kind: "allow", why: "searchDown", context: ROUTE_ALLOW_CONTEXT.searchDown };
      }
    }
    const nc = this.sql.exec(`SELECT 1 FROM no_connector WHERE session = ? AND expires > ?`, input.session, now).toArray()[0];
    if (nc) {
      this.bump("allowedNoConnector", now);
      return { kind: "allow", why: "noConnector", context: ROUTE_ALLOW_CONTEXT.noConnector };
    }
    this.bump("denied", now);
    return { kind: "deny", reason: ROUTE_DENY_REASON };
  }

  /** 経路率の計数（設計 v1.2 §7.7） */
  stats(days = 14): { day: string; counts: Counts }[] {
    return this.sql
      .exec<{ day: string; json: string }>(`SELECT day, json FROM counts ORDER BY day DESC LIMIT ?`, days)
      .toArray()
      .map((r) => ({ day: r.day, counts: { ...zero(), ...(JSON.parse(r.json) as Counts) } }));
  }
}

export function routeStub(env: Env): DurableObjectStub<RouteDO> {
  return env.ROUTE.get(env.ROUTE.idFromName("route"));
}

// ---- フックの受け口（http） ----------------------------------------------------

type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { url?: unknown; query?: unknown; prompt?: unknown };
  tool_response?: unknown;
  prompt?: string;
};

async function readHookInput(request: Request, maxBytes: number): Promise<HookInput | null> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === "object" ? (j as HookInput) : null;
  } catch {
    return null;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/**
 * POST /hooks/pre-tool-use、/hooks/user-prompt-submit、/hooks/post-tool-use。
 * 応答は command フックと同じ JSON の形（http フックの仕様）。
 * 読めない入力には 400 を返す。http フックでは止めない側に倒れる。
 */
export async function handleHook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const path = new URL(request.url).pathname;
  const input = await readHookInput(
    request,
    path === "/hooks/post-tool-use" ? POLICY.routing.maxPostToolBodyBytes : POLICY.routing.maxBodyBytes,
  );
  if (!input) return json({ error: "bad input" }, 400);
  const session = typeof input.session_id === "string" && input.session_id.length <= 200 ? input.session_id : "";
  const stub = routeStub(env);

  if (path === "/hooks/user-prompt-submit") {
    if (session) await stub.notePrompt(session, isExplicitWebRequest(String(input.prompt ?? "")));
    return json({});
  }

  if (path === "/hooks/post-tool-use") {
    const tool = String(input.tool_name ?? "");
    if (session && isConnectorTool(tool)) await stub.noteConnector(session, true);
    else if (session && (POLICY.routing.toolSearchTools as readonly string[]).includes(tool)) {
      const q = String(input.tool_input?.query ?? "");
      if (/research/i.test(q)) await stub.noteConnector(session, toolSearchFoundConnector(input.tool_response));
    }
    return json({});
  }

  if (path === "/hooks/pre-tool-use") {
    const tool = String(input.tool_name ?? "");
    const url = typeof input.tool_input?.url === "string" ? input.tool_input.url : undefined;
    const d = await stub.decide(url ? { session, tool, url } : { session, tool });
    if (d.kind === "pass") return json({});
    if (d.kind === "allow") {
      return json({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: d.context } });
    }
    return json({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason },
    });
  }

  return new Response("Not Found", { status: 404 });
}
