import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SEARCH_PROVIDER: "test",
          // 方針の時間の 1/50 で動かす（25秒の締め切り → 0.5秒）
          TEST_TIME_SCALE: "0.02",
          OWNER_PASSPHRASE: "correct horse battery staple",
          OPENALEX_API_KEY: "test-openalex-key",
          CONTACT_EMAIL: "contact@example.com",
        },
        serviceBindings: { TEST_UPSTREAM: "upstream" },
        workers: [{ name: "upstream", modules: true, scriptPath: "./test/upstream.mjs", compatibilityDate: "2026-10-01" }],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
