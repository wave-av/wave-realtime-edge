/**
 * test/resolve-deploy-host.test.ts — vitest coverage for scripts/ci/resolve-deploy-host.mjs's pure
 * wrangler.toml parsing. No filesystem, no network.
 *
 * wave-realtime-edge's wrangler.toml has NO `[env.production]` block — per the ROUTES PLACEMENT
 * LAW comment in wrangler.toml, the top-level `routes = [...]` key IS the deployed production
 * config (rt.wave.online). `canary` deploys via `[env.canary]`, which sets `routes = []` on
 * purpose (incident 2026-07-12) — no custom-domain host to resolve there.
 */
import { describe, it, expect } from "vitest";
import { resolveDeployHost, resolveProductionHost, resolveNamedEnvHost } from "../scripts/ci/resolve-deploy-host.mjs";

describe("resolveProductionHost — top-level routes key", () => {
	it("finds the top-level production route (this repo's actual shape)", () => {
		const toml = `
name = "wave-realtime-edge"
main = "src/worker.ts"
workers_dev = false
routes = [{ pattern = "rt.wave.online", custom_domain = true }]

[observability]
enabled = true
`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
	});

	it("stops at the first table header — never bleeds into [env.canary]", () => {
		const toml = `
routes = [{ pattern = "rt.wave.online", custom_domain = true }]

[env.canary]
routes = []
`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
	});

	it("ignores a commented-out routes mention in prose", () => {
		const toml = `
# routes = [{ pattern = "decoy.wave.online" }] — old sketch, do not use
routes = [{ pattern = "rt.wave.online", custom_domain = true }]
`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
	});

	it("returns null when no top-level routes key exists", () => {
		const toml = `name = "x"\n[vars]\nFOO = "bar"\n`;
		expect(resolveProductionHost(toml)).toBeNull();
	});
});

describe("resolveNamedEnvHost — [env.<name>] section (used for canary)", () => {
	it("returns null for canary's actual shape (routes = [], workers.dev only, by design)", () => {
		const toml = `
[env.canary]
workers_dev = true
routes = []

[env.canary.vars]
FOO = "bar"
`;
		expect(resolveNamedEnvHost(toml, "canary")).toBeNull();
	});

	it("would find a route if one were ever added under [env.canary]", () => {
		const toml = `
[env.canary]
routes = [{ pattern = "canary.rt.wave.online", custom_domain = true }]
`;
		expect(resolveNamedEnvHost(toml, "canary")).toBe("canary.rt.wave.online");
	});
});

describe("resolveDeployHost — dispatcher", () => {
	const toml = `
routes = [{ pattern = "rt.wave.online", custom_domain = true }]

[env.canary]
workers_dev = true
routes = []
`;
	it("production reads the top-level key", () => {
		expect(resolveDeployHost(toml, "production")).toBe("rt.wave.online");
	});
	it("canary reads its own section (empty today, null)", () => {
		expect(resolveDeployHost(toml, "canary")).toBeNull();
	});
});
