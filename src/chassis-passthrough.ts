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

/** True when the path is a chassis-owned public surface — /_wave/* or one of the discovery paths. */
export function isChassisPath(pathname: string): boolean {
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
