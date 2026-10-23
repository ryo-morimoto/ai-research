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
  { name: "code の道具の説明文（CODE_TOOL_DESCRIPTION）", text: policy.CODE_TOOL_DESCRIPTION, max: Number(process.env.BUDGET_CODE_TOOL ?? 1600) },
  { name: "スキルの説明文", text: description, max: 120 },
  { name: "スキルの本文", text: body ?? "", max: 150 },
  { name: "フックが止めるときの文（ROUTE_DENY_REASON）", text: policy.ROUTE_DENY_REASON, max: 450 },
];

// 置き場所：手順は code の道具の説明文だけに書く
const PLACEMENT = [
  { name: "スキルの本文に手順を書かない", text: body ?? "", forbid: /research\.(verify|next|steer|deepen)/ },
  { name: "サーバーの説明文に手順を書かない", text: policy.INSTRUCTIONS, forbid: /research\.|ledger\./ },
];

let failed = 0;
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
