#!/usr/bin/env node
/**
 * Adapter.pkl の overlay（vitest ケースへの specRef の接続）を自動で実行する。
 * pkspec@0.4.2 の本体 CLI には adapter 実行がないため、同梱シム
 * pkspec-adapter-vitest を discover → manifest → run のプロトコルで呼ぶ。
 *
 * 1. Adapter.pkl から overlay の鍵（"file::テスト名"）を読む
 * 2. スイートごとに discover を実行し、鍵が実在のケース ID に一致することを照合
 *    （core は discover がクラッシュする既知の上流不具合 issues/009 のため、照合を省略して run に進む）
 * 3. run --manifest で実行し、全ケース passed を確かめる
 *
 * 実行：node scripts/run-overlays.mjs   （PKSPEC_ADAPTER_VITEST でシムの場所を上書きできる）
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(new URL(".", import.meta.url).pathname, "..");
const shim = process.env.PKSPEC_ADAPTER_VITEST || "pkspec-adapter-vitest";

const adapter = readFileSync(join(root, "spec/Adapter.pkl"), "utf8");
const suites = { hub: { dir: "packages/hub", keys: [], discoverable: true }, core: { dir: "packages/core", keys: [], discoverable: false } };
let current = null;
for (const line of adapter.split("\n")) {
  const name = line.match(/name = "(\w+)"/);
  if (name && suites[name[1]]) current = suites[name[1]];
  const key = line.match(/\["([^"]+)"\] = new CaseOverlay/);
  if (key && current) current.keys.push(key[1]);
}

let failed = 0;
for (const [name, s] of Object.entries(suites)) {
  if (s.keys.length === 0) continue;
  const cwd = join(root, s.dir);
  if (s.discoverable) {
    const d = spawnSync(shim, ["discover"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (d.status !== 0 || d.error) {
      console.error(`FAIL ${name}: discover が失敗した`);
      failed++;
      continue;
    }
    const ids = new Set(JSON.parse(d.stdout.slice(d.stdout.indexOf("{"))).cases.map((c) => c.id));
    for (const k of s.keys) {
      if (!ids.has(k)) {
        console.error(`FAIL ${name}: overlay の鍵が実在のケースにない: ${k}`);
        failed++;
      }
    }
  } else {
    console.log(`note ${name}: discover は上流の不具合（issues/009）で省略。run で検証する`);
  }
  const manifest = { cases: s.keys.map((k) => ({ id: k, selector: { path: k.split("::")[0], name: k.split("::")[1] } })) };
  const mf = join(mkdtempSync(join(tmpdir(), "pkspec-overlay-")), "manifest.json");
  writeFileSync(mf, JSON.stringify(manifest));
  const r = spawnSync(shim, ["run", "--manifest", mf], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const finishes = `${r.stdout ?? ""}`.split("\n").filter((l) => l.includes('"caseFinish"')).map((l) => JSON.parse(l));
  for (const k of s.keys) {
    const f = finishes.find((x) => x.caseId === k);
    if (!f) {
      console.error(`FAIL ${name}: 実行結果がない: ${k}`);
      failed++;
    } else if (f.outcome !== "passed") {
      console.error(`FAIL ${name}: ${f.outcome}: ${k}`);
      failed++;
    } else {
      console.log(`ok   ${name}: passed (${f.durationMs}ms) ${k.slice(0, 60)}…`);
    }
  }
}
if (failed) {
  console.error(`run-overlays: ${failed} 件`);
  process.exit(1);
}
console.log("run-overlays: overlay の全ケースが実在し、実行して passed");
