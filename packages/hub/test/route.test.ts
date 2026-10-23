import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { routeStub, isExplicitWebRequest, urlKey } from "../src/route.ts";
import { env } from "cloudflare:test";
import { run, sleep } from "./helpers.ts";

const U = "https://hub.test";
async function hook(path: string, body: unknown) {
  const r = await SELF.fetch(`${U}/hooks/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as any) : null };
}
const pre = (session: string, tool: string, tool_input: Record<string, unknown> = {}) =>
  hook("pre-tool-use", { session_id: session, hook_event_name: "PreToolUse", tool_name: tool, tool_input });
const prompt = (session: string, text: string) => hook("user-prompt-submit", { session_id: session, hook_event_name: "UserPromptSubmit", prompt: text });

describe("経路の判断（フックの受け口、U-03・Q-07）", () => {
  it("道具を指定しない依頼では、組み込みのウェブ検索・取得を止めて ai-research へ案内する", async () => {
    await prompt("s1", "Cloudflare Durable Objects の上限を調べて");
    for (const tool of ["WebSearch", "WebFetch", "web_search", "web_fetch"]) {
      const r = await pre("s1", tool, { query: "x", url: "https://docs.example.com/limits" });
      expect(r.status).toBe(200);
      expect(r.body.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(r.body.hookSpecificOutput.permissionDecisionReason).toContain("research.start");
    }
  });

  it("利用者がウェブ検索を明示した回だけ通し、経路外と書くよう添える。次の依頼では元に戻る", async () => {
    await prompt("s2", "ウェブ検索で最新の発表を探して");
    const a = await pre("s2", "WebSearch", { query: "x" });
    expect(a.body.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(a.body.hookSpecificOutput.additionalContext).toContain("経路外（利用者の指定）");
    await prompt("s2", "では続きを調べて");
    expect((await pre("s2", "WebSearch", { query: "x" })).body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("明示は会話ごと。別の会話には効かない", async () => {
    await prompt("s3", "WebSearch で探して");
    await prompt("s4", "調べて");
    expect((await pre("s3", "WebSearch")).body.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect((await pre("s4", "WebSearch")).body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("「WebSearch の代わりに」「使わずに」は明示とみなさない", () => {
    expect(isExplicitWebRequest("WebSearch の代わりに ai-research を使って")).toBe(false);
    expect(isExplicitWebRequest("WebSearch を使わずに調べて")).toBe(false);
    expect(isExplicitWebRequest("ai-research を使わずに調べて")).toBe(true);
    expect(isExplicitWebRequest("ＷｅｂＳｅａｒｃｈで探して")).toBe(true); // 全角も NFKC でそろえる
  });

  it("ai-research で取れなかった URL（blocked など）は WebFetch に回せる。方針で禁じた取得先は回さない（E-02）", async () => {
    const id = `run_route_${crypto.randomUUID().slice(0, 6)}`;
    const b = await run(id).start(id, { question: "取れない出典", queries: [], urls: ["https://blocked.example.com/page", "https://www.youtube.com/watch?v=x"] });
    expect(b.cutoffs.map((c) => c.why).sort()).toEqual(["blocked", "policy"]);
    await sleep(50); // waitUntil で書かれるのを待つ
    await prompt("s5", "調べて");
    const ok = await pre("s5", "WebFetch", { url: "https://blocked.example.com/page#top" });
    expect(ok.body.hookSpecificOutput.additionalContext).toContain("経路外（ai-research で取れなかった）");
    const ng = await pre("s5", "WebFetch", { url: "https://www.youtube.com/watch?v=x" });
    expect(ng.body.hookSpecificOutput.permissionDecision).toBe("deny");
    // 取れなかった URL でも、検索には回さない
    expect((await pre("s5", "WebSearch", { query: "https://blocked.example.com/page" })).body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("ツール検索で ai-research が見つからなかった会話では、経路外として通す。ai-research を使えたら元に戻る", async () => {
    await prompt("s11", "調べて");
    expect((await pre("s11", "WebSearch")).body.hookSpecificOutput.permissionDecision).toBe("deny");
    await hook("post-tool-use", { session_id: "s11", hook_event_name: "PostToolUse", tool_name: "ToolSearch", tool_input: { query: "ai-research" }, tool_response: { matches: [], query: "ai-research", total_deferred_tools: 50 } });
    const a = await pre("s11", "WebSearch");
    expect(a.body.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(a.body.hookSpecificOutput.additionalContext).toContain("経路外（ai-research が使えない）");
    // 見つかった・使えた会話では止める
    await hook("post-tool-use", { session_id: "s11", tool_name: "mcp__claude_ai_ai-research__code", tool_input: {}, tool_response: "{}" });
    expect((await pre("s11", "WebSearch")).body.hookSpecificOutput.permissionDecision).toBe("deny");
    await hook("post-tool-use", { session_id: "s12", tool_name: "ToolSearch", tool_input: { query: "select:mcp__ai-research__code" }, tool_response: { matches: ["mcp__ai-research__code"] } });
    expect((await pre("s12", "WebSearch")).body.hookSpecificOutput.permissionDecision).toBe("deny");
    // ai-research と関係のないツール検索では何も変えない
    await hook("post-tool-use", { session_id: "s13", tool_name: "ToolSearch", tool_input: { query: "slack" }, tool_response: { matches: [] } });
    expect((await pre("s13", "WebSearch")).body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("経路の外の道具でなければ何もしない", async () => {
    const r = await pre("s6", "Read", { file_path: "/x" });
    expect(r.body).toEqual({});
  });

  it("読めない入力は 400（http フックでは止めない側に倒れる）。台帳などには届かない", async () => {
    const r = await SELF.fetch(`${U}/hooks/pre-tool-use`, { method: "POST", body: "not json" });
    expect(r.status).toBe(400);
    expect((await SELF.fetch(`${U}/hooks/pre-tool-use`)).status).toBe(405);
    expect((await SELF.fetch(`${U}/hooks/ledger`, { method: "POST", body: "{}" })).status).toBe(404);
    const big = await SELF.fetch(`${U}/hooks/user-prompt-submit`, { method: "POST", body: JSON.stringify({ session_id: "s7", prompt: "あ".repeat(70_000) }) });
    expect(big.status).toBe(400);
  });

  it("依頼文は保存しない。覚えるのは明示の印だけ", async () => {
    await prompt("s8", "秘密のプロジェクト名 ZEBRA について ウェブ検索で 調べて");
    const dump = await (await import("cloudflare:test")).runInDurableObject(routeStub(env), async (_i, state) => {
      const rows = [...state.storage.sql.exec("SELECT * FROM explicit")];
      return JSON.stringify(rows);
    });
    expect(dump).not.toContain("ZEBRA");
    expect(dump).toContain('"on_flag":1');
  });

  it("経路の計数（日ごと）", async () => {
    await prompt("s9", "調べて");
    await pre("s9", "WebSearch");
    await prompt("s10", "ウェブ検索で調べて");
    await pre("s10", "WebSearch");
    const [today] = await routeStub(env).stats(1);
    expect(today!.counts).toMatchObject({ denied: 1, allowedExplicit: 1 });
  });

  it("URL の比べ方：フラグメントと末尾の / を無視する", () => {
    expect(urlKey("https://a.example/x/#y")).toBe("https://a.example/x");
    expect(urlKey("https://a.example/")).toBe("https://a.example/");
  });
});
