import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CODE_TOOL_DESCRIPTION, INSTRUCTIONS, POLICY } from "@ai-research/policy";
import type { Executor } from "@cloudflare/codemode";
import type { Env } from "./env.ts";
import { ledgerStub } from "./ledger.ts";
import { providers, makeExecutor } from "./sandbox.ts";

const MAX_RESULT_CHARS = 60_000;

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (s.length > MAX_RESULT_CHARS) s = `${s.slice(0, MAX_RESULT_CHARS)}\n…（${s.length - MAX_RESULT_CHARS} 文字を省略）`;
  return { content: [{ type: "text", text: s }] };
}

/** MCP サーバー（docs/03 §2.2）。道具は code と台帳の3つ */
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
      if (r.error) return { ...text({ error: r.error, logs: r.logs ?? [] }), isError: true };
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

  return server;
}

/** Streamable HTTP（状態を持たない）。要求ごとにサーバーを作る */
export async function handleMcp(request: Request, env: Env, opts: { executor?: Executor; client?: string } = {}): Promise<Response> {
  const server = buildServer(env, opts);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
