#!/usr/bin/env node
/**
 * 依存の規則（docs/03 §2.1、§3.3-4）
 *
 * 1. VerifiedExcerpt を作れるのは packages/core/src/verify.ts だけ
 *    （`as VerifiedExcerpt` や `as unknown as VerifiedExcerpt` を他で書かない）
 * 2. packages/core は他のワークスペースのパッケージにも Cloudflare の API にも依存しない
 * 3. 台帳への追記（appendVerified）を呼べるのは hub の ledger モジュールと run モジュールだけ
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

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`check-deps: ${files.length} files OK`);
