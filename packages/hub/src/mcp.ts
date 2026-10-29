import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CODE_TOOL_DESCRIPTION, INSTRUCTIONS, POLICY, VIEW_OPEN_TEXT, VIEW_TOOL_DESCRIPTION } from "@ai-research/policy";
import { PROTOCOL_VERSION, viewHtml } from "@ai-research/view";
import type { Executor } from "@cloudflare/codemode";
import type { Env } from "./env.ts";
import { ledgerStub } from "./ledger.ts";
import { routeStub } from "./route.ts";
import { traceStub } from "./trace.ts";
import { providers, makeExecutor } from "./sandbox.ts";
import { emit } from "./obs.ts";

const MAX_RESULT_CHARS = 60_000;

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  // 字下げしない（字下げと改行だけで結果が重くなる。設計 v1.5 §8.3.7）
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length > MAX_RESULT_CHARS) s = `${s.slice(0, MAX_RESULT_CHARS)}\n…（${s.length - MAX_RESULT_CHARS} 文字を省略）`;
  return { content: [{ type: "text", text: s }] };
}

/** View の HTML は版ごとに変わらないので1回だけ作る */
let viewCache: string | undefined;
function viewDocument(): string {
  viewCache ??= viewHtml({ readTool: POLICY.view.readTool, pollMs: POLICY.view.pollMs, protocolVersion: PROTOCOL_VERSION, appVersion: POLICY.revision });
  return viewCache;
}

/**
 * MCP サーバー（docs/03 §2.2）。道具は code と台帳の3つと経路の計数。
 * 見える化（docs/05、案 C）：モデルに見えるのは開くツール research_view だけ（C-01）。
 * 読むツール trace_read は app 専用（_meta.ui.visibility: ["app"]）で、View からだけ呼ぶ
 */
export function buildServer(env: Env, opts: { executor?: Executor; client?: string } = {}): McpServer {
  const server = new McpServer({ name: POLICY.name, version: POLICY.revision }, { instructions: INSTRUCTIONS });
  const executor = opts.executor ?? makeExecutor(env);

  server.registerTool(
    "code",
    {
      description: CODE_TOOL_DESCRIPTION,
      inputSchema: { code: z.string().describe("async の arrow function として書いた JavaScript") },
    },
    async ({ code }) => {
      const r = await executor.execute(code, providers(env, opts.client));
      if (r.error) {
        // code の失敗を1行残す（issue 001：isError だけでは観測に出なかった）
        emit({ event: "code_error", message: String(r.error).slice(0, 300) });
        return { ...text({ error: r.error, logs: r.logs ?? [] }), isError: true };
      }
      return text(r.logs && r.logs.length ? { result: r.result, logs: r.logs } : r.result);
    },
  );

  server.registerTool(
    "ledger_search",
    {
      description: "台帳（確かめた抜き書き）を検索する。読み取りだけ",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text: q }) => {
      const stub = ledgerStub(env);
      return text(await stub.search(q, { snapshotSeq: await stub.currentSeq(), limit: 20 }));
    },
  );

  server.registerTool(
    "ledger_forget",
    {
      description: "台帳の抜き書きを取り消す（墓標を追記する）。recordId か url を指定する",
      inputSchema: { recordId: z.string().optional(), url: z.string().optional(), reason: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const target: { recordId?: string; url?: string; reason?: string } = {};
      if (args.recordId) target.recordId = args.recordId;
      if (args.url) target.url = args.url;
      if (args.reason) target.reason = args.reason;
      return text(await ledgerStub(env).forget(target));
    },
  );

  server.registerTool(
    "ledger_export",
    { description: "台帳を JSONL で書き出す。読み取りだけ", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text(await ledgerStub(env).exportJsonl()),
  );

  server.registerTool(
    "route_stats",
    {
      description: "経路の計数（日ごと）。組み込みのウェブ検索・取得を止めた回数、例外で通した回数、research.start の回数。読み取りだけ",
      inputSchema: { days: z.number().int().min(1).max(90).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => text(await routeStub(env).stats(days ?? 14)),
  );

  const V = POLICY.view;

  // 開く（モデルが呼ぶ）。返す1行と件数だけ。データは View が trace_read で読む（V-01、C-06）
  server.registerTool(
    V.openTool,
    {
      description: VIEW_TOOL_DESCRIPTION,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: V.resourceUri } },
    },
    async () => {
      const t = await traceStub(env).today();
      return {
        content: [{ type: "text" as const, text: VIEW_OPEN_TEXT }],
        structuredContent: { started: t.started, running: t.running.length },
      };
    },
  );

  // 読む（View だけが呼ぶ）。結果は structuredContent だけ。content は空に近くする（モデルに渡らない側だが、念のため小さく）
  server.registerTool(
    V.readTool,
    {
      description: "View 用。調査の記録を読む",
      inputSchema: {
        view: z.enum(["today", "runs", "run", "gaps", "gapRuns"]),
        id: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        days: z.number().int().min(1).max(365).optional(),
        host: z.string().max(300).optional(),
        why: z.string().max(50).optional(),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ view, id, limit, days, host, why }) => {
      const tr = traceStub(env);
      let data: Record<string, unknown>;
      if (view === "today") data = { view, ...(await tr.today()) };
      else if (view === "runs") data = { view, runs: await tr.runs(limit ? { limit } : {}) };
      else if (view === "gaps") data = { view, ...(await tr.gaps(days ?? 7)) };
      else if (view === "gapRuns") {
        const opts: { host?: string; why?: string; days?: number } = {};
        if (host !== undefined) opts.host = host;
        if (why) opts.why = why;
        if (days) opts.days = days;
        data = { view, host: host ?? null, why: why ?? null, runs: await tr.gapRuns(opts) };
      } else {
        if (!id) return { content: [{ type: "text" as const, text: "id が要る" }], isError: true };
        data = { view, ...(await tr.run(id)) };
      }
      return { content: [{ type: "text" as const, text: "ok" }], structuredContent: data };
    },
  );

  // View の中身（ui:// の resource）。外部を読まない1枚の HTML
  server.registerResource("view", V.resourceUri, { title: "ai-research の調査の記録", mimeType: V.mimeType }, async () => ({
    contents: [{ uri: V.resourceUri, mimeType: V.mimeType, text: viewDocument() }],
  }));

  return server;
}

/** Streamable HTTP（状態を持たない）。要求ごとにサーバーを作る */
export async function handleMcp(request: Request, env: Env, opts: { executor?: Executor; client?: string } = {}): Promise<Response> {
  const server = buildServer(env, opts);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(request);
  // 4xx の理由を1行残す（issue 003：POST /mcp の 400 が理由なしで積もっていた）。
  // Dynamic Worker 側のイベントは観測に乗らないので、ハブのこの1箇所で捕まえる
  if (res.status >= 400 && res.status < 500) {
    const reason = await res.clone().text().catch(() => "");
    emit({ event: "bad_request", path: new URL(request.url).pathname, status: res.status, reason: reason.slice(0, 300) });
  }
  return res;
}
