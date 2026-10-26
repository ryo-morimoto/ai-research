#!/usr/bin/env node
/**
 * 依存の規則（docs/03 §2.1、§3.3-4）
 *
 * 1. VerifiedExcerpt を作れるのは packages/core/src/verify.ts だけ
 *    （`as VerifiedExcerpt` や `as unknown as VerifiedExcerpt` を他で書かない）
 * 2. packages/core は他のワークスペースのパッケージにも Cloudflare の API にも依存しない
 * 3. 台帳への追記（appendVerified）を呼べるのは hub の ledger モジュールと run モジュールだけ
 * 4. 調査の記録（docs/05）は、見るための道。取得の出口・code の実行・外への通信に依存しない（V-01）。
 *    hub/src/trace*.ts と core/src/trace.ts が使ってよいのは、下の TRACE_ALLOWED だけ。fetch も呼ばない
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(root, "packages"));
const TRACE_ALLOWED = new Set(["cloudflare:workers", "@ai-research/core", "@ai-research/policy", "./env.ts"]);
for (const f of files) {
  const rel = relative(root, f);
  const src = readFileSync(f, "utf8");

  if (rel !== "packages/core/src/verify.ts" && /as\s+(unknown\s+as\s+)?VerifiedExcerpt\b/.test(src)) {
    errors.push(`${rel}: VerifiedExcerpt は core/verify.ts の外で作れない（型の強制、INV-1）`);
  }

  if (rel.startsWith("packages/core/src/")) {
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith("@ai-research/") || spec.startsWith("cloudflare:") || spec.startsWith("@cloudflare/")) {
        errors.push(`${rel}: core は ${spec} に依存できない`);
      }
    }
  }

  if (/\bappendVerified\s*\(/.test(src) && !/^packages\/hub\/src\/(ledger|run)[^/]*\.ts$/.test(rel) && !rel.includes("/test/")) {
    if (!/^\s*(export\s+)?(async\s+)?appendVerified\s*\(/m.test(src)) {
      errors.push(`${rel}: appendVerified を呼べるのは hub の ledger / run だけ`);
    }
  }
}

for (const f of files) {
  const rel = relative(root, f);
  if (!/^packages\/hub\/src\/trace[^/]*\.ts$/.test(rel) && rel !== "packages/core/src/trace.ts") continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (!TRACE_ALLOWED.has(m[1])) errors.push(`${rel}: 記録の道は ${m[1]} に依存できない（V-01）`);
  }
  if (/\bfetch\s*\(/.test(src)) errors.push(`${rel}: 記録の道は fetch を呼ばない（V-01）`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`check-deps: ${files.length} files OK`);
