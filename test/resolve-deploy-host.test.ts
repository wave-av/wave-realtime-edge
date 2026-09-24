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
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import {
	resolveDeployHost,
	resolveProductionHost,
	resolveNamedEnvHost,
	hasDeclaredRoute,
	resolveExitCode,
} from "../scripts/ci/resolve-deploy-host.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVER_PATH = resolve(__dirname, "../scripts/ci/resolve-deploy-host.mjs");

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

	it("resolves a MULTILINE top-level routes array — a cosmetic reformat (not a config regression) must not fail closed (coderabbitai review, #487)", () => {
		const toml = `
routes = [
  { pattern = "rt.wave.online", custom_domain = true }
]
`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
	});

	it("ignores a trailing inline comment on the routes line", () => {
		const toml = `routes = [{ pattern = "rt.wave.online", custom_domain = true }] # prod domain\n`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
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

// ── Four-state exit-code discriminator (hasDeclaredRoute / resolveExitCode) ─────────────────────
//
// The discriminator is scoped PER ENV (top-level for production, `[env.<name>]` for anything
// else) exactly like resolveDeployHost's own walk — see the header comment in
// resolve-deploy-host.mjs for why a whole-file scan would be wrong here specifically: it would
// read production's top-level route as "declared" while resolving canary, turning canary's
// deliberate `routes = []` (ROUTE ISOLATION, incident 2026-07-12) into a false "declared but
// unresolved" (exit 1, hard failure) instead of the correct "nothing declared for canary" (exit 2).

describe("hasDeclaredRoute — scoped per env", () => {
	it("STATE 1 (resolved, exit 0): production's actual top-level route — also counts as declared", () => {
		const toml = `routes = [{ pattern = "rt.wave.online", custom_domain = true }]\n`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
		expect(hasDeclaredRoute(toml, "production")).toBe(true);
	});

	it("STATE 2 (declared but unresolved, exit 1): a malformed top-level routes value that resolveProductionHost can't parse into a pattern — a resolver/shape regression, must fail closed", () => {
		const toml = `routes = [{ zone_name = "wave.online" }]\n`; // no pattern key — shape drift
		expect(resolveProductionHost(toml)).toBeNull();
		expect(hasDeclaredRoute(toml, "production")).toBe(true);
	});

	it("STATE 3 (nothing declared, exit 2): no top-level routes key at all", () => {
		const toml = `name = "x"\n[vars]\nFOO = "bar"\n`;
		expect(resolveProductionHost(toml)).toBeNull();
		expect(hasDeclaredRoute(toml, "production")).toBe(false);
	});

	it("STATE 3 (nothing declared, exit 2): canary's ACTUAL shape — routes = [] is an explicit empty declaration, not a regression, and must NOT fail closed", () => {
		const toml = `
routes = [{ pattern = "rt.wave.online", custom_domain = true }]

[env.canary]
workers_dev = true
routes = []
`;
		expect(resolveNamedEnvHost(toml, "canary")).toBeNull();
		expect(hasDeclaredRoute(toml, "canary")).toBe(false);
		// Production's own scope is unaffected by canary's section.
		expect(hasDeclaredRoute(toml, "production")).toBe(true);
	});

	it("STATE 2 (declared but unresolved, exit 1): [env.canary] declares a non-empty routes value that fails to resolve to a pattern — a real regression for canary, must fail closed", () => {
		const toml = `
[env.canary]
routes = [{ zone_name = "wave.online" }]
`;
		expect(resolveNamedEnvHost(toml, "canary")).toBeNull();
		expect(hasDeclaredRoute(toml, "canary")).toBe(true);
	});

	it("STATE 1 (resolved, exit 0): a MULTILINE top-level routes array resolves AND counts as declared — a cosmetic reformat must not fail closed (coderabbitai review, #487: previously resolveProductionHost returned null for this shape while hasDeclaredRoute returned true, producing a false exit 1 on a valid production config)", () => {
		const toml = `
routes = [
  { pattern = "rt.wave.online", custom_domain = true }
]
`;
		expect(resolveProductionHost(toml)).toBe("rt.wave.online");
		expect(resolveExitCode(toml, "production")).toEqual({ host: "rt.wave.online", exitCode: 0 });
	});

	it("STATE 3 (nothing declared, exit 2): a trailing inline comment on an empty routes declaration must NOT be misread as a non-empty value (coderabbitai review, #487: routes = [] # note previously counted as declared because the comment survived into the RHS comparison)", () => {
		const toml = `routes = [] # no custom route\n`;
		expect(hasDeclaredRoute(toml, "production")).toBe(false);
		expect(resolveExitCode(toml, "production")).toEqual({ host: null, exitCode: 2 });
	});

	it("STATE 3 (nothing declared, exit 2): canary's routes = [] with a trailing comment is still an explicit empty declaration, not a regression", () => {
		const toml = `
[env.canary]
routes = [] # ROUTE ISOLATION, see incident 2026-07-12
`;
		expect(hasDeclaredRoute(toml, "canary")).toBe(false);
	});

	it("ignores commented-out route mentions", () => {
		const toml = `
# routes = [{ pattern = "decoy.wave.online" }]
[env.canary]
# route = { pattern = "decoy.wave.online" }
routes = []
`;
		expect(hasDeclaredRoute(toml, "production")).toBe(false);
		expect(hasDeclaredRoute(toml, "canary")).toBe(false);
	});

	// The old isRouteKeyLine compared the route key's OWN line against exactly three sentinels
	// (`""`, `"[]"`, `"{}"`). A multiline-reformatted empty array — `routes = [\n]` — puts only `[`
	// on the key's own line, so its rhs was the bare, unbalanced string `"["`: a fourth shape
	// matching none of the three sentinels, so the key was misread as non-empty ("declared"),
	// turning a legitimate exit-2 skip into a false exit-1 fail-closed. These cover every emptiness
	// shape: single-line `[]`/`{}`, and the multiline case the old sentinel check could not see —
	// both at the top level (production) and under `[env.canary]` — plus a genuinely populated
	// multiline route, so the fix doesn't overcorrect into a false negative.

	it("STATE 3 (nothing declared, exit 2): single-line empty `routes = []` at the top level", () => {
		const toml = `routes = []\n`;
		expect(hasDeclaredRoute(toml, "production")).toBe(false);
		expect(resolveExitCode(toml, "production")).toEqual({ host: null, exitCode: 2 });
	});

	it("STATE 3 (nothing declared, exit 2): single-line empty `route = {}` under [env.canary]", () => {
		const toml = `[env.canary]\nroute = {}\n`;
		expect(hasDeclaredRoute(toml, "canary")).toBe(false);
	});

	it("STATE 3 (nothing declared, exit 2): MULTILINE empty `routes = [\\n]` at the top level — the exact false-positive this file fixes (old code read this as declared/exit 1)", () => {
		const toml = `
name = "wave-realtime-edge"
routes = [
]
`;
		expect(hasDeclaredRoute(toml, "production")).toBe(false);
		expect(resolveExitCode(toml, "production")).toEqual({ host: null, exitCode: 2 });
	});

	it("STATE 3 (nothing declared, exit 2): MULTILINE empty `routes = [\\n]` under [env.canary]", () => {
		const toml = `
[env.canary]
routes = [
]
`;
		expect(hasDeclaredRoute(toml, "canary")).toBe(false);
		expect(resolveExitCode(toml, "canary")).toEqual({ host: null, exitCode: 2 });
	});

	it("STATE 3 (nothing declared, exit 2): MULTILINE empty inline-table with a comment continuation line before the close", () => {
		const toml = `
[env.canary]
route = {
  # nothing here yet
}
`;
		expect(hasDeclaredRoute(toml, "canary")).toBe(false);
	});

	it("STATE 1 (resolved, exit 0): a genuinely populated MULTILINE routes array under [env.canary] is declared — the fix must not turn every multiline array into a false negative", () => {
		const toml = `
[env.canary]
routes = [
  { pattern = "canary.rt.wave.online", custom_domain = true }
]
`;
		expect(hasDeclaredRoute(toml, "canary")).toBe(true);
		expect(resolveExitCode(toml, "canary")).toEqual({ host: "canary.rt.wave.online", exitCode: 0 });
	});
});

// ── exit 3 (unexpected crash) — the CLI entrypoint's fourth state ──────────────────────────────
//
// resolveExitCode() itself never crashes (a pure function over a string or null); exit 3 is
// reserved for the CLI block's own try/catch around readFileSync + resolveExitCode + process.exit.
// This repo shipped the four-state contract with no test ever driving that path — spawn the
// actual script as a subprocess against a wrangler.toml that fails to read for a reason OTHER
// than ENOENT (here: the path is a directory, so readFileSync throws EISDIR) and assert it exits
// 3, not 1.
describe("CLI entrypoint — exit 3 on an unexpected (non-ENOENT) read failure", () => {
	it("exits 3, not 1, when wrangler.toml exists but fails to read for a non-ENOENT reason", () => {
		// realpathSync: on macOS, os.tmpdir() resolves through a symlink (/tmp -> /private/tmp); the
		// resolver's own `import.meta.url === file://${process.argv[1]}` entrypoint guard compares
		// against the SYMLINK-RESOLVED module URL, so an unresolved tmp path here would silently
		// fail that guard, skip the whole CLI block, and exit 0 — never reaching the crash path.
		const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "resolve-deploy-host-exit3-")));
		const scriptDir = join(tmpRoot, "scripts", "ci");
		mkdirSync(scriptDir, { recursive: true });
		const scriptCopy = join(scriptDir, "resolve-deploy-host.mjs");
		copyFileSync(RESOLVER_PATH, scriptCopy);
		// wrangler.toml as a DIRECTORY (not a file): readFileSync throws EISDIR, a non-ENOENT error
		// the script must NOT swallow as "absent" (exit 2) — it must fall through to the crash path.
		mkdirSync(join(tmpRoot, "wrangler.toml"));
		const result = spawnSync(process.execPath, [scriptCopy, "production"], { encoding: "utf8" });
		expect(result.status).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/crashed while resolving the deploy host/);
	});
});

describe("resolveExitCode — the CLI entrypoint's own exit-code decision", () => {
	it("STATE 1: production resolved — exit 0 with the hostname (this repo's actual shape)", () => {
		const toml = `routes = [{ pattern = "rt.wave.online", custom_domain = true }]\n`;
		expect(resolveExitCode(toml, "production")).toEqual({ host: "rt.wave.online", exitCode: 0 });
	});

	it("STATE 2: production declared but unresolved — exit 1 with a null host", () => {
		const toml = `routes = [{ zone_name = "wave.online" }]\n`;
		expect(resolveExitCode(toml, "production")).toEqual({ host: null, exitCode: 1 });
	});

	it("STATE 3: canary's actual shape (routes = [], deliberate) — exit 2 with a null host, NOT a failure", () => {
		const toml = `
routes = [{ pattern = "rt.wave.online", custom_domain = true }]

[env.canary]
workers_dev = true
routes = []
`;
		expect(resolveExitCode(toml, "canary")).toEqual({ host: null, exitCode: 2 });
	});

	it("STATE 3 (ENOENT equivalent): tomlSrcOrNull === null (wrangler.toml absent) — exit 2 with a null host", () => {
		expect(resolveExitCode(null, "production")).toEqual({ host: null, exitCode: 2 });
		expect(resolveExitCode(null, "canary")).toEqual({ host: null, exitCode: 2 });
	});
});
