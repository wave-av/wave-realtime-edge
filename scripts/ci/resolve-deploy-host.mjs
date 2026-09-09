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

/** Pure: given the (already comment-stripped, trimmed) right-hand side of a `routes = ` /
 *  `route = ` key on line `allLines[index]`, decide whether the value it introduces is EMPTY — a
 *  same-line `[]` / `{}`, or a MULTILINE array/inline-table whose brackets contain nothing but
 *  blank lines and comments before they close (e.g. `routes = [\n]`, a cosmetic reformat of
 *  `routes = []` — the exact shape the old three-sentinel check
 *  (`rhs !== "" && rhs !== "[]" && rhs !== "{}"`) could not see: its rhs was the bare, unbalanced
 *  string `"["`, a fourth shape matching none of the three sentinels, so the key was misread as
 *  non-empty ("declared"), turning canary's or production's legitimate exit-2 skip into a false
 *  exit-1 fail-closed).
 *
 *  Tracks BRACKET DEPTH across as many continuation lines as it takes to close, so it is correct
 *  regardless of how many lines the empty array/table is split across, not just one extra shape.
 *  ANY non-bracket, non-whitespace content between the opening and closing bracket — on the key's
 *  own line or a continuation line — counts as non-empty, matching how the `pattern = "..."`
 *  regex in resolveProductionHost()/resolveNamedEnvHost() would find a real route inside that same
 *  span. */
function isRouteValueEmpty(rhs, allLines, index) {
	const bracketDelta = (s) => {
		let delta = 0;
		for (const ch of s) {
			if (ch === "[" || ch === "{") delta++;
			else if (ch === "]" || ch === "}") delta--;
		}
		return delta;
	};
	const hasContent = (s) => s.replace(/[[\]{}]/g, "").trim() !== "";
	if (hasContent(rhs)) return false; // real content already on the key's own line
	let depth = bracketDelta(rhs);
	if (depth <= 0) return true; // "[]" / "{}" / bare "" — already balanced (or never opened): empty
	for (let i = index + 1; i < allLines.length; i++) {
		const next = stripTrailingComment(allLines[i]).trim();
		if (next === "") continue; // blank/fully-commented continuation line: keep looking
		if (hasContent(next)) return false; // real content on a continuation line
		depth += bracketDelta(next);
		if (depth <= 0) return true; // closed with nothing but brackets/whitespace in between
	}
	return true; // ran off the end without closing — no content was ever found, so not "declared"
}

/** Pure: true if a `routes`/`route` key with a NON-EMPTY value is declared for `envName`'s OWN
 *  scope — the top-level (before the first `[table]`) for "production", or the `[env.<name>]`
 *  section (and its live subsections) for anything else. Scoped to match resolveDeployHost()'s
 *  own walk exactly, on purpose: this is the discriminator between "a route is declared for THIS
 *  env but didn't resolve" (exit 1, must fail closed) and "nothing is declared for THIS env"
 *  (exit 2, safe to skip) — collapsing the scope to a whole-file scan would wrongly read
 *  production's top-level route as "declared" while resolving canary, turning canary's
 *  deliberate `routes = []` (ROUTE ISOLATION, incident 2026-07-12) into a hard failure.
 *  An empty declaration (`routes = []`, `route = {}`, a bare `routes =`/`route =` with nothing
 *  after it, or the same split across multiple lines) counts as NOT declared — TOML's own way of
 *  saying "explicitly no route here", the same "nothing to verify" state as the key being absent
 *  entirely, not a parse regression; see isRouteValueEmpty() above for the multiline case this
 *  used to get wrong. */
export function hasDeclaredRoute(tomlSrc, envName) {
	const lines = tomlSrc.split("\n");
	// `allLines`/`index` are threaded through so isRouteKeyLine() can look ahead across a multiline
	// `routes = [ ... ]` value via isRouteValueEmpty() above.
	const isRouteKeyLine = (allLines, index) => {
		const line = stripTrailingComment(allLines[index]).trim();
		const m = /^(routes|route)\s*=\s*(.*)$/.exec(line);
		if (!m) return false;
		return !isRouteValueEmpty(m[2].trim(), allLines, index);
	};
	if (envName === "production") {
		for (let i = 0; i < lines.length; i++) {
			const line = stripTrailingComment(lines[i]).trim();
			if (line === "") continue;
			if (line.startsWith("[")) break; // top-level keys are exhausted at the first table
			if (isRouteKeyLine(lines, i)) return true;
		}
		return false;
	}
	const sectionHeader = `[env.${envName}]`;
	const subsectionPrefix = `[env.${envName}.`;
	let inSection = false;
	for (let i = 0; i < lines.length; i++) {
		const line = stripTrailingComment(lines[i]).trim();
		if (line === "") continue;
		if (line === sectionHeader) {
			inSection = true;
			continue;
		}
		if (inSection && line.startsWith("[")) {
			inSection = line.startsWith(subsectionPrefix);
			continue;
		}
		if (inSection && isRouteKeyLine(lines, i)) return true;
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
