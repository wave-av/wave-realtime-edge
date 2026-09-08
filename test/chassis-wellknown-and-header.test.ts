// Regression test for #490 — two defects measured against production 2026-09-07.
//
// DEFECT A — /.well-known/* never reached the chassis, so it 501'd.
//   route-dispatch.ts's tail is a fail-closed 501 catch-all; the chassis (makeFetch) is reachable
//   ONLY through chassis-passthrough.ts behind isChassisPath(), whose CHASSIS_PATHS set listed four
//   paths. /.well-known/wave-products.json was in neither that set nor /_wave/*, so it fell to 501:
//     rt.wave.online/.well-known/wave-products.json → 501   (/.well-known/x402 → 200, /robots.txt → 200)
//
// DEFECT B — the chassis version stamp was missing from every rt-served discovery surface.
//   sec-headers.ts kept a hand-copied FORK of the chassis security-header set. The fork predates
//   `x-chassis` and never carried it, so every response built from SEC_HEADERS shipped without the
//   stamp and this host was unauditable for chassis drift:
//     rt.wave.online/robots.txt     200  x-chassis ABSENT     (built from the local fork)
//     rt.wave.online/_wave/nav.js   200  x-chassis 0.20.2     (genuinely chassis-served — control)
//
// NOTE ON THE DIAGNOSIS (#490 says /robots.txt is "chassis-served"): it is not. route-dispatch.ts
// runs maybeHandleDiscoveryRoutes BEFORE the chassis passthrough, so /robots.txt is served LOCALLY
// by discovery-routes.ts out of the forked SEC_HEADERS. Genuinely chassis-served paths (/_wave/*)
// always carried the stamp — `/_wave/nav.js → 200 x-chassis 0.20.2` — which is why the fork, not
// the chassis, is the defect. The test below asserts BOTH so the distinction stays proven.
import { describe, it, expect } from "vitest";
import { CHASSIS_VERSION } from "@wave-av/spoke-chassis";
import { dispatch } from "../src/route-dispatch";

const env = {} as import("../src/dispatch-helpers").Env;
const req = (path: string, method = "GET") =>
	dispatch(new Request(`https://rt.wave.online${path}`, { method }), env, undefined);

/** The well-known/discovery surfaces #490 added to CHASSIS_PATHS. Each is a path the chassis serves
 *  TERMINALLY (an exact `path === …` branch in its worker), so none of them reaches the federating
 *  tail. Deliberately NOT here: /.well-known/x402 and /.well-known/agent-card.json, which rt already
 *  serves locally with grounded, rt-specific bodies (discovery-routes.ts / agent-discovery.ts). */
const ADDED = [
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
];

describe("#490 defect A — /.well-known/* reaches the chassis instead of the 501", () => {
	it("GET /.well-known/wave-products.json is 200 JSON, not 501", async () => {
		const res = await req("/.well-known/wave-products.json");
		expect(res.status, "/.well-known/wave-products.json must not 501").toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		// A 200 with an unparseable body would not be a working discovery document.
		await expect(res.json()).resolves.toBeTypeOf("object");
	});

	it("every newly-claimed discovery surface is 200", async () => {
		for (const p of ADDED) {
			const res = await req(p);
			expect(res.status, `${p} should be 200`).toBe(200);
		}
	});

	it("the landing page's own <link rel=manifest> target resolves", async () => {
		// Same defect class discovery-routes.ts called "the loudest" for /favicon.svg: the page rt
		// already serves at "/" references an asset that 501s.
		const home = await req("/");
		expect(await home.text()).toContain("manifest.webmanifest");
		expect((await req("/manifest.webmanifest")).status).toBe(200);
	});
});

describe("#490 defect B — the x-chassis version stamp is present and non-empty", () => {
	it("locally-served discovery surfaces carry a non-empty x-chassis", async () => {
		for (const p of ["/robots.txt", "/sitemap.xml", "/", "/.well-known/x402", "/llms.txt"]) {
			const res = await req(p);
			const stamp = res.headers.get("x-chassis");
			expect(stamp, `${p} must carry x-chassis`).toBeTruthy();
			expect(stamp, `${p} x-chassis must not be empty`).not.toBe("");
			// An exact-version check, not a presence heuristic: a blank-but-present stamp is the
			// failure mode #490 called out as the most expensive one.
			expect(stamp, `${p} x-chassis must be the running chassis version`).toBe(CHASSIS_VERSION);
		}
	});

	it("genuinely chassis-served paths still carry the stamp (control)", async () => {
		const res = await req("/_wave/nav.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-chassis")).toBe(CHASSIS_VERSION);
	});

	it("the header floor keeps every security header the local fork had, and adds the fleet's", async () => {
		const res = await req("/robots.txt");
		for (const h of ["x-content-type-options", "referrer-policy", "x-frame-options", "content-security-policy"]) {
			expect(res.headers.get(h), `${h} must survive`).toBeTruthy();
		}
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("strict-transport-security")).toBeTruthy();
		expect(res.headers.get("permissions-policy")).toBeTruthy();
		// The per-response cache decision must still win: SEC carries no cache-control.
		expect(res.headers.get("cache-control")).toBe("public,max-age=3600");
	});
});

describe("#490 — the fail-closed 501 tail is UNCHANGED", () => {
	// The whole reason CHASSIS_PATHS enumerates exact strings instead of taking a
	// `startsWith("/.well-known/")` prefix: makeFetch's tail is a verbatim reverse proxy to
	// GATEWAY_ORIGIN (api.wave.online). A prefix rule would turn every unmatched /.well-known/*
	// path from a fail-closed 501 into a forwarded proxy request. These assertions are the guard.
	it("an unclaimed /.well-known/* path still 501s — it is NOT proxied", async () => {
		for (const p of ["/.well-known/totally-unclaimed", "/.well-known/../etc/passwd", "/.well-known/"]) {
			const res = await req(p);
			expect(res.status, `${p} must stay fail-closed`).toBe(501);
		}
	});

	it("an unclaimed non-well-known path still 501s", async () => {
		expect((await req("/nonexistent-control")).status).toBe(501);
	});

	it("the method gate holds — a non-GET on a newly-claimed path 501s", async () => {
		for (const m of ["POST", "PUT", "DELETE"]) {
			const res = await req("/.well-known/wave-products.json", m);
			expect(res.status, `${m} /.well-known/wave-products.json must 501`).toBe(501);
		}
	});
});
