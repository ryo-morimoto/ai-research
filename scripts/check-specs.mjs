#!/usr/bin/env node
/**
 * 形式仕様の検査（docs/03 §3.1、§3.7）
 *
 * - 正しい版（*_ok）：ランダムなシミュレーションで不変条件が破れないこと。
 *   SPEC_MODE=full のときは Apalache による上限付きのモデル検査も行う。
 * - わざと壊した版（*_bug_*）：シミュレーションで不変条件の違反が見つかること（空振りの防止）。
 *
 * 環境変数：
 *   SPEC_MODE      quick（既定、シミュレーションのみ） | full（Apalache も）
 *   SPEC_SAMPLES   シミュレーションの試行回数（既定 3000）
 *   SPEC_STEPS     Apalache の手数の上限（既定 8）
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const specsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "specs");
const mode = process.env.SPEC_MODE ?? "quick";
const samples = process.env.SPEC_SAMPLES ?? "3000";
const steps = process.env.SPEC_STEPS ?? "8";

const SPECS = [
  { file: "limiter.qnt", ok: ["limiter_ok", "limiter_ok_conc2"], bug: ["limiter_bug_spacing", "limiter_bug_conc"] },
  {
    file: "ledger.qnt",
    ok: ["ledger_ok"],
    bug: ["ledger_bug_write_any", "ledger_bug_stale_check", "ledger_bug_ignore_tomb", "ledger_bug_read_future"],
  },
  {
    file: "run.qnt",
    ok: ["rrun_ok"],
    bug: [
      "rrun_bug_mix_versions",
      "rrun_bug_no_cutoffs",
      "rrun_bug_no_deadline",
      "rrun_bug_over_budget",
      "rrun_bug_late_start",
    ],
  },
];

function quint(args) {
  const r = spawnSync("npx", ["quint", ...args], { cwd: specsDir, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

let failed = 0;
function report(ok, label, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed++;
}

for (const spec of SPECS) {
  const tc = quint(["typecheck", spec.file]);
  report(tc.code === 0, `typecheck ${spec.file}`, tc.code === 0 ? "" : tc.out.slice(0, 500));
  if (tc.code !== 0) continue;

  for (const m of spec.ok) {
    const sim = quint(["run", "--backend", "typescript", "--main", m, "--invariant", "inv", "--max-samples", samples, "--max-steps", "25", spec.file]);
    report(sim.code === 0 && /No violation/.test(sim.out), `simulate ${m}`);
    if (mode === "full") {
      const v = quint(["verify", "--main", m, "--invariant", "inv", "--max-steps", steps, spec.file]);
      report(v.code === 0 && /No violation/.test(v.out), `apalache ${m} (steps=${steps})`);
    }
  }
  for (const m of spec.bug) {
    const sim = quint(["run", "--backend", "typescript", "--main", m, "--invariant", "inv", "--max-samples", samples, "--max-steps", "25", spec.file]);
    report(sim.code !== 0 && /Invariant violated/.test(sim.out), `broken variant is caught: ${m}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall spec checks passed");
