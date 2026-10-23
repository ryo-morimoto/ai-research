import { afterEach } from "vitest";
import { reset } from "cloudflare:test";
import { upstreamReset } from "./helpers.ts";

// 試験ごとに Durable Object のストレージと偽の取得先を初期状態に戻す
afterEach(async () => {
  await reset();
  await upstreamReset();
});
