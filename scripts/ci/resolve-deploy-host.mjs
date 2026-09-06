#!/usr/bin/env node
// scripts/ci/resolve-deploy-host.mjs — print the bare hostname `wrangler deploy` just published
// to, for a given target env ("production" or "canary"), by reading it straight out of
// wrangler.toml (the ONE place guaranteed correct, because it is what wrangler actually deployed).
//
// wave-realtime-edge ADAPTATION of the proven wave-spoke-template script: most spokes gate every
// env behind its own `[env.<name>]` block with a `routes` table. This repo does NOT — per the
// ROUTES PLACEMENT LAW comment in wrangler.toml, the TOP-LEVEL `routes = [...]` key IS the
// deployed production config (rt.wave.online, workers_dev = false). `production` therefore reads
// the top-level `routes[].pattern`, not an `[env.production]` section (this repo has none).
// `canary` deploys via `[env.canary]`, which deliberately sets `routes = []` + `workers_dev =
// true` (incident 2026-07-12: an inherited top-level route let a canary steal the prod host) — so
// canary has NO custom-domain host to resolve, by design, not by regression.
//
// FOUR-STATE exit contract (wave-foundation#1453 / wave-spoke-template#77 postmortem, corrected
// 2026-09-05 — see wave-vision-ingest#15 gitar-bot thread, which correctly flagged the original
// two-state fix that hard-failed ANY empty resolver output for production): a bare "resolved or
// not" collapses two different states the caller MUST treat differently, so the resolver itself
// now tells the caller which:
//   exit 0 + hostname on stdout = resolved.
//   exit 1 + empty stdout       = a route IS declared in this env's own scope, but did not
//                                 resolve — a resolver/TOML-shape regression (the wave-email-edge
//                                 run 33994760933 defect: a route existed and this script failed
//                                 to parse it). Unverifiable. The caller must fail closed.
//   exit 2 + empty stdout       = no route is declared in this env's own scope — production's
//                                 top-level `routes` key absent, or (canary's actual, deliberate
//                                 shape) an `[env.<name>]` section whose `routes` key is present
//                                 but explicitly EMPTY (`routes = []`, `route = {}`) or whose
//                                 section is absent altogether. Nothing to verify; safe to skip.
//                                 wrangler.toml absent (ENOENT) is the same state.
//   exit 3 + empty stdout       = this script itself crashed unexpectedly.
//
// The "declared" check below is scoped PER ENV exactly like the host-resolution walk above it
// (top-level-before-first-table for production; the `[env.<name>]` section for anything else) —
// NOT a whole-file scan. A whole-file scan would wrongly flag canary's deploys as "declared but
// unresolved" (exit 1, hard failure) merely because PRODUCTION's top-level routes key exists
// elsewhere in the same wrangler.toml; canary's own `routes = []` is a deliberate empty
// declaration, the same "nothing to verify" state as no key at all, not a parse regression.
//
// Usage: node scripts/ci/resolve-deploy-host.mjs <production|canary>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
export const WRANGLER_TOML = resolve(__dir, "../../wrangler.toml");

/** Strip a trailing `# comment` from a TOML line, respecting simple double-quoted strings (a `#`
 *  inside quotes is data, not a comment start). Not a full TOML parser — this repo's route lines
 *  never contain an escaped quote or a `#` inside a pattern string, and this is only relied on to
 *  keep the four-state discriminator (hasDeclaredRoute, below) from misreading `routes = [] # ...`
 *  as a non-empty (declared) value (coderabbitai review, wave-realtime-edge#487). */
function stripTrailingComment(line) {
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"' && line[i - 1] !== "\\") inQuotes = !inQuotes;
		else if (ch === "#" && !inQuotes) return line.slice(0, i);
	}
	return line;
}

/** Pure: given the raw wrangler.toml text, return the first TOP-LEVEL `routes[].pattern` (the
 *  production custom domain), or null if absent. Stops scanning at the first `[section]` header
 *  (top-level keys, by TOML convention, precede every table) so it can never match a `routes`
 *  key that appears inside e.g. `[env.canary]`. Skips `#`-comment lines — this file's own header
 *  above mentions "routes" in prose, and a naive scan of THIS file would otherwise self-match.
 *  Scans for `pattern = "..."` on ANY top-level line (not requiring `routes =` on the SAME line)
 *  so a multiline `routes = [\n  { pattern = "...", ... }\n]` array — the style used elsewhere in
 *  this same file for `[env.<name>]` sections (see resolveNamedEnvHost below) — resolves here too;
 *  a same-line-only match would let a merely-reformatted (not actually broken) production route
 *  fail closed as "declared but unresolved" (coderabbitai review, wave-realtime-edge#487). */
export function resolveProductionHost(tomlSrc) {
	const lines = tomlSrc.split("\n");
	for (const rawLine of lines) {
		const line = stripTrailingComment(rawLine).trim();
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("[")) break; // reached the first table — top-level keys are exhausted
		const m = /pattern\s*=\s*"([^"/]+)/.exec(line);
		if (m) return m[1];
	}
	return null;
}

/** Pure: given the raw wrangler.toml text and an env name, return the first route hostname under
 *  `[env.<envName>]` (and its live, non-commented subsections), or null if the section/route is
 *  absent. Mirrors wave-spoke-template's resolveDeployHost for named-env sections — used here for
 *  `canary`, which (by design, see header) currently has none. */
export function resolveNamedEnvHost(tomlSrc, envName) {
	const lines = tomlSrc.split("\n");
	const sectionHeader = `[env.${envName}]`;
	const subsectionPrefix = `[env.${envName}.`;
	let inSection = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("#")) continue;
		if (line === sectionHeader) {
			inSection = true;
			continue;
		}
		if (inSection && line.startsWith("[")) {
			inSection = line.startsWith(subsectionPrefix);
			continue;
		}
		if (inSection) {
			const m = /pattern\s*=\s*"([^"/]+)/.exec(line);
			if (m) return m[1];
		}
	}
	return null;
}

/** Pure dispatcher: production reads the top-level routes key; every other env name reads its
 *  own `[env.<name>]` section (present today only for the shape, since canary's is `routes = []`
 *  and so never matches). */
export function resolveDeployHost(tomlSrc, envName) {
	if (envName === "production") return resolveProductionHost(tomlSrc);
	return resolveNamedEnvHost(tomlSrc, envName);
}

/** Pure: true if a `routes`/`route` key with a NON-EMPTY value is declared for `envName`'s OWN
 *  scope — the top-level (before the first `[table]`) for "production", or the `[env.<name>]`
 *  section (and its live subsections) for anything else. Scoped to match resolveDeployHost()'s
 *  own walk exactly, on purpose: this is the discriminator between "a route is declared for THIS
 *  env but didn't resolve" (exit 1, must fail closed) and "nothing is declared for THIS env"
 *  (exit 2, safe to skip) — collapsing the scope to a whole-file scan would wrongly read
 *  production's top-level route as "declared" while resolving canary, turning canary's
 *  deliberate `routes = []` (ROUTE ISOLATION, incident 2026-07-12) into a hard failure.
 *  An empty declaration (`routes = []`, `route = {}`, or a bare `routes =`/`route =` with nothing
 *  after it) counts as NOT declared — TOML's own way of saying "explicitly no route here", the
 *  same "nothing to verify" state as the key being absent entirely, not a parse regression. */
export function hasDeclaredRoute(tomlSrc, envName) {
	const lines = tomlSrc.split("\n");
	// `line` here is ALREADY comment-stripped (via stripTrailingComment, applied by both loops
	// below) so a trailing `# ...` on e.g. `routes = [] # no custom route` can never masquerade
	// as part of the value and misclassify a deliberate empty declaration as non-empty
	// (coderabbitai review, wave-realtime-edge#487).
	const isRouteKeyLine = (line) => {
		const m = /^(routes|route)\s*=\s*(.*)$/.exec(line);
		if (!m) return false;
		const rhs = m[2].trim();
		return rhs !== "" && rhs !== "[]" && rhs !== "{}";
	};
	if (envName === "production") {
		for (const rawLine of lines) {
			const line = stripTrailingComment(rawLine).trim();
			if (line === "") continue;
			if (line.startsWith("[")) break; // top-level keys are exhausted at the first table
			if (isRouteKeyLine(line)) return true;
		}
		return false;
	}
	const sectionHeader = `[env.${envName}]`;
	const subsectionPrefix = `[env.${envName}.`;
	let inSection = false;
	for (const rawLine of lines) {
		const line = stripTrailingComment(rawLine).trim();
		if (line === "") continue;
		if (line === sectionHeader) {
			inSection = true;
			continue;
		}
		if (inSection && line.startsWith("[")) {
			inSection = line.startsWith(subsectionPrefix);
			continue;
		}
		if (inSection && isRouteKeyLine(line)) return true;
	}
	return false;
}

/** Pure: given the raw wrangler.toml text (or null if wrangler.toml is absent — ENOENT) and an
 *  env name, return `{ host, exitCode }` per the four-state exit contract in the header comment.
 *  Kept separate from readFileSync/process.exit specifically so the exit-code decision (including
 *  the ENOENT-as-null path) is unit-testable without spawning a subprocess. */
export function resolveExitCode(tomlSrcOrNull, envName) {
	if (tomlSrcOrNull === null) return { host: null, exitCode: 2 };
	const host = resolveDeployHost(tomlSrcOrNull, envName);
	if (host) return { host, exitCode: 0 };
	return { host: null, exitCode: hasDeclaredRoute(tomlSrcOrNull, envName) ? 1 : 2 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const envName = process.argv[2];
	if (envName !== "production" && envName !== "canary") {
		console.error("usage: resolve-deploy-host.mjs <production|canary>");
		process.exit(1);
	}
	try {
		let src = null;
		try {
			src = readFileSync(WRANGLER_TOML, "utf8");
		} catch (err) {
			if (err.code !== "ENOENT") throw err; // any OTHER read error is an unexpected crash below
		}
		const { host, exitCode } = resolveExitCode(src, envName);
		if (host) process.stdout.write(host);
		process.exit(exitCode);
	} catch (err) {
		// An unexpected crash (a parser bug, a permissions error reading wrangler.toml, etc.) is NOT
		// the same state as "a route is declared but unresolved" (exit 1) — Node's default exit code
		// for an uncaught exception is 1, which would silently conflate the two. Exit 3 is reserved
		// for this distinct, genuinely-unexpected state.
		console.error(`resolve-deploy-host.mjs crashed while resolving the deploy host: ${err.stack || err}`);
		process.exit(3);
	}
}
