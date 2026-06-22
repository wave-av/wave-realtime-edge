import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	// RT-R10 (#72): @cloudflare/containers (RecorderContainer's base) imports `cloudflare:workers`, a
	// workerd-only module absent under node. This repo runs vitest in the `node` environment, so alias that
	// virtual module to an inert test stub purely so the worker class graph LOADS (the container path is
	// INERT — never instantiated in tests; wrangler/esbuild bundles the REAL runtime module at deploy).
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
	},
});
