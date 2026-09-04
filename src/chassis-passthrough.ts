// wave-realtime-edge — chassis passthrough (2026-09-03).
//
// Every /_wave/* asset the landing shell references (consent.js, cta.js, nav.js, the funnel beacon
// POST /_wave/e + presence route GET /_wave/funnel.json) plus the standard discovery surfaces
// (/favicon.svg, /robots.txt, /sitemap.xml) is served by the chassis's `makeFetch` router. Without
// this passthrough the shell's own <script src> and <link> targets fall through to the generic
// REALTIME_NOT_IMPLEMENTED 501 (rt.wave.online audit 2026-09-03 09:23 EDT: /_wave/consent.js 501,
// /_wave/funnel.json 501, /sitemap.xml 501, /robots.txt 501).
//
// Extracted from route-dispatch.ts so that file stays under the token-budget gate (SPLIT/HARD).
// Protocol routes (/rtk/*, /v1/realtime/*, /rt/*, /health) stay hand-routed in route-dispatch above
// this tail — this is a PUBLIC, ADDITIVE seam that never touches paid endpoints.
import { makeFetch, markSvg } from "@wave-av/spoke-chassis";
import { landingPage } from "./landing";
import { ACCENT_HEX, TOKENS_CSS } from "./tokens.css";

const chassis = makeFetch(landingPage, markSvg(ACCENT_HEX), {
	meta: {
		product: "Realtime",
		host: "rt.wave.online",
		tagline: "Your broadcast talks back, live today — WebRTC/SFU rooms on the WAVE gateway.",
		tokensCss: TOKENS_CSS,
		accentHex: ACCENT_HEX,
	},
});

const CHASSIS_PATHS = new Set(["/favicon.svg", "/favicon.ico", "/robots.txt", "/sitemap.xml"]);

/**
 * True when this request is a chassis-owned public surface — a readable /_wave/* asset, the funnel
 * beacon POST /_wave/e, or one of the discovery paths.
 *
 * The METHOD is part of the test, not just the path. This seam's contract has always been "public
 * GETs only, plus POST /_wave/e for the funnel beacon" (see the header comment above), but the
 * original predicate matched on pathname ALONE, so any method on a chassis path was handed to
 * `makeFetch` — which answers a method it does not route with its own 404, ahead of this worker's
 * REALTIME_NOT_IMPLEMENTED 501 catch-all. That catch-all is a documented invariant that dozens of
 * INERT feature flags depend on. Measured against production 2026-09-03, before this gate:
 *   POST /robots.txt → 404 · POST /sitemap.xml → 404 · POST /favicon.ico → 200 (!)
 *   POST /nonexistent-control → 501  (the invariant, still correct on unclaimed paths)
 * The /favicon.ico case is the worst of the three: a POST got a 200 and a favicon body. With the gate
 * below all three fall through to the 501 like every other unroutable method, and the two live
 * chassis behaviours are preserved exactly — GET/HEAD assets, and the POST /_wave/e beacon (204).
 *
 * `/_wave/e` is the ONLY POST route the chassis worker declares (verified against the installed
 * 0.17.1 dist: its /_wave routes are consent.js, cta.js, e, funnel.json, nav.js, and `e` is the sole
 * one behind a POST branch), so naming it exactly is precise rather than over-tight.
 */
export function isChassisPath(pathname: string, method: string): boolean {
	if (method === "POST") return pathname === "/_wave/e";
	if (method !== "GET" && method !== "HEAD") return false;
	return pathname.startsWith("/_wave/") || CHASSIS_PATHS.has(pathname);
}

/** Delegate a request to the chassis fetch handler. Caller must already have gated on `isChassisPath`. */
export function chassisFetch(
	request: Request,
	env: unknown,
	ctx: ExecutionContext | undefined,
): Promise<Response> {
	return chassis(request, env as Parameters<typeof chassis>[1], ctx);
}
