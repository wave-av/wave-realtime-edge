// Crawler + commerce discovery surfaces for rt.wave.online — GET/HEAD /robots.txt, /sitemap.xml,
// /favicon.ico, /favicon.svg, and /.well-known/x402.
//
// BUG (RT catch-all sweep, 2026-09-03): rt is the ONE spoke whose fetch() is a fully custom router
// (route-dispatch.ts) instead of the chassis `makeFetch(landingPage, favicon, { meta })` every sibling
// uses. makeFetch serves all five of these paths out of the box (@wave-av/spoke-chassis worker.ts:
// `/favicon.svg|/favicon.ico` at :160, `serveDiscovery()` for robots/sitemap, `wellKnownX402(meta)` at
// :236). rt never wired ANY of it, so all five fell through to the generic REALTIME_NOT_IMPLEMENTED
// 501 catch-all. This is the SAME "primitive never propagated" class as agent-discovery.ts (which
// fixed /llms.txt, /.well-known/agent-card.json and /skill.md on 2026-09-02) — not a missing chassis
// feature. Live receipts that motivated this fix, all measured 2026-09-03 against production:
//   curl -s -o /dev/null -w '%{http_code}' https://rt.wave.online/.well-known/x402  → 501
//   …/robots.txt → 501 · …/sitemap.xml → 501 · …/favicon.ico → 501 · …/favicon.svg → 501
// The /favicon.svg 501 is the loudest: the landing page rt ALREADY serves at "/" links to it
// (<link rel="icon" href="/favicon.svg">), so the shipped page's own icon 501'd.
//
// The x402 one is the MONEY defect: /.well-known/x402 is how an agent discovers that rt's routes are
// priced and payable at all. A 501 there means no autonomous buyer can find the paid surface.
//
// SCOPE (unchanged from agent-discovery.ts): this module handles ONLY these exact GET/HEAD paths. It
// does NOT swap in `makeFetch` as the router's tail fallback. route-dispatch.ts's final 501 catch-all
// is a documented invariant that dozens of INERT feature flags rely on ("falls through to the 501
// catch-all, UNCHANGED"); replacing that tail with the chassis's gateway-federation proxy would
// silently change behaviour for every one of those flags' unmatched paths.
//
// SECURITY (Corridor): every byte below is derived from server-controlled constants. Nothing is built
// from the request — not the Host header, not the path, not a query param — so robots.txt/sitemap.xml
// cannot be poisoned by a forged Host, and there is no dynamic value to HTML/XML-encode. The caller
// canonicalises with `new URL(request.url)` and hands us `url.pathname`; matching is by EXACT string
// equality on that pathname (never startsWith/endsWith/includes), so no prefix or suffix trick reaches
// a handler it should not.
import { robotsTxt, sitemapXml, fillFavicon } from "@wave-av/spoke-chassis";
import { RT_META } from "./agent-discovery";
import { SEC_HEADERS } from "./sec-headers";
// The branded WOW front door at "/" (was inline in route-dispatch.ts until 2026-09-03). It moved here
// with the other front-door surfaces so all five share ONE header floor instead of a per-route
// hand-roll — and so route-dispatch.ts shrinks rather than grows past the file-size gate.
import { landingPage } from "./landing";

/** SEC_HEADERS (sec-headers.ts — the chassis floor) plus content-type + cache: chassis `textHeaders()`. */
const headers = (contentType: string, cache = "public,max-age=3600"): Record<string, string> => ({
	"content-type": contentType,
	"cache-control": cache,
	...SEC_HEADERS,
});

// ── /sitemap.xml ─────────────────────────────────────────────────────────────────────────────────
// The chassis's DEFAULT_SITEMAP_PATHS is ["/", "/pricing", "/status", "/transparency"], but rt serves
// NONE of the latter three (they still 501 — see SCOPE). Advertising a path this host does not serve
// would be a fabricated sitemap, which is worse than a small one. rt has exactly ONE indexable HTML
// page today, so that is exactly what the sitemap lists. Add a path here when rt serves it, not before.
const RT_SITEMAP_PATHS = ["/"];

// ── /.well-known/x402 ────────────────────────────────────────────────────────────────────────────
// The payment-discovery document. GROUNDING — every route and every price below was measured, not
// assumed. Three independent sources had to agree before a row was included:
//
//   1. rt ACTUALLY SERVES IT. The route is live in this worker with its feature flag ARMED in
//      wrangler.toml [vars]: WHIP_INGEST_ENABLED="1", WHEP_EGRESS_ENABLED="1",
//      INGRESS_ROUTER_ENABLED="1", VOICE_AGENT_PROVIDER="wave". A route behind an INERT flag 501s
//      after payment, so it is excluded (see NOT_LISTED below).
//   2. THE GATEWAY FORWARDS IT. wave-gateway src/realtime.ts (REALTIME_ROUTES, SFU_ROOM_ACTIONS,
//      agentDispatchEdgePath), src/whip.ts (WHIP_PREFIX, methods POST/PATCH/DELETE) and src/whep.ts
//      (WHEP_PREFIX, same methods) are the fail-closed forward tables. A path the gateway will not
//      forward is unbuyable no matter what it costs.
//   3. THE PRICE IS THE LIVE 402. Measured 2026-09-03, unauthenticated, against api.wave.online:
//        POST /v1/realtime/join            → 402, accepts[0].maxAmountRequired "3000"
//        POST /v1/realtime/turn            → 402, "3000"
//        POST /v1/realtime/rooms/x/join    → 402, "3000"   (publish/subscribe/renegotiate/leave idem)
//        POST /v1/realtime/agents/bind     → 402, "3000"
//        POST /v1/whip/publish             → 402, "5000"
//        DELETE /v1/whip/resource/x        → 402, "5000"
//        POST /v1/whep/subscribe           → 402, "3000"
//        DELETE /v1/whep/resource/x        → 402, "3000"
//        POST /v1/whep/sources             → 402, "3000"
//      Amounts are ATOMIC units of 6-decimal USDC on Base — "3000" is $0.003, "5000" is $0.005.
//      The asset is USDC on Base (0x8335…2913), read from the same live challenges.
//
// A 402 ALONE IS NOT PROOF A ROUTE EXISTS — measured, and it matters. The gateway's paywall runs
// BEFORE its forward table, and its scope rules are PREFIX-scoped, so a path that does not exist
// still returns a priced 402: POST /v1/realtime/definitely-not-a-route → 402/"3000" and
// POST /v1/whip/bogus-not-real → 402/"5000". Only a path outside every mapped prefix refuses
// (POST /v1/nonexistent-product/foo → 403 ROUTE_NOT_MAPPED). That is precisely why sources 1 and 2
// above are required: the 402 grounds the PRICE, the two route tables ground the ROUTE.
//
// NOT LISTED, on purpose — each was checked and deliberately left out rather than guessed at:
//   · GET /v1/realtime/rooms/{room}/presence — prices at 402/"3000", but `presence` is NOT in the
//     gateway's SFU_ROOM_ACTIONS allowlist, so the gateway has no forward for it. Priced but not
//     routable; selling it would sell a request that cannot be delivered.
//   · POST /v1/realtime/ingress/{protocol}/{intent} — prices at 402/"3000", but INGEST_BRIDGE_ENABLED
//     is absent from wrangler.toml [vars], so the edge 501s it after payment.
//   · /v1/realtime/rooms/{room}/egress/{start,stop,info} — 401 EGRESS_AUTH_REQUIRED, not a 402: a
//     trusted-backend bearer route, not a pay-per-use one.
//   · /v1/egress/destinations, /v1/egress/arm — EGRESS_DEST_MGMT_ENABLED and EGRESS_ROUTER_ENABLED
//     are both "0" (INERT).
//   · GET /v1/whep/sources — the gateway's WHEP forward accepts POST/PATCH/DELETE only.
//
// payTo is deliberately ABSENT. The live 402 carries a payTo and a session id that can rotate; a
// static copy of a payout address is the one field in this document that could send real money to a
// stale destination. WAVE's own payments.json states the rule this document follows — "the 402
// challenge returned by the route you are calling is the authoritative source of payment terms" —
// so this manifest is for PLANNING (what exists, what it costs), and the challenge is for PAYING.

/** USDC on Base — read from the live 402 challenges above. 6 decimals, so amounts are atomic units. */
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

interface X402Route {
	/** Public gateway path (what a payer calls). */
	readonly resource: string;
	readonly method: string;
	/** Atomic 6-decimal USDC, verbatim from the live 402 challenge for that route's prefix. */
	readonly maxAmountRequired: string;
	readonly description: string;
}

const RT_X402_ROUTES: readonly X402Route[] = [
	{ method: "POST", resource: "/v1/realtime/join", maxAmountRequired: "3000", description: "Mint a RealtimeKit participant join token" },
	{ method: "POST", resource: "/v1/realtime/turn", maxAmountRequired: "3000", description: "Mint short-lived TURN/ICE credentials for raw WebRTC NAT traversal" },
	{ method: "POST", resource: "/v1/realtime/rooms/{room}/join", maxAmountRequired: "3000", description: "Join an SFU room (returns the session offer)" },
	{ method: "POST", resource: "/v1/realtime/rooms/{room}/publish", maxAmountRequired: "3000", description: "Publish local tracks into an SFU room" },
	{ method: "POST", resource: "/v1/realtime/rooms/{room}/subscribe", maxAmountRequired: "3000", description: "Subscribe to remote tracks in an SFU room" },
	{ method: "POST", resource: "/v1/realtime/rooms/{room}/renegotiate", maxAmountRequired: "3000", description: "Renegotiate the peer connection for an SFU room" },
	{ method: "POST", resource: "/v1/realtime/rooms/{room}/leave", maxAmountRequired: "3000", description: "Leave an SFU room and meter the session" },
	{ method: "POST", resource: "/v1/realtime/agents/bind", maxAmountRequired: "3000", description: "Bind a voice agent to a room" },
	{ method: "POST", resource: "/v1/realtime/agents/info", maxAmountRequired: "3000", description: "Inspect a bound voice-agent session" },
	{ method: "POST", resource: "/v1/whip/publish", maxAmountRequired: "5000", description: "IETF WHIP ingest — publish a stream" },
	{ method: "DELETE", resource: "/v1/whip/resource/{id}", maxAmountRequired: "5000", description: "IETF WHIP ingest — tear down a publish resource" },
	{ method: "POST", resource: "/v1/whep/subscribe", maxAmountRequired: "3000", description: "IETF WHEP egress — subscribe to a stream" },
	{ method: "DELETE", resource: "/v1/whep/resource/{id}", maxAmountRequired: "3000", description: "IETF WHEP egress — tear down a subscribe resource" },
	{ method: "POST", resource: "/v1/whep/sources", maxAmountRequired: "3000", description: "Register a WHEP playback source" },
	{ method: "DELETE", resource: "/v1/whep/sources/{uid}", maxAmountRequired: "3000", description: "Delete a WHEP playback source" },
];

/** The gateway that authenticates, charges, and forwards to this worker. */
const GATEWAY = "https://api.wave.online";

/** Build the x402 discovery document. Pure — every field is a module constant. */
export function rtX402Document(): string {
	return JSON.stringify(
		{
			x402Version: 1,
			resourceHost: RT_META.host,
			facilitator: "https://gateway.wave.online/v1/x402/facilitator",
			discovery: "https://gateway.wave.online/.well-known/x402",
			payments: "https://gateway.wave.online/.well-known/payments.json",
			supported: "https://gateway.wave.online/v1/x402/facilitator/supported",
			// The gateway's capability index declares realtime's meter; repeated here so a buyer knows
			// what the charge is metered against without a second fetch.
			meter: "wave_realtime_video_minutes",
			scope: "realtime:write",
			$comment:
				"ADVISORY. rt.wave.online is a thin edge: every priced route below is CALLED at the WAVE gateway (" +
				GATEWAY +
				"), which authenticates or charges and only then forwards to this worker — a direct unpaid call to rt is rejected. " +
				"maxAmountRequired is in ATOMIC units of 6-decimal USDC on Base, so \"3000\" is $0.003. " +
				"The 402 challenge returned by the route you are calling is the AUTHORITATIVE source of payment terms (payTo, session id, exact amount): plan from this document, pay from the challenge.",
			accepts: RT_X402_ROUTES.map((r) => ({
				scheme: "exact",
				protocol: "x402",
				network: "base",
				asset: USDC_BASE,
				maxAmountRequired: r.maxAmountRequired,
				resource: `${GATEWAY}${r.resource}`,
				method: r.method,
				description: r.description,
				mimeType: "application/json",
				maxTimeoutSeconds: 60,
				extra: { decimals: 6, assetSymbol: "USDC", servedBy: RT_META.host },
			})),
		},
		null,
		2,
	);
}

// ── Router ───────────────────────────────────────────────────────────────────────────────────────
const RT_FAVICON = fillFavicon(RT_META.accentHex);

/**
 * Serve rt's crawler + commerce discovery surfaces if `pathname` is one of them; otherwise null so the
 * caller falls through to the rest of dispatch() UNCHANGED (including the 501 catch-all).
 *
 * `pathname` MUST come from `new URL(request.url).pathname` (route-dispatch.ts already canonicalises
 * there). Matching is exact string equality — no prefix, suffix or substring test.
 *
 * GET and HEAD are both served. HEAD matters here and is not padding: `curl -sI https://rt.wave.online/`
 * returned 501 in production on 2026-09-03 because the router's front door is GET-only, so every
 * header-only probe — the shape most uptime checkers and link previewers send — saw a broken host.
 */
export function maybeHandleDiscoveryRoutes(request: Request, pathname: string): Response | null {
	const method = request.method;
	if (method !== "GET" && method !== "HEAD") return null;
	const bodyFor = (body: string): string | null => (method === "HEAD" ? null : body);

	if (pathname === "/") {
		// SEC_HEADERS replaces the previous hand-assembled {DEFAULT_CSP, nosniff} on this response: the
		// SAME chassis CSP, plus the referrer-policy and x-frame-options the host was missing live.
		return new Response(bodyFor(landingPage()), { headers: { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS } });
	}
	if (pathname === "/robots.txt") {
		return new Response(bodyFor(robotsTxt(RT_META)), { headers: headers("text/plain; charset=utf-8") });
	}
	if (pathname === "/sitemap.xml") {
		return new Response(bodyFor(sitemapXml(RT_META, RT_SITEMAP_PATHS)), { headers: headers("application/xml; charset=utf-8") });
	}
	if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
		// An SVG navigated to directly is an active document, so it carries the same nosniff + CSP floor
		// as the HTML surfaces (mirrors the chassis worker.ts favicon branch).
		return new Response(bodyFor(RT_FAVICON), { headers: headers("image/svg+xml", "public,max-age=86400") });
	}
	if (pathname === "/.well-known/x402") {
		// PAYMENT PATH — never swallow a failure here silently (Corridor). The document is built from
		// module constants, so a throw would mean a genuine runtime defect (e.g. a malformed constant
		// reaching JSON.stringify); log it and return a STRUCTURED error rather than an empty 200 that a
		// buyer would parse as "this host has no priced routes".
		try {
			return new Response(bodyFor(rtX402Document()), { headers: headers("application/json; charset=utf-8", "public,max-age=300") });
		} catch (err) {
			console.error(JSON.stringify({ msg: "x402-discovery-render-failed", path: pathname, error: String(err) }));
			return Response.json(
				{ error: "X402_DISCOVERY_UNAVAILABLE", message: "the x402 discovery document could not be rendered; retry, or read payment terms from the 402 challenge at https://api.wave.online" },
				{ status: 500, headers: SEC_HEADERS },
			);
		}
	}
	return null;
}
