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
// canary has NO custom-domain host to resolve. This script exits 1/empty for canary by design;
// deploy.yml's post-deploy verify step treats that as "skip live verification", exactly like the
// template does for any env with no route configured yet.
//
// Usage: node scripts/ci/resolve-deploy-host.mjs <production|canary>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
export const WRANGLER_TOML = resolve(__dir, "../../wrangler.toml");

/** Pure: given the raw wrangler.toml text, return the first TOP-LEVEL `routes[].pattern` (the
 *  production custom domain), or null if absent. Stops scanning at the first `[section]` header
 *  (top-level keys, by TOML convention, precede every table) so it can never match a `routes`
 *  key that appears inside e.g. `[env.canary]`. Skips `#`-comment lines — this file's own header
 *  above mentions "routes" in prose, and a naive scan of THIS file would otherwise self-match. */
export function resolveProductionHost(tomlSrc) {
	const lines = tomlSrc.split("\n");
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.startsWith("#")) continue;
		if (line.startsWith("[")) break; // reached the first table — top-level keys are exhausted
		const m = /^routes\s*=\s*\[.*?pattern\s*=\s*"([^"/]+)/.exec(line);
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

if (import.meta.url === `file://${process.argv[1]}`) {
	const envName = process.argv[2];
	if (envName !== "production" && envName !== "canary") {
		console.error("usage: resolve-deploy-host.mjs <production|canary>");
		process.exit(1);
	}
	const src = readFileSync(WRANGLER_TOML, "utf8");
	const host = resolveDeployHost(src, envName);
	if (!host) process.exit(1);
	process.stdout.write(host);
}
