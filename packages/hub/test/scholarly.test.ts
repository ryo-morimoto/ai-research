import { describe, it, expect } from "vitest";
import { env, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { abstractBlocks, citationLine, doiOf, mergeWorks, stripTags, worksFromCrossref, worksFromEpmc } from "../src/scholarly.ts";
import { classifyUrl } from "../src/gateway.ts";
import { routeStub } from "../src/route.ts";
import type { LedgerDO } from "../src/ledger.ts";
import { inspect, ledger, run, upstreamLog } from "./helpers.ts";

const newRun = () => {
  const id = `run_sch_${crypto.randomUUID().slice(0, 8)}`;
  return { id, stub: run(id) };
};

describe("論文の書誌と抄録（設計 v1.4 §8.2.2、制約 Q-08）", () => {
  it("URL から DOI を取り出す（出版社の URL の飾りを外す）", () => {
    expect(doiOf("https://psycnet.apa.org/doi/10.1037/0033-2909.119.2.254")).toBe("10.1037/0033-2909.119.2.254");
    expect(doiOf("https://onlinelibrary.wiley.com/doi/full/10.1111/j.1467-9280.2009.02370.x")).toBe("10.1111/j.1467-9280.2009.02370.x");
    expect(doiOf("https://journals.sagepub.com/doi/pdf/10.1177/0956797614543022/abstract")).toBe("10.1177/0956797614543022");
    expect(doiOf("https://link.springer.com/article/10.1007%2Fs11031-022-09977-8")).toBe("10.1007/s11031-022-09977-8");
    expect(doiOf("https://www.sciencedirect.com/science/article/pii/S0001691800000123")).toBeNull();
    expect(classifyUrl("https://doi.org/10.1037/0033-2909.119.2.254")).toMatchObject({ kind: "work", doi: "10.1037/0033-2909.119.2.254" });
    expect(classifyUrl("https://europepmc.org/article/MED/36160472")).toMatchObject({ kind: "work", epmc: { source: "MED", id: "36160472" } });
  });

  it("API の応答を論文に直す。データセットは外し、DOI で1つにまとめ、抄録は Europe PMC を先に使う", () => {
    const e = worksFromEpmc({ resultList: { result: [{ id: "1", source: "MED", doi: "10.1/A", title: "T.", authorString: "A B, C D.", pubYear: "2001", abstractText: "From EPMC." }] } });
    const c = worksFromCrossref({ message: { items: [{ DOI: "10.1/a", title: ["T"], abstract: "<jats:p>From Crossref.</jats:p>", type: "journal-article", "container-title": ["J"] }, { DOI: "10.1/d", title: ["D"], type: "dataset" }] } });
    expect(c).toHaveLength(1);
    const [w] = mergeWorks(e, c);
    expect(w).toMatchObject({ abstract: "From EPMC.", abstractFrom: "europepmc", meta: { doi: "10.1/a", year: 2001, venue: "J", authors: ["A B", "C D"] } });
    expect(citationLine(w!)).toBe("A B, C D (2001). T. J. doi:10.1/a");
    expect(stripTags("<jats:sec><jats:title>Background</jats:title><jats:p>x &amp; y</jats:p></jats:sec>")).toBe("Background: x & y");
  });

  it("抄録は文の切れ目で分ける（文の途中で切らない）", () => {
    const s = "First sentence about mindsets. ".repeat(20).trim();
    const blocks = abstractBlocks(s, 120);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.endsWith(".")).toBe(true);
    expect(blocks.map((b) => b.text).join(" ")).toBe(s);
  });

  it("sources に scholarly を渡すと、論文の書誌と抄録が段落になる。照合すると論文として台帳に入る。公開の版のページも読む", async () => {
    const { id, stub } = newRun();
    const b = await stub.start(id, { mode: "survey", question: "Gollwitzer の熟慮マインドセットと実行マインドセット", sources: ["scholarly"], queries: ["deliberative implemental mindset Gollwitzer"] });
    const last = b.done ? b : await stub.next(50_000);
    const all = [...b.passages, ...last.passages];
    const abs = all.find((p) => p.text.includes("open-minded processing"))!;
    expect(abs).toBeDefined();
    expect(abs.source).toMatchObject({ kind: "work", tier: "paper", url: "https://doi.org/10.1007/s11031-022-09977-8", work: { year: 2022, venue: "Motivation and Emotion" } });
    expect(abs.context).toBe("Abstract");
    // ウェブ検索はしていない
    const log = await upstreamLog();
    expect(log.some((l) => l.url.startsWith("https://search.test/"))).toBe(false);
    expect(log.some((l) => l.url.startsWith("https://pmc.ncbi.nlm.nih.gov/articles/PMC9486774"))).toBe(true);
    const v = await stub.verify([{ text: "熟慮は開かれた処理", cite: [{ passageId: abs.passageId, quote: "The deliberative mindset is characterized by open-minded processing of information." }] }]);
    expect(v.statuses[0]!.status).toBe("引用確認済");
    const recs = await ledger().all();
    expect(recs[0]).toMatchObject({ kind: "work", url: "https://doi.org/10.1007/s11031-022-09977-8" });
    // 退避の後も、DOI から取り直して照合できる
    await evictDurableObject(stub);
    const v2 = await stub.verify([{ text: "閉じた処理", cite: [{ passageId: abs.passageId, quote: "The deliberative mindset is characterized by open-minded processing of information." }] }]);
    expect(v2.statuses[0]!.status).toBe("引用確認済");
  });

  it("出版社のページが拒んでも、URL の DOI から書誌と抄録に取り直す。ページは経路外で読める", async () => {
    const { id, stub } = newRun();
    const url = "https://psycnet.apa.org/doi/10.1037/0033-2909.119.2.254";
    const b = await stub.start(id, { mode: "lookup", question: "Kluger DeNisi feedback interventions performance d", urls: [url] });
    const p = b.passages.find((x) => x.text.includes("d = .41"))!;
    expect(p).toBeDefined();
    expect(p.source).toMatchObject({ kind: "work", url: "https://doi.org/10.1037/0033-2909.119.2.254", work: { year: 1996, venue: "Psychological Bulletin" } });
    expect(b.notices.some((n) => n.kind === "empty")).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(await routeStub(env).decide({ session: "s", tool: "WebFetch", url })).toMatchObject({ kind: "allow", why: "cutoff" });
    const { meta } = await inspect(stub);
    expect(meta?.progress).toMatchObject({ fetched: 1, failed: 0 });
  });

  it("台帳の出典の種類の CHECK に work を足す（古い表を写して入れ替える。冪等）", async () => {
    const stub = ledger();
    await runInDurableObject(stub, async (inst: LedgerDO, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TABLE records`);
      sql.exec(`CREATE TABLE records (seq INTEGER PRIMARY KEY, record_id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('web','github','arxiv')), url TEXT NOT NULL, title TEXT, locator TEXT NOT NULL, excerpt TEXT NOT NULL, ctx_before TEXT NOT NULL, ctx_after TEXT NOT NULL, fp_etag TEXT, fp_last_modified TEXT, fp_text_hash TEXT, fp_commit TEXT, fp_arxiv_version TEXT, verified_at TEXT NOT NULL, volatility TEXT NOT NULL, origin_run TEXT NOT NULL)`);
      sql.exec(`INSERT INTO records VALUES (1,'r1','web','https://a/','t','l','old excerpt','','',NULL,NULL,NULL,NULL,NULL,'2026-10-01','normal','run')`);
      expect(inst.migrateKinds()).toBe(true);
      expect(inst.migrateKinds()).toBe(false);
      sql.exec(`INSERT INTO records VALUES (2,'r2','work','https://doi.org/x','t','doi:x','new excerpt','','',NULL,NULL,NULL,NULL,NULL,'2026-10-25','stable','run')`);
      expect(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM records`).one().n).toBe(2);
    });
  });
});
