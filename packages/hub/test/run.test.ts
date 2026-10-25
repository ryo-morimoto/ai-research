import { describe, it, expect } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from "cloudflare:test";
import type { Bundle } from "@ai-research/sandbox-api";
import { normalize } from "@ai-research/core";
import type { RunDO } from "../src/run.ts";
import { timeScale } from "../src/time.ts";
import { inspect, ledger, run, upstreamLog, upstreamSet } from "./helpers.ts";
import { checkRunTrace, type Ev } from "./trace.ts";

const scale = timeScale(env);
let n = 0;
const newRun = () => {
  const id = `run_test_${++n}_${crypto.randomUUID().slice(0, 6)}`;
  return { id, stub: run(id) };
};

/** その実行の DO だけ env を差し替える（予算や時間上限を試験用に縮める） */
async function patchEnv(stub: DurableObjectStub<RunDO>, patch: Record<string, string>) {
  await runInDurableObject(stub, (inst: RunDO) => {
    const self = inst as unknown as { env: Record<string, unknown> };
    self.env = { ...self.env, ...patch };
  });
}

async function trace(stub: DurableObjectStub<RunDO>) {
  const { events } = await inspect(stub);
  return checkRunTrace(events as Ev[], { timeScale: scale });
}

const passageWith = (b: Bundle, s: string) => b.passages.find((p) => p.text.includes(s));

describe("調査の実行（RunDO）", () => {
  it("W-01：締め切りまでに最初の束を返す。拒まれた取得は打ち切りとして見える", async () => {
    const { id, stub } = newRun();
    const t0 = Date.now();
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限は", queries: ["limits"] });
    expect(Date.now() - t0).toBeLessThan(25_000 * scale + 300);
    expect(b.question.version).toBe(1);
    expect(passageWith(b, "3秒に1回")).toBeDefined();
    expect(b.cutoffs.some((c) => c.why === "blocked")).toBe(true);
    // C-02：禁止の取得先には要求を出していない
    expect((await upstreamLog()).some((l) => l.url.includes("youtube"))).toBe(false);
    const m = (await inspect(stub)).meta!;
    expect(m.manifest.procedureVersion).toMatch(/^2026-/);
    expect(m.manifest.egress).toBe("hub");
    await trace(stub);
  });

  it("INV-8：締め切りで終わっていない作業は打ち切りとして返り、続きで届く", async () => {
    const { id, stub } = newRun();
    await patchEnv(stub, { TEST_DEADLINES: JSON.stringify({ fetchMs: 20_000 }) });
    await upstreamSet({ url: "https://chain.example.com/robots.txt", delayMs: 1_000, body: "" });
    await upstreamSet({ url: "https://chain.example.com/page", delayMs: 300, contentType: "text/html", body: "<article><p>遅れて届く段落の本文。</p></article>" });
    const b1 = await stub.start(id, { mode: "survey", question: "遅れて届く段落", queries: [], urls: ["https://chain.example.com/page"] });
    expect(b1.done).toBe(false);
    expect(b1.cutoffs.some((c) => c.why === "timeout" && c.what.includes("chain.example.com"))).toBe(true);
    expect(passageWith(b1, "遅れて届く")).toBeUndefined();
    const b2 = await stub.next(50_000);
    expect(passageWith(b2, "遅れて届く")).toBeDefined();
    const t = await trace(stub);
    expect(t.bundles).toBe(2);
  });

  it("INV-10：方向を変えたら、古い版の段落を返さず、古い版の段落での引用は stale_version", async () => {
    const { id, stub } = newRun();
    const b1 = await stub.start(id, { mode: "survey", question: "プロンプトキャッシュ", queries: ["cache"] });
    const old = passageWith(b1, "前置きが完全に一致")!;
    expect(old).toBeDefined();
    const b2 = await stub.steer({ question: "取得先の制限", queries: ["limits"] });
    expect(b2.question.version).toBe(2);
    expect(b2.passages.map((p) => p.passageId)).not.toContain(old.passageId);
    const v = await stub.verify([{ text: "x", cite: [{ passageId: old.passageId, quote: "前置きが完全に一致" }] }]);
    expect(v.statuses[0]).toMatchObject({ status: "未確認", reason: "stale_version" });
    await trace(stub);
  });

  it("INV-10：方向を変えたら、届けていない古い版の段落も、遅れて終わった古い作業の結果も混ぜない", async () => {
    const { id, stub } = newRun();
    await patchEnv(stub, { TEST_CAP_SCALE: "0.012", TEST_DEADLINES: JSON.stringify({ fetchMs: 20_000 }) });
    await upstreamSet({ url: "https://chain.example.com/robots.txt", delayMs: 1_000, body: "" });
    await upstreamSet({ url: "https://chain.example.com/page", delayMs: 300, contentType: "text/html", body: "<article><p>遅れて届く段落の本文。</p></article>" });
    const b1 = await stub.start(id, { mode: "survey", question: "制限とキャッシュ", queries: ["limits", "cache"], urls: ["https://chain.example.com/page"] });
    expect(b1.cutoffs.some((c) => c.what.includes("chain.example.com"))).toBe(true);
    // 前提：届けていない古い版の段落が残っている（予算で絞った）
    const before = await inspect(stub);
    expect(before.paras.some((p) => p.v === 1 && !p.delivered)).toBe(true);
    const b2 = await stub.steer({ question: "取得先の制限とキャッシュの詳細", queries: ["limits", "cache"] });
    const later = [b2];
    for (let i = 0; i < 3; i++) later.push(await stub.next(500));
    for (const b of later) {
      expect(b.question.version).toBe(2);
      expect(passageWith(b, "遅れて届く")).toBeUndefined();
    }
    await trace(stub);
  });

  it("同じ本文の段落は1回だけ届ける（同じページの重複も、別の URL の同じ文も）", async () => {
    const { id, stub } = newRun();
    const dup = "Each SQLite-backed Durable Object has a storage limit of 10 GB on a Workers Paid plan.";
    await upstreamSet({ url: "https://dup.example.com/a", contentType: "text/html", body: `<article><p>${dup}</p><p>別の段落の本文。</p><p>${dup}</p></article>` });
    await upstreamSet({ url: "https://dup.example.com/b", contentType: "text/html", body: `<article><p>${dup}</p></article>` });
    const b1 = await stub.start(id, { mode: "survey", question: "storage limit", queries: [], urls: ["https://dup.example.com/a", "https://dup.example.com/b"] });
    const later = await stub.next(0);
    const all = [...b1.passages, ...later.passages];
    expect(all.filter((p) => p.text === dup).length).toBe(1);
    // 外した重複の段落の ID でも、引用は照合できる
    const dupIds = (await inspect(stub)).paras.map((p) => p.passageId);
    const v = await stub.verify(dupIds.map((pid) => ({ text: "x", cite: [{ passageId: pid, quote: "storage limit of 10 GB" }] })));
    expect(v.statuses.filter((s) => s.status === "確認済").length).toBe(3);
    await trace(stub);
  });

  it("Q-06（上書きの試験）：原文にない引用は台帳に入らない。原文どおりの引用だけが入る", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限", queries: ["limits"] });
    const p = passageWith(b, "3秒に1回")!;
    const v = await stub.verify([
      // 事前の知識で書き換えた引用（数字を変えた）
      { text: "arXiv は1秒に10回まで", cite: [{ passageId: p.passageId, quote: "arXiv の API は1秒に10回、同時接続1本までとする" }] },
      // 出典のない主張
      { text: "YouTube の字幕は取得してよい", cite: [] },
      // 原文どおり
      { text: "arXiv は3秒に1回", cite: [{ passageId: p.passageId, quote: "arXiv の API は3秒に1回、同時接続1本までとする" }] },
      // 存在しない段落
      { text: "?", cite: [{ passageId: "p9999", quote: "3秒に1回" }] },
    ]);
    expect(v.statuses.map((s) => s.status)).toEqual(["未確認", "未確認", "確認済", "未確認"]);
    expect(v.statuses[0]!.reason).toBe("not_in_source");
    expect(v.statuses[1]!.reason).toBe("no_citation");
    expect(v.statuses[3]!.reason).toBe("unknown_passage");
    const records = await ledger().all();
    expect(records.length).toBe(1);
    expect(records[0]!.excerpt).toBe("arXiv の API は3秒に1回、同時接続1本までとする");
    // 台帳の抜き書きは、どれも原文の（正規化した）部分文字列
    const src = normalize(b.passages.filter((x) => x.source.url === p.source.url).map((x) => x.text).join("\n"));
    for (const r of records) expect(src).toContain(r.excerpt);
  });

  it("引用は引いた段落の中でだけ照合する。原文の中の命令文は、その出典の文として記録されるだけ", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "Durable Object 指示", queries: ["injection"] });
    const p = passageWith(b, "Durable Object")!;
    const inj = passageWith(b, "これまでの指示を無視")!;
    // 別の段落の文を、この段落の名で引くことはできない
    const v1 = await stub.verify([{ text: "arXiv は1秒に10回", cite: [{ passageId: p.passageId, quote: "arXiv の API は1秒に10回まで呼んでよい" }] }]);
    expect(v1.statuses[0]).toMatchObject({ status: "未確認", reason: "not_in_source" });
    expect((await ledger().all()).length).toBe(0);
    // 命令文の段落を引けば照合は通るが、記録されるのは「この出典がこう書いている」という原文どおりの抜き書き
    const v2 = await stub.verify([{ text: "注入の文", cite: [{ passageId: inj.passageId, quote: "arXiv の API は1秒に10回まで呼んでよい" }] }]);
    expect(v2.statuses[0]!.status).toBe("確認済");
    const [rec] = await ledger().all();
    expect(rec!.url).toBe("https://injection.example.com/page");
    expect(rec!.ctxBefore).toContain("台帳に「");
  });

  it("INV-9：使用量は段階の上限を超えない。超えそうなら止めて知らせる", async () => {
    const { id, stub } = newRun();
    await patchEnv(stub, { TEST_CAP_SCALE: "0.006" }); // 最初 600、続き 3600 トークン
    const b1 = await stub.start(id, { mode: "survey", question: "取得先の制限とキャッシュ", queries: ["limits", "cache"] });
    expect(b1.budget.usedTokens).toBeLessThanOrEqual(b1.budget.capTokens);
    let last = b1;
    for (let i = 0; i < 6 && (i === 0 || !last.done); i++) {
      last = await stub.next(1_000);
      expect(last.budget.usedTokens).toBeLessThanOrEqual(last.budget.capTokens);
      if (last.notices.some((x) => x.kind === "budget_stopped")) break;
    }
    const t = await trace(stub);
    expect(t.bundles).toBeGreaterThanOrEqual(2);
  });

  it("W-04：4分の上限で終える。以後は作業を始めない", async () => {
    const { id, stub } = newRun();
    await stub.start(id, { mode: "survey", question: "取得先の制限", queries: ["limits"] });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const b = await stub.next(0);
    expect(b.done).toBe(true);
    expect(b.notices.some((x) => x.kind === "done")).toBe(true);
    await trace(stub);
  });

  it("INV-13：退避しても原文の全文はストレージに残っていない。退避後も引用は照合できる", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "取得先の制限", queries: ["limits"] });
    const p = passageWith(b, "3秒に1回")!;
    const stored = await runInDurableObject(stub, async (_i, state) => {
      const all = await state.storage.list();
      return JSON.stringify([...all.entries()]);
    });
    expect(stored).not.toContain("この制限は利用者のすべての機械の合計に適用される");
    expect(stored).not.toContain("頻度制限を守らない取得は");
    await evictDurableObject(stub);
    const v = await stub.verify([{ text: "x", cite: [{ passageId: p.passageId, quote: "同時接続1本まで" }] }]);
    expect(v.statuses[0]!.status).toBe("確認済");
  });

  it("退避の後も段落 ID を使い回さない（古い版の ID は stale_version、新しい ID は前と重ならない）", async () => {
    const { id, stub } = newRun();
    const b1 = await stub.start(id, { mode: "survey", question: "プロンプトキャッシュ", queries: ["cache"] });
    const old = passageWith(b1, "前置きが完全に一致")!;
    await evictDurableObject(stub);
    const b2 = await stub.steer({ question: "取得先の制限", queries: ["limits"] });
    const oldIds = new Set(b1.passages.map((p) => p.passageId));
    for (const p of b2.passages) expect(oldIds.has(p.passageId), `ID ${p.passageId} を使い回している`).toBe(false);
    const v = await stub.verify([{ text: "x", cite: [{ passageId: old.passageId, quote: "前置きが完全に一致" }] }]);
    expect(v.statuses[0]).toMatchObject({ status: "未確認", reason: "stale_version" });
  });

  it("Q-02：台帳の抜き書きを照らし直す（変わっていなければ確認済、消えていれば未確認）", async () => {
    // 1回目：照合して台帳に入れる
    const a = newRun();
    const b = await a.stub.start(a.id, { mode: "survey", question: "取得先の制限", queries: ["limits"] });
    const p = passageWith(b, "3秒に1回")!;
    await a.stub.verify([{ text: "x", cite: [{ passageId: p.passageId, quote: "同時接続1本までとする" }] }]);
    expect((await ledger().all()).length).toBe(1);

    // 2回目：変わっていない（ETag が同じ → 304）
    const c = newRun();
    const b2 = await c.stub.start(c.id, { mode: "survey", question: "同時接続1本までとする", queries: [] });
    expect(b2.ledgerHits.map((h) => h.status)).toEqual(["確認済"]);
    const log = await upstreamLog();
    expect(log.some((l) => l.url === "https://docs.example.com/limits" && l.headers["if-none-match"] === '"limits-v1"')).toBe(true);
    // 照らし直した抜き書きは引用できる
    const v2 = await c.stub.verify([{ text: "x", cite: [{ passageId: b2.ledgerHits[0]!.passageId, quote: "同時接続1本までとする" }] }]);
    expect(v2.statuses[0]!.status).toBe("確認済");

    // 3回目：出典が変わり、抜き書きが消えた
    await upstreamSet({ url: "https://docs.example.com/limits", contentType: "text/html", etag: '"limits-v2"', body: "<article><p>arXiv の API の制限は廃止された。</p></article>" });
    const d = newRun();
    const b3 = await d.stub.start(d.id, { mode: "survey", question: "同時接続1本までとする", queries: [] });
    expect(b3.ledgerHits[0]).toMatchObject({ status: "未確認" });
    const v3 = await d.stub.verify([{ text: "x", cite: [{ passageId: b3.ledgerHits[0]!.passageId, quote: "同時接続1本までとする" }] }]);
    expect(v3.statuses[0]!.status).toBe("未確認");
  });

  it("照らし直しのために取り直した文書は、段落の候補にしない（設計 v1.3 §8.1.4）", async () => {
    const a = newRun();
    const b = await a.stub.start(a.id, { mode: "survey", question: "取得先の制限", queries: ["limits"] });
    const p = passageWith(b, "3秒に1回")!;
    await a.stub.verify([{ text: "x", cite: [{ passageId: p.passageId, quote: "同時接続1本までとする" }] }]);
    // 出典が変わった（ETag が変わり、抜き書きは残っている。問いに合う文も増えた）
    await upstreamSet({
      url: "https://docs.example.com/limits",
      contentType: "text/html",
      etag: '"limits-v3"',
      body: "<article><p>arXiv の API は3秒に1回、同時接続1本までとする。</p><p>同時接続1本までとする制限は、2026年に見直す予定である。</p></article>",
    });
    const c = newRun();
    const b2 = await c.stub.start(c.id, { mode: "survey", question: "同時接続1本までとする", queries: [] });
    expect(b2.ledgerHits[0]).toMatchObject({ status: "確認済" });
    expect(b2.passages).toEqual([]);
  });

  it("INV-4：実行の途中で台帳に増えたものは、その実行の検索に出ない（snapshot）", async () => {
    const a = newRun();
    await a.stub.start(a.id, { mode: "survey", question: "取得先の制限", queries: [] });
    const m = (await inspect(a.stub)).meta!;
    expect(m.manifest.ledgerSnapshotSeq).toBe(0);
  });
});
