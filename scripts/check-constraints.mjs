#!/usr/bin/env node
/**
 * 制約の台帳（spec/constraints.ts）と検査の照合（docs/adr/0001）。
 *
 * 1. MUST / MUST NOT で approved の制約に、機械検査（grep / file）が1つ以上あるか
 * 2. 宣言した grep（ID が test / spec / script に現れる）が実際に当たるか
 * 3. 宣言した file が実在するか
 * 4. テスト・仕様に現れる制約 ID が、台帳に登録されているか（孤児の検出）
 * 5. ID の重複、goal 参照の整合
 * 6. docs/generated/ のビュー（SPEC.md・coverage.md）を生成する。--check は生成結果と
 *    コミット済みの中身が同じであることを確かめる（ビューの手書き・書き忘れを止める）
 *
 * 実行：node --experimental-strip-types --no-warnings scripts/check-constraints.mjs [--check|--write]
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { GOALS, SCENARIOS } = await import(join(root, "spec/constraints.ts"));

const mode = process.argv.includes("--check") ? "check" : "write";
const errors = [];
const warnings = [];

// ---- 検査対象のファイル -----------------------------------------------------

function walk(dir, pred) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, pred));
    else if (pred(name)) out.push(p);
  }
  return out;
}

const packagesDir = join(root, "packages");
const testFiles = readdirSync(packagesDir)
  .flatMap((p) => walk(join(packagesDir, p, "test"), (n) => /\.(ts|mts|tsx)$/.test(n)));
const specFiles = walk(join(root, "specs"), (n) => n.endsWith(".qnt"));
const scriptFiles = walk(join(root, "scripts"), (n) => n.endsWith(".mjs")).filter((p) => !p.endsWith("check-constraints.mjs"));

const corpora = {
  test: testFiles.map((p) => ({ p, text: readFileSync(p, "utf8") })),
  spec: specFiles.map((p) => ({ p, text: readFileSync(p, "utf8") })),
  script: scriptFiles.map((p) => ({ p, text: readFileSync(p, "utf8") })),
};

const idRe = (id) => new RegExp(`(?<![-\\w])${id.replace(/[-]/g, "\\-")}(?![-\\d])`);

function grepHits(where, id) {
  const re = idRe(id);
  return corpora[where].filter(({ text }) => re.test(text)).map(({ p }) => relative(root, p));
}

// ---- 1〜3,5: 台帳の検査 ------------------------------------------------------

const goalIds = new Set(GOALS.map((g) => g.id));
const seen = new Set();
const rows = [];

for (const s of SCENARIOS) {
  if (seen.has(s.id)) errors.push(`${s.id}: ID が重複している`);
  seen.add(s.id);
  for (const g of s.contributes) if (!goalIds.has(g)) errors.push(`${s.id}: 知らない goal ${g}`);

  const resolved = [];
  let machine = 0;
  for (const c of s.checks) {
    if (c.kind === "grep") {
      const hits = grepHits(c.where, s.id);
      if (hits.length === 0) errors.push(`${s.id}: ${c.where} に ID が現れない（宣言した grep が空振り）`);
      else {
        machine++;
        resolved.push(`${c.where}: ${hits.join("、")}`);
      }
    } else if (c.kind === "file") {
      if (!existsSync(join(root, c.path))) errors.push(`${s.id}: file ${c.path} が実在しない`);
      else {
        machine++;
        resolved.push(`file: ${c.path}${c.note ? `（${c.note}）` : ""}`);
        warnings.push(`${s.id}: 弱い検査（ファイルの実在のみ）: ${c.path}${c.note ? ` — ${c.note}` : ""}`);
      }
    } else {
      resolved.push(`${c.kind}: ${c.note}`);
    }
  }
  const must = s.strength === "MUST" || s.strength === "MUST NOT";
  if (must && s.reviewStatus === "approved" && machine === 0 && !s.verifiedOutsideRepo) {
    errors.push(`${s.id}: ${s.strength} なのに機械検査が1つもない（grep か file を宣言する。CI で判定できないなら verifiedOutsideRepo、未整備なら draft + openQuestions）`);
  }
  if (s.reviewStatus === "draft") warnings.push(`${s.id}: draft（検査の義務なし。coverage に出る）`);
  rows.push({ s, resolved, machine });
}

// ---- 4: 孤児の検出 -----------------------------------------------------------

const tokenRe = /(?<![-\w])((?:W|S|P|Q|U|E|R|V|C)-\d{2}|INV-\d+)(?![-\d])/g;
const orphans = new Map();
for (const where of ["test", "spec"]) {
  for (const { p, text } of corpora[where]) {
    for (const m of text.matchAll(tokenRe)) {
      const id = m[1];
      if (!seen.has(id)) {
        if (!orphans.has(id)) orphans.set(id, new Set());
        orphans.get(id).add(relative(root, p));
      }
    }
  }
}
for (const [id, files] of orphans) errors.push(`孤児の ID ${id}（台帳にない）: ${[...files].join("、")}`);

// ---- 6: ビューの生成 ---------------------------------------------------------

const genDir = join(root, "docs/generated");
const byArea = new Map();
for (const r of rows) {
  const key = r.s.area;
  if (!byArea.has(key)) byArea.set(key, []);
  byArea.get(key).push(r);
}

const strengthMark = (x) => (x === "SHOULD" ? "SHOULD" : `**${x}**`);

let spec = `# 制約の一覧（生成物）\n\n`;
spec += `このファイルは scripts/check-constraints.mjs が spec/constraints.ts から生成する。**手で編集しない。**\n\n`;
spec += `## 目的（Goal）\n\n| ID | 内容 | 優先度 |\n|---|---|---|\n`;
for (const g of GOALS) spec += `| ${g.id} | ${g.name} | ${g.priority} |\n`;
spec += `\n## 制約\n\n`;
for (const [area, list] of [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  spec += `### ${area}\n\n| ID | 強さ | 制約 | 検査 |\n|---|---|---|---|\n`;
  for (const { s, resolved } of list) {
    spec += `| ${s.id} | ${strengthMark(s.strength)} | ${s.name} | ${resolved.join("<br>") || "—"} |\n`;
  }
  spec += `\n`;
}

let cov = `# 検査のカバレッジ（生成物）\n\n手で編集しない（scripts/check-constraints.mjs が生成）。\n\n`;
const noMachine = rows.filter((r) => r.machine === 0 && !r.s.verifiedOutsideRepo && r.s.reviewStatus !== "draft");
const outsideRepo = rows.filter((r) => r.s.verifiedOutsideRepo);
const drafts = rows.filter((r) => r.s.reviewStatus === "draft");
const weak = rows.filter((r) => r.s.checks.some((c) => c.kind === "file"));
const measures = rows.filter((r) => r.s.checks.some((c) => c.kind === "measure"));
const openQ = rows.filter((r) => (r.s.openQuestions ?? []).length > 0);
cov += `- 登録: ${rows.length} 件（MUST/MUST NOT ${rows.filter((r) => r.s.strength !== "SHOULD").length}、SHOULD ${rows.filter((r) => r.s.strength === "SHOULD").length}）\n`;
cov += `- 機械検査あり: ${rows.filter((r) => r.machine > 0).length} / ${rows.length}。運用で確かめる: ${outsideRepo.length}。draft: ${drafts.length}\n\n`;
cov += `## 機械検査がない approved（本来ここは空であるべき）\n\n| ID | 強さ | 検査 |\n|---|---|---|\n`;
for (const { s, resolved } of noMachine) cov += `| ${s.id} | ${s.strength} | ${resolved.join("<br>") || "なし"} |\n`;
cov += `\n## 運用で確かめる（repo の CI では判定しない。verifiedOutsideRepo）\n\n| ID | 確かめ方 |\n|---|---|\n`;
for (const { s, resolved } of outsideRepo) cov += `| ${s.id} | ${resolved.join("<br>")} |\n`;
cov += `\n## draft（検査が未整備。approved に上げるには機械検査が要る）\n\n| ID | 問い |\n|---|---|\n`;
for (const { s } of drafts) cov += `| ${s.id} | ${(s.openQuestions ?? []).join("<br>")} |\n`;
cov += `\n## 弱い検査（ファイルの実在のみ。ID タグを付ければ grep に上げられる）\n\n| ID | 対象 |\n|---|---|\n`;
for (const { s } of weak) cov += `| ${s.id} | ${s.checks.filter((c) => c.kind === "file").map((c) => c.path).join("、")} |\n`;
cov += `\n## 計測が要るもの（measure）\n\n| ID | 計測 |\n|---|---|\n`;
for (const { s } of measures) cov += `| ${s.id} | ${s.checks.filter((c) => c.kind === "measure").map((c) => c.note).join("、")} |\n`;
cov += `\n## 未決の問い（openQuestions）\n\n| ID | 問い |\n|---|---|\n`;
for (const { s } of openQ) cov += `| ${s.id} | ${(s.openQuestions ?? []).join("<br>")}\n`;

const outputs = [
  ["docs/generated/SPEC.md", spec],
  ["docs/generated/coverage.md", cov],
];

if (mode === "write") {
  mkdirSync(genDir, { recursive: true });
  for (const [p, text] of outputs) writeFileSync(join(root, p), text);
} else {
  for (const [p, text] of outputs) {
    const current = existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null;
    if (current !== text) errors.push(`${p} が台帳と食い違う。node --experimental-strip-types scripts/check-constraints.mjs --write で生成し直す`);
  }
}

// ---- 報告 --------------------------------------------------------------------

for (const w of warnings) console.log(`warn ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  console.error(`check-constraints: ${errors.length} 件`);
  process.exit(1);
}
console.log(`check-constraints: ${rows.length} 件 OK（機械検査あり ${rows.length - noMachine.length}、点検・計測のみ ${noMachine.length}、孤児 0）`);
