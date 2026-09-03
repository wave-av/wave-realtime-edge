// Agent-discovery well-knowns for rt.wave.online — GET /llms.txt, GET /.well-known/agent-card.json,
// GET /skill.md.
//
// BUG (surface-sweep, 2026-09-02): this spoke's fetch() is a fully custom router (route-dispatch.ts)
// that never wired the chassis's standard discovery surfaces the way every sibling spoke does via
// `makeFetch(landingPage, favicon, { meta })` (@wave-av/spoke-chassis worker.ts) — so these three
// paths fell through to the generic `REALTIME_NOT_IMPLEMENTED` 501 catch-all. Live receipt that
// motivated this fix (2026-09-02): `curl -sI https://rt.wave.online/llms.txt` → 501; same for
// `/.well-known/agent-card.json` and `/skill.md`. `GET /` and `GET /health` were unaffected (both
// handled earlier in dispatch()).
//
// SCOPE: this module intentionally handles ONLY these three GET paths — it does NOT swap in
// `makeFetch` as the router's tail fallback. route-dispatch.ts's final 501 catch-all is a documented
// invariant that dozens of INERT feature flags in this file rely on ("falls through to the 501
// catch-all, UNCHANGED") — replacing that tail with the chassis's default gateway-federation proxy
// would silently change behavior for every one of those flags' unmatched paths, which is out of
// scope for a discovery-surface fix. `/openapi.json`, `/robots.txt`, `/sitemap.xml`, `/status`, etc.
// stay 501 for now (tracked as a follow-up if the product ever needs the full chassis surface set).
import { llmsTxt, agentCard, skillMd, type SpokeMeta } from "@wave-av/spoke-chassis";

// Mirrors landing.ts's `shell()` metadata (product/host/accentHex) so the discovery surfaces and the
// branded landing describe the SAME product identically — one fact, not two copies that can drift.
export const RT_META: SpokeMeta = {
	product: "Realtime",
	host: "rt.wave.online",
	tagline:
		"The interactive half of the WAVE protocol plane — real IETF WHIP ingest, WHEP egress, and RealtimeKit rooms, gated on the exact same gateway and token as WAVE broadcast.",
	accentHex: "#ff715d",
	// No /openapi.json is served by this spoke yet (see SCOPE above) — declare that explicitly per
	// SpokeMeta's contract rather than leaving `productPaths` silently unset.
	productPathsDeclared: false,
};

const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" };
const APP_JSON = { "content-type": "application/json; charset=utf-8" };
const TEXT_MARKDOWN = { "content-type": "text/markdown; charset=utf-8" };

/** Serve the three agent-discovery GET well-knowns if `request` matches one; otherwise null so the
 *  caller falls through to the rest of dispatch() unchanged. */
export function maybeHandleAgentDiscovery(request: Request, pathname: string): Response | null {
	if (request.method !== "GET") return null;
	if (pathname === "/llms.txt") {
		return new Response(llmsTxt(RT_META), { headers: TEXT_PLAIN });
	}
	if (pathname === "/.well-known/agent-card.json") {
		return new Response(agentCard(RT_META), { headers: APP_JSON });
	}
	if (pathname === "/skill.md") {
		return new Response(skillMd(RT_META), { headers: TEXT_MARKDOWN });
	}
	return null;
}
