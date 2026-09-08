// Regression test for the fleet-conformance sweep (2026-09-08): GET /status, /feed.xml and
// /index.json all fell through to the generic 501 REALTIME_NOT_IMPLEMENTED catch-all, even though
// rt's OWN /llms.txt (chassis-derived, agent-discovery.ts) already advertises all three as live
// surfaces — a published machine-readable index pointing at a 501 is a lie to agents. Positive
// control measured live 2026-09-08: omt.wave.online (a conforming sibling spoke that uses the
// chassis's bare `makeFetch` — no custom router) served all three as 200 with the chassis's bare
// "thin edge, no extra dependency checks wired" default: {status:"operational",
// checks:[{name:"edge",ok:true}]} for /status, an EMPTY (but structurally valid) Atom feed for
// /feed.xml, and the full derived manifest for /index.json. This test proves rt now matches that
// SAME schema/content — not a richer, invented one — and proves the 501 catch-all is otherwise
// unchanged (an unrelated unmatched GET path still 501s).
import { describe, it, expect } from "vitest";
import { dispatch } from "../src/route-dispatch";

const env = {} as import("../src/dispatch-helpers").Env;
const get = (path: string, method = "GET") => dispatch(new Request(`https://rt.wave.online${path}`, { method }), env, undefined);

describe("status/feed/index — the three paths llms.txt already promised but 501'd", () => {
	it("GET /status is 200 HTML, no-store, and the chassis's bare truthful default (not a richer invented one)", async () => {
		const res = await get("/status");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.text();
		expect(body).toContain("Realtime");
		expect(body).toContain("operational");
	});

	it("GET /status?format=json is the exact schema a conforming peer emits: {service,status,version,checks}", async () => {
		const res = await get("/status?format=json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { service: string; status: string; version: string; checks: Array<{ name: string; ok: boolean }> };
		expect(body.service).toBe("rt.wave.online");
		expect(body.status).toBe("operational");
		// The ONE check this thin edge can honestly make is "the edge worker executed" — true by
		// construction if this response was produced at all. No downstream dependency is claimed.
		expect(body.checks).toEqual([{ name: "edge", ok: true }]);
	});

	it("GET /status?format=json echoes GIT_SHA as version when the deploy stamped one (grounded, not the bare 'edge' default)", async () => {
		const shaEnv = { GIT_SHA: "deadbeef" } as import("../src/dispatch-helpers").Env;
		const res = await dispatch(new Request("https://rt.wave.online/status?format=json"), shaEnv, undefined);
		const body = (await res.json()) as { version: string };
		expect(body.version).toBe("deadbeef");
	});

	it("HEAD /status is 200 with no body (mirrors the discovery-routes.ts HEAD convention)", async () => {
		const res = await get("/status", "HEAD");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});

	it("GET /feed.xml is a valid, EMPTY Atom feed — no fabricated entries, matching the conforming peer exactly", async () => {
		const res = await get("/feed.xml");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("atom+xml");
		const body = await res.text();
		expect(body).toContain("<feed xmlns=\"http://www.w3.org/2005/Atom\">");
		expect(body).toContain("<title>WAVE Realtime</title>");
		expect(body).toContain("https://rt.wave.online/feed.xml");
		// No <entry> — rt has no changelog feed wired. An invented entry would be exactly the
		// fabrication this fix must not commit.
		expect(body).not.toContain("<entry>");
	});

	it("GET /index.json lists ONLY surfaces this host actually serves 200 on — no /transparency, no /pricing.json, no /openapi.json", async () => {
		const res = await get("/index.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as {
			host: string;
			surfaces: Array<{ path: string }>;
			agent?: Record<string, string>;
		};
		expect(body.host).toBe("rt.wave.online");
		const paths = body.surfaces.map((s) => s.path);
		expect(paths).toEqual(expect.arrayContaining(["/", "/status", "/health", "/llms.txt", "/index.json", "/feed.xml", "/.well-known/did.json"]));
		// /transparency still 501s on this host (verified live, out of scope for this fix) — the
		// chassis's stock indexJson() hardcodes it into every surfaces[] unconditionally, which is
		// exactly why this route builds its OWN document instead of calling that function verbatim.
		expect(paths).not.toContain("/transparency");
		// /pricing.json and /openapi.json still 501 (deliberately excluded, see chassis-passthrough.ts)
		// — the chassis's stock indexJson(meta, true) would otherwise advertise both unconditionally.
		expect(Object.values(body.agent ?? {})).not.toEqual(expect.arrayContaining([expect.stringContaining("pricing.json")]));
		expect(Object.values(body.agent ?? {})).not.toEqual(expect.arrayContaining([expect.stringContaining("openapi.json")]));
	});

	it("all three are also served on HEAD (mirrors discovery-routes.ts's own HEAD convention)", async () => {
		for (const p of ["/status", "/feed.xml", "/index.json"]) {
			const res = await get(p, "HEAD");
			expect(res.status, `${p} HEAD should be 200`).toBe(200);
		}
	});

	it("an unrelated unmatched GET path still 501s (catch-all is otherwise unchanged)", async () => {
		const res = await get("/v1/realtime/whatever-not-a-real-route");
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("POST /status is NOT claimed by this fix — still 501 (method-gated, matches discovery-routes.ts's own GET/HEAD-only contract)", async () => {
		const res = await get("/status", "POST");
		expect(res.status).toBe(501);
	});
});
