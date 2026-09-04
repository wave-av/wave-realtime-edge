// Regression test for the RT catch-all sweep (2026-09-03): GET /robots.txt, /sitemap.xml,
// /favicon.ico, /favicon.svg and /.well-known/x402 all fell through to the generic 501
// REALTIME_NOT_IMPLEMENTED catch-all because route-dispatch.ts never wired the chassis discovery
// primitives every sibling spoke gets from makeFetch(). Proves the fix, proves the header floor
// (Content-Security-Policy + Referrer-Policy) is on every surface, proves the x402 manifest is
// grounded — and proves the 501 catch-all is otherwise UNCHANGED, the invariant dozens of INERT
// feature flags in route-dispatch.ts rely on.
import { describe, it, expect } from "vitest";
import { dispatch } from "../src/route-dispatch";

const env = {} as import("../src/dispatch-helpers").Env;
const get = (path: string, method = "GET") => dispatch(new Request(`https://rt.wave.online${path}`, { method }), env, undefined);

const SURFACES = ["/", "/robots.txt", "/sitemap.xml", "/favicon.ico", "/favicon.svg", "/.well-known/x402"];

describe("discovery routes — the paths that used to 501", () => {
	it("every surface is 200, not 501", async () => {
		for (const p of SURFACES) {
			const res = await get(p);
			expect(res.status, `${p} should be 200`).toBe(200);
		}
	});

	it("GET /robots.txt is text/plain, is the CHASSIS policy, and points at this host's sitemap", async () => {
		const res = await get("/robots.txt");
		expect(res.headers.get("content-type")).toContain("text/plain");
		const body = await res.text();
		expect(body).toContain("User-agent:");
		// The host in the Sitemap line comes from RT_META.host, a module constant — NEVER the request's
		// Host header — so a forged Host cannot poison the sitemap pointer this file publishes.
		expect(body).toContain("Sitemap: https://rt.wave.online/sitemap.xml");
		// NOTE: the tiered answer-engine policy (ClaudeBot/GPTBot Allow, CCBot Disallow) landed in a
		// LATER chassis than rt's pin, so this asserts the policy the pinned chassis actually emits.
		// rt inherits the tiers for free on the next chassis bump — no rt change needed.
	});

	it("GET /sitemap.xml is XML and lists ONLY paths this host actually serves", async () => {
		const res = await get("/sitemap.xml");
		expect(res.headers.get("content-type")).toContain("xml");
		const body = await res.text();
		expect(body).toContain("<loc>https://rt.wave.online/</loc>");
		// /status and /transparency are chassis defaults rt does NOT serve — advertising them would be
		// a fabricated sitemap. If rt ever serves them, add them to RT_SITEMAP_PATHS and this flips.
		expect(body).not.toContain("/status");
		expect(body).not.toContain("/transparency");
	});

	it("GET /favicon.ico and /favicon.svg both serve the rt-accent WAVE mark", async () => {
		for (const p of ["/favicon.ico", "/favicon.svg"]) {
			const res = await get(p);
			expect(res.headers.get("content-type")).toBe("image/svg+xml");
			const body = await res.text();
			expect(body).toContain("<svg");
			expect(body).toContain("#ff715d"); // RT_META.accentHex — not the chassis default blue
		}
	});
});

describe("/.well-known/x402 — the payment-discovery document", () => {
	it("is application/json and names the gateway as the paying surface", async () => {
		const res = await get("/.well-known/x402");
		expect(res.headers.get("content-type")).toContain("application/json");
		const doc = (await res.json()) as Record<string, unknown>;
		expect(doc.x402Version).toBe(1);
		expect(doc.resourceHost).toBe("rt.wave.online");
		expect(String(doc.facilitator)).toContain("gateway.wave.online");
	});

	it("prices every route in atomic 6-decimal USDC on Base, at the amounts the live 402 advertises", async () => {
		const doc = (await (await get("/.well-known/x402")).json()) as { accepts: Array<Record<string, string>> };
		expect(doc.accepts.length).toBeGreaterThan(0);
		for (const a of doc.accepts) {
			expect(a.scheme).toBe("exact");
			expect(a.network).toBe("base");
			// USDC on Base, read from the live challenges.
			expect(a.asset).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
			// Atomic units: an integer string, never a decimal — a "0.003" here would be a 1000x underpay.
			expect(a.maxAmountRequired).toMatch(/^\d+$/);
			// Every advertised resource is called AT THE GATEWAY, never directly at rt.
			expect(a.resource.startsWith("https://api.wave.online/v1/")).toBe(true);
		}
		const by = (r: string) => doc.accepts.find((a) => a.resource.endsWith(r));
		// Measured live 2026-09-03: the realtime prefix quotes 3000, the WHIP prefix quotes 5000.
		expect(by("/v1/realtime/join")?.maxAmountRequired).toBe("3000");
		expect(by("/v1/realtime/turn")?.maxAmountRequired).toBe("3000");
		expect(by("/v1/whip/publish")?.maxAmountRequired).toBe("5000");
		expect(by("/v1/whep/subscribe")?.maxAmountRequired).toBe("3000");
	});

	it("omits routes that are priced but NOT routable/served — no fabricated inventory", async () => {
		const body = await (await get("/.well-known/x402")).text();
		// presence: priced 402 at the gateway, but absent from its SFU_ROOM_ACTIONS forward allowlist.
		expect(body).not.toContain("/presence");
		// ingress: priced 402, but INGEST_BRIDGE_ENABLED is absent from wrangler.toml → the edge 501s it.
		expect(body).not.toContain("/v1/realtime/ingress");
		// egress control plane: 401 trusted-backend bearer, not a pay-per-use route.
		expect(body).not.toContain("/egress/start");
		// A payout address can rotate; a stale static copy would misdirect real money, so no `accepts`
		// entry carries one — the live 402 challenge owns payTo. (The advisory $comment names the field
		// to say exactly that, which is why this asserts on the parsed entries, not on the raw text.)
		const doc = JSON.parse(body) as { accepts: Array<Record<string, unknown>> };
		for (const a of doc.accepts) expect(a.payTo).toBeUndefined();
		expect(body).not.toMatch(/0x13014b/i); // the live payout address must not be baked in
	});
});

describe("security header floor", () => {
	it("every surface carries a Content-Security-Policy and a Referrer-Policy", async () => {
		// /llms.txt, /skill.md and the agent card shipped with NO security headers at all until this
		// change wired sec-headers.ts into agent-discovery.ts too — so they are asserted here.
		for (const p of [...SURFACES, "/llms.txt", "/skill.md", "/.well-known/agent-card.json"]) {
			const res = await get(p);
			const csp = res.headers.get("content-security-policy") ?? "";
			expect(csp, `${p} CSP`).toContain("default-src 'none'");
			// script-src stays 'self' — the page's only inline script is an ld+json DATA block, which
			// browsers never execute and CSP never gates. Widening to 'unsafe-inline' would be a
			// regression, so pin that it is NOT present.
			expect(csp).toContain("script-src 'self'");
			expect(csp).not.toContain("unsafe-inline'; script-src");
			expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
			expect(res.headers.get("referrer-policy"), `${p} Referrer-Policy`).toBe("strict-origin-when-cross-origin");
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		}
	});
});

describe("HEAD requests", () => {
	it("HEAD / is 200 with headers and no body (it was 501 in production)", async () => {
		const res = await get("/", "HEAD");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toBe("");
	});

	it("HEAD /.well-known/x402 is 200 with no body", async () => {
		const res = await get("/.well-known/x402", "HEAD");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});
});

describe("the 501 catch-all is otherwise UNCHANGED", () => {
	it("an unmatched GET path still 501s REALTIME_NOT_IMPLEMENTED", async () => {
		const res = await get("/v1/realtime/whatever-not-a-real-route");
		expect(res.status).toBe(501);
		expect(((await res.json()) as { error: string }).error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("a non-GET/HEAD method on a discovery path is NOT hijacked — it falls through to the 501", async () => {
		for (const p of ["/robots.txt", "/.well-known/x402", "/favicon.ico"]) {
			const res = await dispatch(new Request(`https://rt.wave.online${p}`, { method: "POST" }), env, undefined);
			expect(res.status, `POST ${p}`).toBe(501);
		}
	});

	it("matching is EXACT — no prefix/suffix path can reach a discovery handler", async () => {
		for (const p of ["/robots.txt/x", "/x/robots.txt", "/.well-known/x402/extra", "/favicon.icon", "/sitemap.xml.bak"]) {
			const res = await get(p);
			expect(res.status, p).toBe(501);
		}
	});
});
