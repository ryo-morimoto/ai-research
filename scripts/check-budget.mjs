#!/usr/bin/env node
/**
 * 説明の大きさと置き場所の検査（設計 v1.3 D11、制約 S-06）。
 *
 * 説明は内容ごとに1か所に置き、他の場所からはそこを指すだけにする。
 * 失敗のたびに説明を書き足して大きくなる流れを、この検査で止める（pstack: Encode Lessons in Structure）。
 *
 * 実行：node --experimental-strip-types scripts/check-budget.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const policy = await import(join(root, "packages/policy/src/index.ts"));
const { estimateTokens } = await import(join(root, "packages/core/src/index.ts"));

const skill = readFileSync(join(root, "plugins/ai-research/skills/ai-research-first/SKILL.md"), "utf8");
const [, front, body] = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
const description = (front ?? "").match(/^description:\s*(.*)$/m)?.[1] ?? "";

// 上限は推定トークン（core の estimateTokens。CJK 1字=1、その他3字=1）
const BUDGETS = [
  { name: "サーバーの説明文（INSTRUCTIONS）", text: policy.INSTRUCTIONS, max: 80 },
  { name: "code の道具の説明文（CODE_TOOL_DESCRIPTION）", text: policy.CODE_TOOL_DESCRIPTION, max: Number(process.env.BUDGET_CODE_TOOL ?? 1200) },
  { name: "スキルの説明文", text: description, max: 120 },
  { name: "スキルの本文", text: body ?? "", max: 150 },
  { name: "フックが止めるときの文（ROUTE_DENY_REASON）", text: policy.ROUTE_DENY_REASON, max: 450 },
];

// 置き場所：手順は code の道具の説明文だけに書く
const PLACEMENT = [
  { name: "スキルの本文に手順を書かない", text: body ?? "", forbid: /research\.(verify|next|steer|deepen)/ },
  { name: "サーバーの説明文に手順を書かない", text: policy.INSTRUCTIONS, forbid: /research\.|ledger\./ },
];

/** "0.4.0" どうしを比べる（a < b なら負） */
function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// プラグインの版：plugin.json と、フックが送る版の見出し（hooks.json）がそろっている（設計 v1.5 §8.3.6、U-05）
const pluginVersion = JSON.parse(readFileSync(join(root, "plugins/ai-research/.claude-plugin/plugin.json"), "utf8")).version;
const hooks = JSON.parse(readFileSync(join(root, "plugins/ai-research/hooks/hooks.json"), "utf8"));
const headerVersions = Object.values(hooks.hooks).flat().flatMap((m) => m.hooks).map((h) => h.headers?.["X-AI-Research-Plugin"]);
const VERSION_CHECKS = [
  { name: "フックの版の見出しが plugin.json の版と同じ", ok: headerVersions.length > 0 && headerVersions.every((v) => v === pluginVersion) },
  { name: "ハブが受け付ける最小の版 <= plugin.json の版", ok: compareVersions(policy.POLICY.routing.minPluginVersion, pluginVersion) <= 0 },
  { name: "PostToolUse は ToolSearch だけ（道具の結果を送らせない。E-05）", ok: (hooks.hooks.PostToolUse ?? []).every((m) => m.matcher === "ToolSearch") },
];

let failed = 0;
for (const c of VERSION_CHECKS) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}`);
}
for (const b of BUDGETS) {
  const n = estimateTokens(b.text);
  const ok = n <= b.max;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${b.name}: ${n} / ${b.max}`);
}
for (const p of PLACEMENT) {
  const ok = !p.forbid.test(p.text);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${p.name}`);
}
if (failed) {
  console.error(`check-budget: ${failed} 件`);
  process.exit(1);
}
