import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { ledger, excerptFrom } from "./helpers.ts";

const TEXT = "arXiv の API は3秒に1回、同時接続1本までとする。この制限は利用者のすべての機械の合計に適用される。";

describe("台帳（LedgerDO）", () => {
  it("trigram の全文検索が使える（Known Unknown の確認）", async () => {
    expect(await ledger().hasFts()).toBe(true);
  });

  it("追記して検索できる。同じ抜き書きは重ねて書かない", async () => {
    const l = ledger();
    const ve = excerptFrom(TEXT, "3秒に1回、同時接続1本まで");
    const a = await l.appendVerified(ve, "normal", "run_a");
    const b = await l.appendVerified(ve, "normal", "run_b");
    expect(b.recordId).toBe(a.recordId);
    const seq = await l.currentSeq();
    const hits = await l.search("同時接続", { snapshotSeq: seq, limit: 5 });
    expect(hits.map((h) => h.recordId)).toEqual([a.recordId]);
    expect(hits[0]!.excerpt).toBe("3秒に1回、同時接続1本まで");
    // 2文字の語は trigram で引けないので LIKE に落ちる
    const short = await l.search("1回", { snapshotSeq: seq, limit: 5 });
    expect(short.length).toBe(1);
  });

  it("INV-4：snapshotSeq より後のレコードは読まない", async () => {
    const l = ledger();
    await l.appendVerified(excerptFrom(TEXT, "3秒に1回"), "normal", "r1");
    const snap = await l.currentSeq();
    await l.appendVerified(excerptFrom(TEXT, "すべての機械の合計に適用される"), "normal", "r2");
    expect((await l.search("機械の合計", { snapshotSeq: snap, limit: 5 })).length).toBe(0);
    expect((await l.search("機械の合計", { snapshotSeq: await l.currentSeq(), limit: 5 })).length).toBe(1);
  });

  it("INV-3：墓標の付いたものは以降の検索に出ない。墓標の前の版の snapshot には出る", async () => {
    const l = ledger();
    const { recordId } = await l.appendVerified(excerptFrom(TEXT, "3秒に1回"), "normal", "r1");
    const before = await l.currentSeq();
    await l.forget({ recordId, reason: "誤り" });
    expect((await l.search("3秒に1回", { snapshotSeq: await l.currentSeq(), limit: 5 })).length).toBe(0);
    expect((await l.search("3秒に1回", { snapshotSeq: before, limit: 5 })).length).toBe(1);
  });

  it("URL への墓標の後に確かめ直したレコードは生きている", async () => {
    const l = ledger();
    await l.appendVerified(excerptFrom(TEXT, "3秒に1回", {}, { textHash: "a" }), "normal", "r1");
    await l.forget({ url: "https://docs.example.com/x" });
    await l.appendVerified(excerptFrom(TEXT, "3秒に1回", {}, { textHash: "b" }), "normal", "r2");
    const hits = await l.search("3秒に1回", { snapshotSeq: await l.currentSeq(), limit: 5 });
    expect(hits.map((h) => h.fingerprint.textHash)).toEqual(["b"]);
  });

  it("INV-2：レコードを UPDATE しない（書き出しの内容は追記の順に増えるだけ）", async () => {
    const l = ledger();
    await l.appendVerified(excerptFrom(TEXT, "3秒に1回"), "normal", "r1");
    const e1 = await l.exportJsonl();
    await l.forget({ url: "https://docs.example.com/x" });
    await l.appendVerified(excerptFrom(TEXT, "同時接続1本まで"), "normal", "r2");
    const e2 = await l.exportJsonl();
    const firstRecords = e1.split("\n").filter((x) => x.includes('"type":"record"'));
    for (const line of firstRecords) expect(e2).toContain(line);
    expect(e2.split("\n").filter((x) => x.includes('"type":"tombstone"')).length).toBe(1);
  });

  it("purge は物理的に消す（全文検索の索引からも）", async () => {
    const l = ledger();
    const { recordId } = await l.appendVerified(excerptFrom(TEXT, "すべての機械の合計"), "normal", "r1");
    expect(await l.purge(recordId)).toEqual({ deleted: 1 });
    expect(await l.get(recordId)).toBeNull();
    expect((await l.search("機械の合計", { snapshotSeq: await l.currentSeq(), limit: 5 })).length).toBe(0);
  });

  it("長い日本語の問いでも失敗しない（LIKE の型に長い文をそのまま入れない）", async () => {
    const l = ledger();
    await l.appendVerified(excerptFrom(TEXT, "3秒に1回、同時接続1本まで"), "normal", "r1");
    const q = "claude.ai の Customize > Plugins で、自分の GitHub リポジトリにあるプラグイン（マーケットプレイス）を個人アカウントに追加できるか。プラグインの .mcp.json にリモート MCP（OAuth）を書けるか".repeat(3);
    await expect(l.search([q, "arXiv の API の制限"], { snapshotSeq: await l.currentSeq(), limit: 5 })).resolves.toBeDefined();
  });

  it("問いとの関連の下限を超えたものだけを、件数の上限まで返す。同じ抜き書きは1件にまとめる（設計 v1.3 §8.1.4）", async () => {
    const l = ledger();
    const add = (text: string, quote: string, url: string, title?: string) =>
      l.appendVerified(excerptFrom(text, quote, { url, locator: url, ...(title ? { title } : {}) }), "normal", "r");
    await add("Each SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan.", "Each SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan.", "https://a.example/limits", "Limits");
    await add("Each SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan.", "Each SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan.", "https://github.example/faq.mdx");
    await add("Accounts on the Workers Free plan have a daily request limit of 100,000 requests.", "Accounts on the Workers Free plan have a daily request limit of 100,000 requests.", "https://a.example/workers", "Limits");
    await add("TypeScript 5.9 adds import defer and a new tsc --init.", "TypeScript 5.9 adds import defer and a new tsc --init.", "https://b.example/ts", "Announcing TypeScript 5.9");
    await add("A new stable release of Rust is produced every six weeks.", "A new stable release of Rust is produced every six weeks.", "https://c.example/rust", "Rust");
    const seq = await l.currentSeq();
    const hits = await l.search(["Durable Object SQLite storage limit GB", "Durable Objects storage per object"], { snapshotSeq: seq, limit: 5 });
    expect(hits.map((h) => h.excerpt)).toEqual(["Each SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan."]);
    const rust = await l.search(["Rust の最新の安定版", "Rust latest stable release"], { snapshotSeq: seq, limit: 5 });
    expect(rust.map((h) => h.url)).toEqual(["https://c.example/rust"]);
  });

  it("制約：抜き書きは300字まで（SQL の CHECK でも拒む）", async () => {
    const l = ledger();
    await expect(
      runInDurableObject(l, async (_i, state) => {
        state.storage.sql.exec(
          `INSERT INTO records (seq, record_id, kind, url, locator, excerpt, ctx_before, ctx_after, verified_at, volatility, origin_run)
           VALUES (999, 'x', 'web', 'u', 'u', ?, '', '', 'now', 'normal', 'r')`,
          "あ".repeat(301),
        );
      }),
    ).rejects.toThrow(/CHECK/i);
  });
});
