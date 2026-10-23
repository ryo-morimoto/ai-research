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
