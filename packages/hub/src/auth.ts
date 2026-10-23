import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.ts";

/**
 * OAuth の同意ページ。利用者本人だけが知る合言葉（OWNER_PASSPHRASE）を確かめてから許可する（E-01：公開の経路を作らない）。
 */
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function page(body: string, headers?: Headers, status = 200): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ai-research</title>${body}`, {
    status,
    headers: h,
  });
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const req = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(req);
      const consent = await oauth.beginConsent(req);
      return page(
        `<h1>${escape(details.clientName)} に ai-research の利用を許可しますか？</h1>
<p>アクセス権は <strong>${escape(details.redirectHost)}</strong> に送られます。</p>
${details.redirectIsLoopback ? "<p><strong>この PC のアプリに送られます。</strong>いま自分で始めた接続のときだけ続けてください。</p>" : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  ${details.scope.map((s) => `<input type="hidden" name="scope" value="${escape(s)}">`).join("")}
  <p><label>合言葉 <input type="password" name="passphrase" autocomplete="current-password" required></label></p>
  <p><button name="decision" value="approve">許可</button> <button name="decision" value="deny">拒否</button></p>
</form>`,
        consent.headers,
      );
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const expected = env.OWNER_PASSPHRASE;
      if (!expected || !(await timingSafeEqual(String(form.get("passphrase") ?? ""), expected))) {
        return page("<p>合言葉が違います。接続をやり直してください。</p>", undefined, 403);
      }
      const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: {},
        scope: approved.request.scope,
        props: { userId: "owner" },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method Not Allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return page(`<p>${escape(error.description)}</p>`, undefined, 400);
    throw error;
  }
}
