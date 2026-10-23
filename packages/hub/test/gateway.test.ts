import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Gateway, classifyUrl, rankHits } from "../src/gateway.ts";
import { extractHtml } from "../src/extract.ts";
import { upstreamLog, upstreamSet } from "./helpers.ts";

describe("取得の出口（Gateway）", () => {
  it("HTML から本文を取り出す（Readability が workerd で動く）", () => {
    const { title, blocks } = extractHtml(
      "<html><head><title>T</title></head><body><nav>menu</nav><article><h1>見出し</h1><p>一段落目の本文。</p><p>二段落目の本文。</p></article></body></html>",
      "https://x.example/",
    );
    expect(title).toBe("T");
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "見出し"],
      ["prose", "一段落目の本文。"],
      ["prose", "二段落目の本文。"],
    ]);
  });

  it("表は1行ずつの塊にし、見出し行と見出しを context にする。公開日は meta 要素・JSON-LD から原文どおりに（D10）", () => {
    const html = `<html><head><title>Limits</title>
      <meta property="article:published_time" content="2026-10-15T00:00:00+00:00">
      <script type="application/ld+json">{"@context":"https://schema.org","dateModified":"2026-10-20"}</script></head>
      <body><article><h2>Worker limits</h2><p>These limits apply to every Worker on every plan without exception.</p>
      <table><thead><tr><th>Feature</th><th>Workers Free</th><th>Workers Paid</th></tr></thead>
      <tbody><tr><td>CPU time</td><td>10 ms</td><td>5 min</td></tr><tr><td>Memory</td><td>128 MB</td><td>128 MB</td></tr></tbody></table>
      <ul><li>Outer item<ul><li>Inner item</li></ul></li></ul></article></body></html>`;
    const { blocks } = extractHtml(html, "https://x.example/limits");
    expect(blocks.filter((b) => b.kind === "meta").map((b) => b.text)).toEqual(["article:published_time: 2026-10-15T00:00:00+00:00", "dateModified: 2026-10-20"]);
    expect(blocks.filter((b) => b.kind === "row")).toEqual([
      { kind: "row", text: "CPU time | 10 ms | 5 min", context: "Worker limits — Feature | Workers Free | Workers Paid" },
      { kind: "row", text: "Memory | 128 MB | 128 MB", context: "Worker limits — Feature | Workers Free | Workers Paid" },
    ]);
    expect(blocks.filter((b) => b.kind === "item").map((b) => b.text)).toEqual(["Outer item", "Inner item"]);
    expect(blocks.some((b) => b.text.includes("@context"))).toBe(false);
  });

  it("<meta http-equiv=refresh> の転送を1回だけ追う（/releases/latest/ のような URL）", async () => {
    await upstreamSet({ url: "https://docs.example.com/latest/", contentType: "text/html", body: `<html><head><meta http-equiv="refresh" content="0; url=/limits"></head><body>Redirecting…</body></html>` });
    const r = await new Gateway(env).fetchDoc("https://docs.example.com/latest/");
    expect(r.ok && "doc" in r && r.doc.source.url).toBe("https://docs.example.com/limits");
    if (r.ok && "doc" in r) expect(r.doc.text).toContain("3秒に1回");
  });

  it("どの段落の候補も、文書の全文（照合に使う）の部分文字列", async () => {
    const r = await new Gateway(env).fetchDoc("https://github.com/acme/tool/blob/main/README.md");
    if (!(r.ok && "doc" in r)) throw new Error("取れない");
    const { candidateParagraphs, normalize } = await import("@ai-research/core");
    const full = normalize(r.doc.text);
    for (const p of candidateParagraphs("s", r.doc.blocks)) expect(full).toContain(p.text);
  });

  it("URL の種類を見分ける", () => {
    expect(classifyUrl("https://github.com/acme/tool/blob/main/README.md")).toMatchObject({ kind: "github", owner: "acme", repo: "tool", ref: "main", path: "README.md" });
    expect(classifyUrl("https://arxiv.org/abs/2401.00001v2")).toMatchObject({ kind: "arxiv", id: "2401.00001", version: "v2" });
    expect(classifyUrl("https://docs.example.com/limits")).toMatchObject({ kind: "web" });
  });

  it("web：本文と指紋（ETag と本文のハッシュ）を返す", async () => {
    const r = await new Gateway(env).fetchDoc("https://docs.example.com/limits");
    expect(r.ok && "doc" in r).toBe(true);
    if (!(r.ok && "doc" in r)) return;
    expect(r.doc.text).toContain("3秒に1回");
    expect(r.doc.text).not.toContain("menu");
    expect(r.doc.fingerprint.etag).toBe('"limits-v1"');
    expect(r.doc.fingerprint.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("条件付き取得：変わっていなければ 304 として扱う", async () => {
    const r = await new Gateway(env).fetchDoc("https://docs.example.com/limits", { etag: '"limits-v1"' });
    expect(r).toMatchObject({ ok: true, notModified: true });
  });

  it("C-02：禁止の取得先（YouTube）には要求を出さない", async () => {
    const r = await new Gateway(env).fetchDoc("https://www.youtube.com/watch?v=x");
    expect(r).toMatchObject({ ok: false, cutoff: { why: "policy" } });
    expect((await upstreamLog()).some((l) => l.url.includes("youtube"))).toBe(false);
  });

  it("robots.txt に従う", async () => {
    const g = new Gateway(env);
    expect(await g.fetchDoc("https://robots.example.com/private/page")).toMatchObject({ ok: false, cutoff: { why: "robots" } });
    expect((await g.fetchDoc("https://robots.example.com/public/page")).ok).toBe(true);
    expect((await upstreamLog()).some((l) => l.url.includes("/private/"))).toBe(false);
  });

  it("拒まれた取得は blocked、遅い取得は timeout として返す", async () => {
    const g = new Gateway(env);
    expect(await g.fetchDoc("https://blocked.example.com/page")).toMatchObject({ ok: false, cutoff: { why: "blocked" } });
    expect(await g.fetchDoc("https://slow.example.com/page")).toMatchObject({ ok: false, cutoff: { why: "timeout" } });
  });

  it("頻度制限の順番待ちは取得の時間上限に数えない（同じ取得先への取得が重なっても打ち切らない）", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://queue.example.com/p${i}`);
    for (const u of urls) await upstreamSet({ url: u, delayMs: 100, contentType: "text/html", body: `<article><p>${u} の本文。</p></article>` });
    const g = new Gateway(env);
    // 同時2本・1本あたり 100ms なので、最後の取得は時間上限（8秒 × 縮尺 = 160ms）より後に始まる
    const rs = await Promise.all(urls.map((u) => g.fetchDoc(u)));
    expect(rs.map((r) => r.ok)).toEqual(urls.map(() => true));
  });

  it("INV-14：同じ実行の中で失敗した URL には二度と要求を出さない", async () => {
    const g = new Gateway(env);
    await g.fetchDoc("https://blocked.example.com/page");
    await g.fetchDoc("https://blocked.example.com/page");
    await g.fetchDoc("https://blocked.example.com/page");
    const n = (await upstreamLog()).filter((l) => l.url === "https://blocked.example.com/page").length;
    expect(n).toBe(1);
  });

  it("PDF は未対応として返す（黙って空にしない）", async () => {
    await upstreamSet({ url: "https://docs.example.com/paper.pdf", contentType: "application/pdf", body: "%PDF-1.7" });
    expect(await new Gateway(env).fetchDoc("https://docs.example.com/paper.pdf")).toMatchObject({ ok: false, cutoff: { why: "unsupported" } });
  });

  it("GitHub：コミット SHA を指紋にして raw を読む", async () => {
    const r = await new Gateway(env).fetchDoc("https://github.com/acme/tool/blob/main/README.md");
    expect(r.ok && "doc" in r && r.doc.fingerprint.commit).toBe("sha1");
    if (r.ok && "doc" in r) expect(r.doc.text).toContain("config.toml");
  });

  it("arXiv：最新の版を引いて HTML 版を読む", async () => {
    const r = await new Gateway(env).fetchDoc("https://arxiv.org/abs/2401.00001");
    expect(r.ok).toBe(true);
    if (r.ok && "doc" in r) {
      expect(r.doc.fingerprint.arxivVersion).toBe("v2");
      expect(r.doc.source.locator).toBe("arXiv:2401.00001v2");
      expect(r.doc.text).toContain("Trace validation");
    }
  });

  it("検索：禁止の取得先を外し、結果を返す", async () => {
    const r = await new Gateway(env).search("limits");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits.map((h) => h.url)).not.toContain("https://www.youtube.com/watch?v=x");
  });

  it("検索の設定がなければ not_configured", async () => {
    const r = await new Gateway({ ...env, SEARCH_PROVIDER: "none" }).search("limits");
    expect(r).toMatchObject({ ok: false, cutoff: { why: "not_configured" } });
  });

  it("一次資料を前に並べる", () => {
    const hits = rankHits([
      { url: "https://blog.example.net/a", title: "", snippet: "" },
      { url: "https://arxiv.org/abs/2401.00001", title: "", snippet: "" },
    ]);
    expect(hits[0]!.url).toContain("arxiv.org");
  });
});
