import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { handleMcp } from "../src/mcp.ts";
import { ledger } from "./helpers.ts";
import { traceStub } from "../src/trace.ts";

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}, opts: { via?: "direct" | "self"; token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const req = new Request("https://hub.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const res = opts.via === "self" ? await SELF.fetch(req) : await handleMcp(req, env);
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { result?: any; error?: any }) : null, res };
}

async function code(src: string) {
  const r = await rpc("tools/call", { name: "code", arguments: { code: src } });
  const content = r.body?.result?.content?.[0]?.text as string;
  let value: any = content;
  try {
    value = JSON.parse(content);
  } catch {
    // 文字列の結果はそのまま返る
  }
  return { isError: Boolean(r.body?.result?.isError), value };
}

describe("MCP（道具の面）", () => {
  it("initialize：手順の説明（instructions）と道具の能力を返す", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(r.status).toBe(200);
    expect(r.body!.result.serverInfo.name).toBe("ai-research");
    // サーバーの説明文は code の道具を指すだけ（手順は道具の説明文に1か所）
    expect(r.body!.result.instructions).toContain("code の道具");
  });

  it("tools/list：モデルに見える道具は code・台帳の3つ・経路の計数と、開くツール research_view だけ（docs/05 C-01）", async () => {
    const r = await rpc("tools/list");
    type T = { name: string; description?: string; _meta?: { ui?: { visibility?: string[]; resourceUri?: string } } };
    const tools = r.body!.result.tools as T[];
    // 仕様：visibility に model を含まないツールは、ホストがモデルの一覧から外す
    const modelVisible = tools.filter((t) => (t._meta?.ui?.visibility ?? ["model", "app"]).includes("model")).map((t) => t.name).sort();
    expect(modelVisible).toEqual(["code", "ledger_export", "ledger_forget", "ledger_search", "research_view", "route_stats"]);
    const appOnly = tools.filter((t) => !modelVisible.includes(t.name));
    expect(appOnly.map((t) => [t.name, t._meta?.ui?.visibility])).toEqual([["trace_read", ["app"]]]);
    const open = tools.find((t) => t.name === "research_view")!;
    expect(open._meta?.ui?.resourceUri).toBe("ui://ai-research/view");
  });

  it("code mode：実行環境（Worker Loader）から research.* を呼べる（Known Unknown の確認）", async () => {
    const r = await code(`async () => {
      const b = await research.start({ mode: "survey", question: "取得先の制限", queries: ["limits"] });
      const p = b.passages.find((x) => x.text.includes("3秒に1回"));
      const v = await research.verify(b.runId, [{ text: "arXiv は3秒に1回", cite: [{ passageId: p.passageId, quote: "3秒に1回、同時接続1本まで" }] }]);
      return { passages: b.passages.length, status: v.statuses[0].status, hits: (await ledger.search("同時接続")).length };
    }`);
    expect(r.isError).toBe(false);
    expect(r.value.passages).toBeGreaterThan(0);
    expect(r.value.status).toBe("引用確認済");
    expect(r.value.hits).toBe(1);
  });

  it("INV-12：実行環境からは外へ通信できない（取得はハブの関数だけ）", async () => {
    const r = await code(`async () => {
      try { const res = await fetch("https://docs.example.com/limits"); return "fetched " + res.status; }
      catch (e) { return "blocked: " + String(e && e.message || e); }
    }`);
    expect(String(r.value)).toMatch(/^blocked/);
  });

  it("INV-1：実行環境から台帳に直接書く道はない（ledger.* は検索だけ）", async () => {
    const r = await code(`async () => {
      const out = [];
      for (const name of ["append", "appendVerified", "write", "put", "purge", "forget"]) {
        try { await ledger[name]({ excerpt: "arXiv の API は1秒に10回まで", url: "https://x.example/" }); out.push(name + ":wrote"); }
        catch (e) { out.push(name + ":no"); }
      }
      return out;
    }`);
    expect(r.value).toEqual(["append:no", "appendVerified:no", "write:no", "put:no", "purge:no", "forget:no"]);
    expect((await ledger().all()).length).toBe(0);
  });

  it("ledger_forget / ledger_export", async () => {
    const f = await rpc("tools/call", { name: "ledger_forget", arguments: { url: "https://docs.example.com/limits", reason: "試験" } });
    expect(JSON.parse(f.body!.result.content[0].text).seq).toBe(1);
    const e = await rpc("tools/call", { name: "ledger_export", arguments: {} });
    expect(e.body!.result.content[0].text).toContain('"type":"tombstone"');
  });
});

// ---- OAuth（E-01：公開の経路を作らない） ----

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("OAuth", () => {
  it("C-05：トークンなしの /mcp は 401 で、資源のメタデータを示す（記録も台帳も認証の内側）", async () => {
    const r = await rpc("tools/list", {}, { via: "self" });
    expect(r.status).toBe(401);
    const www = r.res.headers.get("WWW-Authenticate") ?? "";
    expect(www).toContain("resource_metadata");
    const metaUrl = /resource_metadata="([^"]+)"/.exec(www)![1]!;
    const meta = await SELF.fetch(metaUrl);
    expect(((await meta.json()) as { resource: string }).resource).toBe("https://hub.test/mcp");
  });

  it("認可サーバーのメタデータ：CIMD と DCR の両方を受け付け、PKCE は S256", async () => {
    const r = await SELF.fetch("https://hub.test/.well-known/oauth-authorization-server");
    const m = (await r.json()) as Record<string, unknown>;
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.registration_endpoint).toBe("https://hub.test/oauth/register");
    expect(m.code_challenge_methods_supported).toContain("S256");
  });

  it("合言葉が違えば許可しない。正しければトークンが出て /mcp を使える", async () => {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = await SELF.fetch("https://hub.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirect,
      scope: "mcp",
      state: "s1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://hub.test/mcp",
    });
    const authUrl = `https://hub.test/authorize?${q}`;

    const consentPage = async () => {
      const page = await SELF.fetch(authUrl);
      expect(page.status).toBe(200);
      const html = await page.text();
      const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
      const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      return { handle: handle.replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(Number(c))), cookie };
    };
    const post = (handle: string, cookie: string, passphrase: string) =>
      SELF.fetch(authUrl, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams({ handle, scope: "mcp", passphrase, decision: "approve" }),
      });

    const c1 = await consentPage();
    expect((await post(c1.handle, c1.cookie, "wrong")).status).toBe(403);

    const c2 = await consentPage();
    const ok = await post(c2.handle, c2.cookie, "correct horse battery staple");
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get("state")).toBe("s1");
    const codeParam = loc.searchParams.get("code")!;

    const tok = await SELF.fetch("https://hub.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: codeParam, redirect_uri: redirect, client_id, code_verifier: verifier }),
    });
    expect(tok.status).toBe(200);
    const { access_token } = (await tok.json()) as { access_token: string };
    const r = await rpc("tools/list", {}, { via: "self", token: access_token });
    expect(r.status).toBe(200);
    expect((r.body!.result.tools as unknown[]).length).toBe(7); // モデルに見える6つと app 専用の trace_read（docs/05）
  });
});

describe("見える化（docs/05、案 C）", () => {
  const callTool = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).body!.result;

  it("V-01・C-06：開くと、モデルに返すのは1行と件数だけ", async () => {
    const r = await callTool("research_view");
    expect(r.content).toEqual([{ type: "text", text: "表示しました" }]);
    expect(Object.keys(r.structuredContent).sort()).toEqual(["running", "started"]);
  });

  it("View の中身は ui:// の resource で、MCP Apps の mimeType の1枚の HTML", async () => {
    const list = (await rpc("resources/list")).body!.result.resources as { uri: string; mimeType: string }[];
    expect(list).toEqual([expect.objectContaining({ uri: "ui://ai-research/view", mimeType: "text/html;profile=mcp-app" })]);
    const read = (await rpc("resources/read", { uri: "ui://ai-research/view" })).body!.result.contents[0];
    expect(read.mimeType).toBe("text/html;profile=mcp-app");
    expect(read.text).toMatch(/^<!doctype html>/);
    expect(read.text).toContain('"readTool":"trace_read"');
  });

  it("trace_read：今日と、1回の調査の流れを structuredContent で返す", async () => {
    const id = "run_view_1";
    const t = Date.now();
    const tr = traceStub(env);
    await tr.append(
      JSON.stringify([
        { type: "run.started", runId: id, at: t, ev: 1, v: 1, question: "見える化の問い", mode: "survey", queries: ["q"] },
        { type: "search.sent", runId: id, at: t + 1, ev: 2, v: 1, query: "q", provider: "web", ok: true, hits: 2 },
      ]),
    );
    const today = (await callTool("trace_read", { view: "today" })).structuredContent;
    expect(today.started).toBe(1);
    expect(today.running.map((x: { runId: string }) => x.runId)).toEqual([id]);
    const flow = (await callTool("trace_read", { view: "run", id })).structuredContent;
    expect(flow.summary).toMatchObject({ runId: id, question: "見える化の問い", done: false });
    expect(flow.events.map((e: { type: string }) => e.type)).toEqual(["run.started", "search.sent"]);
    const missing = await callTool("trace_read", { view: "run" });
    expect(missing.isError).toBe(true);
  });
});
