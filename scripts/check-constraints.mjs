#!/usr/bin/env node
/**
 * 制約の台帳（spec/Spec.pkl が唯一の正）と検査の照合（ADR-0001、利用者の決定 2026-10-30）。
 * 検査器は pkspec（必須。PATH か PKSPEC_BIN）。このスクリプトがすること：
 *
 * 1. `pkspec check spec/Spec.pkl spec/Test.pkl` … 宣言した制約に実装（検査）があるか
 * 2. `pkspec exec -f spec/Test.pkl`             … 実装ポインタ（grep・ファイル実在）が本当に当たるか
 * 3. 孤児の検出 … テスト・仕様に現れる制約 ID が台帳に登録されているか
 * 4. docs/generated/ のビュー（SPEC.md＝pkspec spec、coverage.md＝pkspec coverage）の生成。
 *    --check は生成結果とコミット済みの中身が同じであることを確かめる
 *
 * 実行：node scripts/check-constraints.mjs [--check|--write]
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const specDir = join(root, "spec");
const mode = process.argv.includes("--check") ? "check" : "write";
const errors = [];

// ---- pkspec（必須の検査器）の解決 ----------------------------------------------
// 順に、PKSPEC_BIN → PATH → リポジトリに vendoring した tarball（tools/pkspec/。
// sha256 を照合してから tools/pkspec/bin/ に展開する。linux-amd64 のみ。
// 他のプラットフォームは install.sh で PATH に入れる（docs/runbook.md）

function resolvePkspec() {
  for (const cand of [process.env.PKSPEC_BIN, "pkspec"]) {
    if (!cand) continue;
    if (!spawnSync(cand, ["version"], { encoding: "utf8" }).error) return cand;
  }
  const dir = join(root, "tools/pkspec");
  const local = join(dir, "bin/pkspec");
  if (!existsSync(local)) {
    const v = spawnSync("sha256sum", ["-c", "pkspec-linux-amd64.tar.gz.sha256"], { cwd: dir, encoding: "utf8" });
    if (v.status !== 0) {
      console.error("FAIL tools/pkspec の tarball が sha256 と合わない");
      process.exit(1);
    }
    mkdirSync(join(dir, "bin"), { recursive: true });
    const x = spawnSync("tar", ["xzf", "pkspec-linux-amd64.tar.gz", "-C", "bin"], { cwd: dir, encoding: "utf8" });
    if (x.status !== 0) {
      console.error(`FAIL tools/pkspec の展開に失敗: ${x.stderr}`);
      process.exit(1);
    }
  }
  return local;
}

const bin = resolvePkspec();
const probe = spawnSync(bin, ["version"], { encoding: "utf8" });
if (probe.error) {
  console.error("FAIL pkspec を実行できない（PKSPEC_BIN / PATH / tools/pkspec のどれでも）。導入は docs/runbook.md");
  process.exit(1);
}

function pkspec(args) {
  const r = spawnSync(bin, args, { cwd: specDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const check = pkspec(["check", "Spec.pkl", "Test.pkl"]);
if (check.status !== 0) errors.push(`pkspec check:\n${check.out.trim()}`);
else console.log(`ok   pkspec check: ${check.out.trim().split("\n").at(-1)}`);

const exec = pkspec(["exec", "-f", "Test.pkl"]);
if (exec.status !== 0) errors.push(`pkspec exec（実装ポインタの空振り）:\n${exec.out.trim().split("\n").slice(-12).join("\n")}`);
else console.log(`ok   pkspec exec: ${exec.out.trim().split("\n").at(-1)}`);

// ---- 孤児の検出（台帳にない ID がテスト・仕様に現れていないか） -----------------

const specText = readFileSync(join(specDir, "Spec.pkl"), "utf8");
const ids = new Set([...specText.matchAll(/^\s*id = "([^"]+)"/gm)].map((m) => m[1]));
if (ids.size === 0) errors.push("spec/Spec.pkl から ID を読めない");

function walk(dir, pred) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, pred));
    else if (pred(name)) out.push(p);
  }
  return out;
}
const corpus = [
  ...readdirSync(join(root, "packages")).flatMap((p) => walk(join(root, "packages", p, "test"), (n) => /\.(ts|mts|tsx)$/.test(n))),
  ...walk(join(root, "specs"), (n) => n.endsWith(".qnt")),
];
const tokenRe = /(?<![-\w])((?:W|S|P|Q|U|E|R|V|C)-\d{2}|INV-\d+)(?![-\d])/g;
const orphans = new Map();
for (const p of corpus) {
  for (const m of readFileSync(p, "utf8").matchAll(tokenRe)) {
    if (!ids.has(m[1])) {
      if (!orphans.has(m[1])) orphans.set(m[1], new Set());
      orphans.get(m[1]).add(relative(root, p));
    }
  }
}
for (const [id, files] of orphans) errors.push(`孤児の ID ${id}（台帳 spec/Spec.pkl にない）: ${[...files].join("、")}`);
if (orphans.size === 0) console.log(`ok   孤児 0（台帳 ${ids.size} 件）`);

// ---- ビューの生成（手書き禁止） ------------------------------------------------

const genDir = join(root, "docs/generated");
const banner = "<!-- 生成物（scripts/check-constraints.mjs が pkspec の出力から作る）。手で編集しない -->\n\n";
const views = [];
const specMd = pkspec(["spec", "Spec.pkl", "Test.pkl"]);
if (specMd.status !== 0) errors.push(`pkspec spec（ビューの生成）が失敗:\n${specMd.out.trim()}`);
else views.push(["docs/generated/SPEC.md", banner + specMd.out]);
const covMd = pkspec(["coverage", "Spec.pkl", "Test.pkl"]);
if (covMd.status !== 0) errors.push(`pkspec coverage が失敗:\n${covMd.out.trim()}`);
else views.push(["docs/generated/coverage.md", `${banner}\`\`\`\n${covMd.out.trim()}\n\`\`\`\n`]);

if (mode === "write") {
  mkdirSync(genDir, { recursive: true });
  for (const [p, text] of views) writeFileSync(join(root, p), text);
} else {
  for (const [p, text] of views) {
    const current = existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null;
    if (current !== text) errors.push(`${p} が台帳と食い違う。node scripts/check-constraints.mjs --write で生成し直す`);
  }
}

// ---- 報告 ----------------------------------------------------------------------

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  console.error(`check-constraints: ${errors.length} 件`);
  process.exit(1);
}
console.log(`check-constraints: OK（pkspec ${probe.stdout.trim()}）`);
