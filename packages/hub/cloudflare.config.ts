import { bindings, defineConfig, exports } from "cf/config";

/**
 * cf（Cloudflare CLI）のデプロイ用の設定（docs/04 §2）。
 * cf migrate で wrangler.jsonc から作り、手で直した。
 *
 * 結合試験（@cloudflare/vitest-plugin）と wrangler tail は wrangler.jsonc を読むので、
 * 束縛を変えたときは wrangler.jsonc も同じように直す。
 */
export default defineConfig({
	worker: {
		name: "ai-research",
		compatibilityDate: "2026-10-01",
		// global_fetch_strictly_public：外への fetch を公開のインターネットだけに限る。
		// OAuth の Client ID Metadata Document の取得に必要で、取得の出口の SSRF 対策にもなる
		compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
		entrypoint: "src/index.ts",
		observability: {
			enabled: true,
		},
		// Durable Object のクラス（wrangler の migrations v1 の new_sqlite_classes に当たる）
		exports: {
			LedgerDO: exports.durableObject({ storage: "sqlite" }),
			RunDO: exports.durableObject({ storage: "sqlite" }),
			HostLimiterDO: exports.durableObject({ storage: "sqlite" }),
			RouteDO: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			SEARCH_PROVIDER: bindings.text("brave"),
			// 秘密の値は cf deploy --secrets-file で上げる
			OWNER_PASSPHRASE: bindings.secret(),
			BRAVE_API_KEY: bindings.secret(),
			// 抄録の索引（OpenAlex）と、Crossref・Unpaywall に送る連絡先（設計 v1.5 §8.3.4）
			OPENALEX_API_KEY: bindings.secret(),
			CONTACT_EMAIL: bindings.secret(),
			// OAuth の状態（cf kv namespaces create --title ai-research-oauth で作った名前空間）
			OAUTH_KV: bindings.kv({
				id: "cb6814a41b7c4530a5c75078f3279159",
			}),
			LEDGER: bindings.durableObject({
				worker: "ai-research",
				exportName: "LedgerDO",
			}),
			RUNS: bindings.durableObject({
				worker: "ai-research",
				exportName: "RunDO",
			}),
			LIMITER: bindings.durableObject({
				worker: "ai-research",
				exportName: "HostLimiterDO",
			}),
			ROUTE: bindings.durableObject({
				worker: "ai-research",
				exportName: "RouteDO",
			}),
			// code mode の実行環境（Dynamic Workers）
			LOADER: bindings.workerLoader(),
		},
	},
});
