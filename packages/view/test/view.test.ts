/**
 * View（docs/05 §3）をホストの代わりに動かして確かめる。
 *   handshake  ui/initialize → 応答 → ui/notifications/initialized の順。初期化の前にツールを呼ばない
 *   V-02       「今日」から調査を押すと、その調査の流れを trace_read で読み、版ごとに並べる
 *   V-05       実行中の調査があるときだけ、pollMs ごとに読み直す
 *   C-09       取得した文字列は文字として出す（要素にならない）
 *   C-11       モデルへ書き戻す要求を送らない
 *   #47        JSON-RPC でないメッセージは捨てる
 */
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { PROTOCOL_VERSION, VIEW_SCRIPT, viewHtml, type ViewConfig } from "../src/index.ts";

const cfg: ViewConfig = { readTool: "trace_read", pollMs: 15_000, protocolVersion: PROTOCOL_VERSION, appVersion: "test" };

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any; error?: any };

/** View を1つ起こす。ホストの側（parent）への送信を記録し、ホストからの送信を渡せるようにする */
function boot() {
  const html = viewHtml(cfg);
  const { document } = parseHTML(html);
  const sent: Msg[] = [];
  const listeners: ((ev: { source: unknown; data: unknown }) => void)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const parent = { postMessage: (m: Msg) => sent.push(JSON.parse(JSON.stringify(m))) };
  const window = { parent, addEventListener: (_t: string, fn: (ev: { source: unknown; data: unknown }) => void) => listeners.push(fn) };
  const script = Array.from(document.querySelectorAll("script")).find((s) => !s.getAttribute("type"))!.textContent!;
  runInNewContext(script, {
    window,
    document,
    URL,
    JSON,
    Math,
    Date,
    String,
    Object,
    Promise,
    setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
  });
  const deliver = async (data: unknown, source: unknown = parent) => {
    for (const l of listeners) l({ source, data });
    // Promise の続きを流す
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const last = (method: string) => [...sent].reverse().find((m) => m.method === method);
  const text = () => document.getElementById("app")!.textContent ?? "";
  return { document, sent, timers, deliver, last, text };
}

const run = (over: Record<string, unknown> = {}) => ({
  runId: "run_a",
  startedAt: Date.parse("2026-10-26T10:00:00Z"),
  lastAt: Date.parse("2026-10-26T10:00:05Z"),
  question: "取得先の制限は",
  mode: "survey",
  procedureVersion: "x",
  client: null,
  version: 1,
  done: true,
  doneWhy: "idle",
  sources: 2,
  passages: 3,
  cutoffs: 1,
  verified: 1,
  failedClaims: 0,
  events: 6,
  ...over,
});

async function initialized(v: ReturnType<typeof boot>) {
  const init = v.sent[0]!;
  await v.deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: PROTOCOL_VERSION, hostInfo: { name: "h", version: "1" }, hostCapabilities: {}, hostContext: { theme: "dark" } } });
}

describe("View", () => {
  it("handshake：ui/initialize を送り、応答のあとに initialized を送ってから今日を読む", async () => {
    const v = boot();
    expect(v.sent).toHaveLength(1);
    expect(v.sent[0]).toMatchObject({ method: "ui/initialize", params: { protocolVersion: PROTOCOL_VERSION, appInfo: { name: "ai-research-view" } } });
    await initialized(v);
    const methods = v.sent.map((m) => m.method);
    expect(methods.indexOf("ui/notifications/initialized")).toBeLessThan(methods.indexOf("tools/call"));
    expect(v.last("tools/call")!.params).toEqual({ name: "trace_read", arguments: { view: "today" } });
    expect(v.document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("V-02：今日の一覧から調査を押すと、その調査の流れを版ごとに並べる", async () => {
    const v = boot();
    await initialized(v);
    await v.deliver({ jsonrpc: "2.0", id: v.last("tools/call")!.id, result: { content: [], structuredContent: { view: "today", date: "2026-10-26", started: 1, running: [], recent: [run()] } } });
    expect(v.text()).toContain("今日の調査");
    expect(v.text()).toContain("取得先の制限は");

    const button = v.document.querySelector('[data-run="run_a"]') as unknown as { dispatchEvent: (e: unknown) => void };
    button.dispatchEvent(new (v.document.defaultView as any).Event("click"));
    await v.deliver(null); // 何も届かない（Promise を流すだけ）
    expect(v.last("tools/call")!.params).toEqual({ name: "trace_read", arguments: { view: "run", id: "run_a" } });

    const t0 = run().startedAt;
    const events = [
      { type: "run.started", runId: "run_a", at: t0, ev: 1, v: 1, question: "取得先の制限は", mode: "survey", queries: ["limits"], sources: ["web"] },
      { type: "search.sent", runId: "run_a", at: t0 + 300, ev: 2, v: 1, query: "limits", provider: "web", ok: true, hits: 3 },
      { type: "source.fetched", runId: "run_a", at: t0 + 900, ev: 3, v: 1, sourceId: "s1", url: "https://docs.example.com/x", host: "docs.example.com", tier: "official", title: "Limits", ms: 120 },
      { type: "cutoff", runId: "run_a", at: t0 + 1000, ev: 4, v: 1, what: "https://blocked.example.com/", why: "blocked", host: "blocked.example.com" },
      { type: "run.steered", runId: "run_a", at: t0 + 2000, ev: 5, v: 2, question: "取得先の制限の数値", queries: ["rate limit"] },
      { type: "run.done", runId: "run_a", at: t0 + 5000, ev: 6, v: 2, why: "idle", fetched: 1, failed: 1, elapsedMs: 5000 },
    ];
    await v.deliver({ jsonrpc: "2.0", id: v.last("tools/call")!.id, result: { content: [], structuredContent: { view: "run", summary: run({ version: 2 }), events } } });
    const t = v.text();
    expect(t).toContain("問いの版 1");
    expect(t).toContain("問いの版 2");
    expect(t).toContain("取得先の制限の数値");
    expect(t).toContain("docs.example.com");
    expect(t).toContain("blocked・blocked.example.com");
    expect(v.document.querySelectorAll(".ev")).toHaveLength(events.length);
    // 終わった調査は読み直さない
    expect(v.timers.filter((x) => x.ms === cfg.pollMs)).toHaveLength(0);
    // 大きさをホストに知らせる
    expect(v.last("ui/notifications/size-changed")).toBeUndefined(); // linkedom は高さを持たない（0 なら送らない）
  });

  it("V-05：実行中の調査があるときだけ pollMs ごとに読み直す", async () => {
    const v = boot();
    await initialized(v);
    await v.deliver({ jsonrpc: "2.0", id: v.last("tools/call")!.id, result: { structuredContent: { date: "2026-10-26", started: 1, running: [run({ done: false })], recent: [run({ done: false })] } } });
    expect(v.text()).toContain("実行中");
    // 実行中の調査は「最近の調査」に重ねて出さない
    expect(v.document.querySelectorAll('[data-run="run_a"]')).toHaveLength(1);
    const polls = v.timers.filter((x) => x.ms === cfg.pollMs);
    expect(polls).toHaveLength(1);
    const before = v.sent.filter((m) => m.method === "tools/call").length;
    polls[0]!.fn();
    expect(v.sent.filter((m) => m.method === "tools/call").length).toBe(before + 1);
  });

  it("C-09：取得した文字列は文字として出す（要素にならない）", async () => {
    const v = boot();
    await initialized(v);
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    await v.deliver({ jsonrpc: "2.0", id: v.last("tools/call")!.id, result: { structuredContent: { date: "d", started: 1, running: [], recent: [run({ question: evil })] } } });
    expect(v.text()).toContain(evil);
    expect(v.document.querySelectorAll("#app img, #app script")).toHaveLength(0);
  });

  it("ツールの失敗は、その理由ともう一度のボタンで出す。ボタンは読み直す", async () => {
    const v = boot();
    await initialized(v);
    await v.deliver({ jsonrpc: "2.0", id: v.last("tools/call")!.id, error: { code: -32000, message: "approval declined" } });
    expect(v.text()).toContain("approval declined");
    const before = v.sent.filter((m) => m.method === "tools/call").length;
    (v.document.querySelector(".retry") as any).dispatchEvent(new (v.document.defaultView as any).Event("click"));
    expect(v.sent.filter((m) => m.method === "tools/call").length).toBe(before + 1);
  });

  it("#47：JSON-RPC でないメッセージと、ホスト以外からのメッセージは捨てる。ping には答える", async () => {
    const v = boot();
    await v.deliver({ type: "auth", token: "t", payload: {} });
    await v.deliver("not json-rpc");
    await v.deliver({ jsonrpc: "2.0", id: v.sent[0]!.id, result: {} }, { postMessage() {} });
    expect(v.sent.map((m) => m.method)).toEqual(["ui/initialize"]);
    await v.deliver({ jsonrpc: "2.0", id: 99, method: "ping" });
    expect(v.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
  });

  it("C-11・C-09：モデルへ書き戻す要求を持たず、HTML として入れる書き方と外部の読み込みを使わない", () => {
    const html = viewHtml(cfg);
    for (const banned of ["ui/update-model-context", "ui/message", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "fetch(", "XMLHttpRequest", "WebSocket", "import("]) {
      expect(VIEW_SCRIPT.includes(banned), banned).toBe(false);
    }
    expect(html).not.toMatch(/\b(src|href)\s*=\s*["']?https?:/i);
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).not.toMatch(/@import|url\(/);
  });

  it("設定の JSON は </script> で切れない", () => {
    const html = viewHtml({ ...cfg, appVersion: "</script><script>alert(1)</script>" });
    const { document } = parseHTML(html);
    expect(document.querySelectorAll("script")).toHaveLength(2);
    expect(JSON.parse(document.getElementById("cfg")!.textContent!).appVersion).toBe("</script><script>alert(1)</script>");
  });
});
