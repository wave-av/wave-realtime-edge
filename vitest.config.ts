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
		coverage: {
			// v8, not istanbul. The istanbul provider is only required when tests execute inside
			// workerd, which does not expose V8's profiler (cloudflare/workers-sdk#14463). This
			// suite runs in `environment: "node"` (see above), so the V8 provider applies.
			provider: "v8",
			reporter: ["text", "lcov"],
			reportsDirectory: "./coverage",
			// Scope to shipped worker source. `test/` holds the suite and its stubs — including
			// test/stubs/cloudflare-workers.ts, which exists only to satisfy the alias above and
			// would otherwise be scored as if it were production code.
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
		},
	},
});
