import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";
import { handleMcp } from "./mcp.ts";
import { authorize } from "./auth.ts";
import { handleHook } from "./route.ts";

export { LedgerDO } from "./ledger.ts";
export { RunDO } from "./run.ts";
export { HostLimiterDO } from "./limiter.ts";
export { RouteDO } from "./route.ts";
export { TraceDO } from "./trace.ts";

/**
 * ai-research のハブ（docs/02 §2）。
 *   /mcp        リモート MCP（OAuth で保護）
 *   /authorize  同意ページ（合言葉）
 *   /hooks/*    Claude Code のフック（http）の受け口。経路の判断だけで、台帳には触れない
 */
export const apiHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ua = request.headers.get("user-agent");
    return handleMcp(request, env, ua ? { client: ua } : {});
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return authorize(request, env);
    if (url.pathname.startsWith("/hooks/")) return handleHook(request, env);
    if (url.pathname === "/") {
      return new Response("ai-research hub. MCP endpoint: /mcp\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

// resourceMetadata.resource は公開 URL に依存するので、最初の要求のオリジンから作る
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: apiHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      // claude.ai の既定（Claude's published identity）は CIMD。DCR は互換のために残す
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["mcp"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "ai-research" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
