import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { handleMcp } from "../src/mcp.ts";
import { ledger } from "./helpers.ts";

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
    expect(r.body!.result.instructions).toContain("research.start");
  });

  it("tools/list：code と台帳の3つ", async () => {
    const r = await rpc("tools/list");
    const names = (r.body!.result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["code", "ledger_export", "ledger_forget", "ledger_search"]);
  });

  it("code mode：実行環境（Worker Loader）から research.* を呼べる（Known Unknown の確認）", async () => {
    const r = await code(`async () => {
      const b = await research.start({ question: "取得先の制限", queries: ["limits"] });
      const p = b.passages.find((x) => x.text.includes("3秒に1回"));
      const v = await research.verify(b.runId, [{ text: "arXiv は3秒に1回", cite: [{ passageId: p.passageId, quote: "3秒に1回、同時接続1本まで" }] }]);
      return { passages: b.passages.length, status: v.statuses[0].status, hits: (await ledger.search("同時接続")).length };
    }`);
    expect(r.isError).toBe(false);
    expect(r.value.passages).toBeGreaterThan(0);
    expect(r.value.status).toBe("確認済");
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
  it("トークンなしの /mcp は 401 で、資源のメタデータを示す", async () => {
    const r = await rpc("tools/list", {}, { via: "self" });
    expect(r.status).toBe(401);
    const www = r.res.headers.get("WWW-Authenticate") ?? "";
    expect(www).toContain("resource_metadata");
    const metaUrl = /resource_metadata="([^"]+)"/.exec(www)![1]!;
    const meta = await SELF.fetch(metaUrl);
    expect(((await meta.json()) as { resource: string }).resource).toBe("https://hub.test/mcp");
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
    expect((r.body!.result.tools as unknown[]).length).toBe(4);
  });
});
