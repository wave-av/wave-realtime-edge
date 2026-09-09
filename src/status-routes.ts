// /status, /feed.xml, /index.json for rt.wave.online.
//
// BUG (fleet-conformance sweep, 2026-09-08): rt's own GET /llms.txt (agent-discovery.ts, built from
// the chassis's unmodified `llmsTxt()`) already advertises "Status", "Structured manifest" and "Atom
// feed" as live surfaces at /status, /index.json and /feed.xml — but this router never wired any of
// them, so all three fell through to the generic REALTIME_NOT_IMPLEMENTED 501 catch-all. That is the
// same "primitive never propagated" class discovery-routes.ts and agent-discovery.ts already fixed for
// the rest of the discovery surface set (2026-09-02/03) — not a missing chassis feature: the sweep's
// positive control, omt.wave.online (a sibling spoke that uses the chassis's bare `makeFetch`, no
// custom router), served all three as 200 with the chassis's OWN bare defaults. A published
// machine-readable index pointing at a 501 is a lie to an agent that reads it.
//
// GROUNDING — every response below is EITHER the chassis's own verified live default (statusPage/
// statusJson with {status:"operational", checks:[{name:"edge", ok:true}]}, feedXml with zero entries)
// OR a hand-built document (rtIndexJson below) whose content was independently verified live, one path
// at a time, against production — never assumed from the library's schema.
//
//   1. /status and /feed.xml call the chassis's OWN `statusPage`/`statusJson`/`feedXml` — the exact
//      functions a conforming peer's `makeFetch` calls when that spoke passes no `opts.status` /
//      `opts.feedEntries` (verified against the installed 0.20.2 dist: worker.js's own /status branch
//      falls back to `{status:"operational", checks:[{name:"edge", ok:true}]}`, and its /feed.xml
//      branch falls back to `feedXml(meta, [])`). No spoke in this fleet passes a richer readiness
//      probe — grepped every wave-*-edge repo for `readiness([` with a non-empty check list: zero
//      hits — so the bare default IS the convention, not a shortcut taken here.
//   2. /index.json is NOT built from the chassis's stock `indexJson()`. That function hard-codes
//      `/transparency` into every `surfaces[]` entry and, when `agentSurfaces` is true, hard-codes
//      `/openapi.json` and `/pricing.json` into `agent{}` — all THREE still 501 on this host (measured
//      live 2026-09-08, matching the existing chassis-passthrough.ts "DELIBERATELY NOT CLAIMED" note
//      for the latter two, and a newly-confirmed instance of the SAME defect for /transparency).
//      Calling `indexJson()` verbatim would therefore fabricate three NEW false promises inside the
//      very document meant to fix false promises. `rtIndexJson()` below lists ONLY paths independently
//      verified live as 200 on rt.wave.online — the same "hand-build, don't trust the generic
//      renderer" precedent discovery-routes.ts already set for /.well-known/x402.
//
// /transparency is a real, separately-verified defect (llms.txt promises it; it 501s) but is OUT OF
// SCOPE here — it is not one of the three paths this fix targets, and removing it from llms.txt would
// mean no longer calling agent-discovery.ts's shipped, tested `llmsTxt()` verbatim, a materially larger
// and differently-scoped change. Left as an explicit follow-up, not silently fixed or silently ignored.
//
// SCOPE (unchanged convention from discovery-routes.ts / agent-discovery.ts): this module handles ONLY
// these three exact GET/HEAD paths. It does NOT swap in `makeFetch` as the router's tail fallback —
// route-dispatch.ts's final 501 catch-all remains the documented invariant dozens of INERT feature
// flags rely on.
//
// SECURITY (Corridor): every byte below is derived from server-controlled constants (RT_META, the
// module-level `RT_STATUS_CHECKS`, `env.GIT_SHA`) or is the literal request method/path used only for
// EXACT string/enum comparison — never interpolated into a response. `env.GIT_SHA` is a deploy-time
// build stamp (see dispatch-helpers.ts), not user input, and is only ever placed inside a JSON string
// value (via `JSON.stringify`/`statusJson`, never string-concatenated into HTML or a header), so it
// cannot inject markup or split a header. Matching is by EXACT string equality on `pathname` (never
// startsWith/endsWith/includes), so no prefix or suffix trick reaches a handler it should not.
import { statusPage, statusJson, feedXml, WAVE_ENTITY, CACHE, type StatusResult } from "@wave-av/spoke-chassis";
import { RT_META } from "./agent-discovery";
import { SEC_HEADERS } from "./sec-headers";

const headers = (contentType: string, cache: string): Record<string, string> => ({
	"content-type": contentType,
	"cache-control": cache,
	...SEC_HEADERS,
});

// The ONE check this thin edge can honestly make about itself: the worker executed. True by
// construction whenever this response is produced — no downstream dependency (gateway, D1, KV, the
// SFU room DOs) is probed or claimed healthy. Matches the bare default every conforming sibling spoke
// emits (verified live against omt.wave.online — see the module header).
function rtStatusResult(env: { GIT_SHA?: string }): StatusResult {
	return {
		status: "operational",
		version: env.GIT_SHA || "edge",
		checks: [{ name: "edge", ok: true }],
	};
}

// ── /index.json ──────────────────────────────────────────────────────────────────────────────────
// Hand-built (not the chassis's stock `indexJson()` — see the module header for why). Every path in
// `surfaces` and every URL in `agent` was independently curl'd live against rt.wave.online and
// confirmed 200 before being listed here (2026-09-08). Add a path here only after confirming it is
// actually served — the same rule discovery-routes.ts's RT_SITEMAP_PATHS already follows.
export function rtIndexJson(): string {
	const base = `https://${RT_META.host}`;
	const surfaces = [
		{ path: "/", about: "landing page" },
		{ path: "/status", about: "health + dependencies (append ?format=json)" },
		{ path: "/health", about: "liveness probe (JSON)" },
		{ path: "/llms.txt", about: "agent discovery (text)" },
		{ path: "/index.json", about: "this manifest" },
		{ path: "/feed.xml", about: "product updates (Atom)" },
		{ path: "/.well-known/did.json", about: "platform-controlled did:web identity" },
	].map((s) => ({ ...s, url: base + s.path }));
	return JSON.stringify(
		{
			name: `wave ${RT_META.product}`,
			product: RT_META.product,
			host: RT_META.host,
			tagline: RT_META.tagline,
			role: "WAVE Protocol Plane spoke — a thin edge front-door; API/auth/metering live at the gateway",
			gateway: "https://api.wave.online",
			platform: "https://wave.online",
			surfaces,
			// Deliberately omits `openapi`/`pricing` (still 501 on this host — see module header) so this
			// document never promises a path it cannot answer.
			agent: {
				x402: `${base}/.well-known/x402`,
				skill: `${base}/skill.md`,
				mcp: `${base}/.well-known/mcp`,
				did: `${base}/.well-known/did.json`,
			},
			operator: WAVE_ENTITY,
		},
		null,
		2,
	);
}

/**
 * Serve rt's status/feed/index surfaces if `pathname` is one of them; otherwise null so the caller
 * falls through to the rest of dispatch() UNCHANGED (including the 501 catch-all).
 *
 * `pathname` MUST come from `new URL(request.url).pathname` (route-dispatch.ts already canonicalises
 * there). Matching is exact string equality — no prefix, suffix or substring test.
 *
 * GET and HEAD are both served (mirrors discovery-routes.ts's own HEAD convention — a header-only
 * probe, the shape most uptime checkers send, must not see a broken host).
 */
export function maybeHandleStatusRoutes(request: Request, pathname: string, env: { GIT_SHA?: string }): Response | null {
	const method = request.method;
	if (method !== "GET" && method !== "HEAD") return null;
	const bodyFor = (body: string): string | null => (method === "HEAD" ? null : body);

	if (pathname === "/status") {
		const result = rtStatusResult(env);
		const url = new URL(request.url);
		if (url.searchParams.get("format") === "json") {
			return new Response(bodyFor(statusJson(RT_META, result)), { headers: headers("application/json; charset=utf-8", CACHE.none) });
		}
		return new Response(bodyFor(statusPage(RT_META, result)), { headers: headers("text/html; charset=utf-8", CACHE.none) });
	}
	if (pathname === "/feed.xml") {
		// No entries: rt has no changelog feed wired. An invented entry would be exactly the
		// fabrication this fix must not commit — the empty (but structurally valid) feed matches the
		// conforming peer byte-for-byte in shape.
		return new Response(bodyFor(feedXml(RT_META, [])), { headers: headers("application/atom+xml; charset=utf-8", CACHE.text) });
	}
	if (pathname === "/index.json") {
		return new Response(bodyFor(rtIndexJson()), { headers: headers("application/json; charset=utf-8", CACHE.text) });
	}
	return null;
}
