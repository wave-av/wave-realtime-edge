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

// Chassis-owned surfaces this worker claims by EXACT path. Every entry is one the chassis serves
// TERMINALLY — it matches an explicit `path === …` branch in the chassis worker's route table, so it
// can never reach that worker's federating tail (see the WHY-NOT-A-PREFIX note on isChassisPath).
//
// The first four are the original discovery set. In practice route-dispatch.ts runs
// maybeHandleDiscoveryRoutes BEFORE this passthrough and serves all four itself (rt needs an
// rt-specific sitemap and the standalone `fillFavicon()` renderer), so they are kept here only as
// the backstop they always were.
//
// The rest were added for #490. `/.well-known/wave-products.json` is the one the issue names — it is
// how the platform and any external consumer enumerate what this host offers, and it 501'd — but it
// was never the only one missing. Measured against this worker before the fix, ALL of these 501'd:
//   /.well-known/wave-products.json · /.well-known/oauth-authorization-server
//   /.well-known/openid-configuration · /.well-known/security.txt · /security.txt
//   /.well-known/mcp · /.well-known/mcp.json · /.well-known/skills.json · /.well-known/did.json
//   /manifest.webmanifest
// `/security.txt` is the chassis's own alias of `/.well-known/security.txt` (one branch serves both),
// so claiming one without the other would be an arbitrary half-fix. `/manifest.webmanifest` is the
// same defect class discovery-routes.ts called "the loudest" for /favicon.svg: the landing page rt
// ALREADY serves at "/" emits `<link rel="manifest" href="/manifest.webmanifest">`, so the shipped
// page's own manifest 501'd.
//
// DELIBERATELY NOT CLAIMED (each already works, or is a decision this fix should not make):
//   · /.well-known/x402, /.well-known/agent-card.json, /llms.txt, /skill.md — rt already serves these
//     LOCALLY (discovery-routes.ts / agent-discovery.ts) with grounded, rt-specific bodies. The x402
//     document in particular was hand-grounded against measured routes and prices and is served
//     no-store; handing it to the generic chassis renderer would swap a verified price document for
//     a derived one.
//   · /status, /transparency, /pricing — rt does not serve them, and discovery-routes.ts deliberately
//     keeps them OUT of RT_SITEMAP_PATHS on the grounds that advertising a path this host does not
//     serve is a fabricated claim. The chassis's default /status would also report "operational"
//     unconditionally, since rt passes no `opts.status` probe — an ungrounded health claim.
//   · /pricing.json, /openapi.json — commerce documents derived from `meta`. rt's priced surface went
//     through a documented three-source grounding rule; a generated price document that never did is
//     a billing-correctness risk, not a discovery fix.
//   · /index.json, /feed.xml — content-index and Atom surfaces for a host with exactly one indexable
//     page. Nothing to index; consistent with RT_SITEMAP_PATHS = ["/"].
//   · /healthz — the chassis alias returns `{ok:true}`, while rt's own /health returns a richer body
//     (service, layer, protocol, version, sha). A second liveness surface with a DIFFERENT shape is a
//     monitoring decision for this host's owner, not something to slip into a discovery fix.
//   · /og.svg, /og.png — social cards (/og.png 302s off-host). Branding, not a discovery contract.
const CHASSIS_PATHS = new Set([
    "/favicon.svg",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
    // ── #490: chassis-terminal discovery surfaces that previously fell to the 501 ──
    "/.well-known/wave-products.json",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/.well-known/security.txt",
    "/security.txt",
    "/.well-known/mcp",
    "/.well-known/mcp.json",
    "/.well-known/skills.json",
    "/.well-known/did.json",
    "/manifest.webmanifest",
]);

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
 *
 * WHY `/.well-known/` IS AN EXACT-MATCH SET AND **NOT** A `startsWith` PREFIX (#490).
 * #490 proposed a `/.well-known/` prefix rule so "the next well-known path does not become the next
 * 501". That would be a security regression on THIS worker, because the chassis `makeFetch` tail is
 * a verbatim reverse proxy — everything it does not route is forwarded to the gateway origin and the
 * upstream response is returned as-is (spoke-chassis dist/worker.js):
 *   const origin = env.GATEWAY_ORIGIN || "https://api.wave.online";
 *   const upstream = new URL(path + url.search, origin);
 *   const resp = await fetch(new Request(upstream, req));
 *   return new Response(resp.body, { status: resp.status, headers: resp.headers });
 * A prefix rule therefore converts every UNMATCHED `/.well-known/*` path from this worker's
 * fail-closed 501 into an open, caller-controlled proxy hop (attacker-chosen path + query, response
 * returned verbatim). route-dispatch.ts's terminal 501 is a documented invariant that dozens of INERT
 * feature flags depend on, and discovery-routes.ts already records the same refusal for the same
 * reason ("it does NOT swap in `makeFetch` as the router's tail fallback"). So the set enumerates
 * exact strings and matches with `Set.has` — never startsWith/endsWith/includes — and an unclaimed
 * `/.well-known/anything` keeps 501ing. Adding a genuinely new chassis path is a one-line edit here;
 * that is the intended cost. Asserted by test/chassis-wellknown-and-header.test.ts.
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
