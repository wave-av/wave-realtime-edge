/**
 * CONTRACT TESTS — wave-realtime-edge worker (current surface, scaffold stage)
 *
 * These tests exercise the ACTUAL responses produced by the worker's fetch handler
 * today. They import the handler directly and call it with a plain Request + a
 * minimal stub env/ctx so no network, Cloudflare runtime, or secrets are needed.
 *
 * Grounded in src/worker.ts as-shipped:
 *   GET /health   → 200  {ok,service,layer,protocol,version}
 *   <any other>   → 501  {error:"REALTIME_NOT_IMPLEMENTED",path}
 *
 * Auth is NOT enforced by this worker — auth/entitlement decisions are delegated
 * to the WAVE API gateway upstream (see openapi.yaml §Authentication). Tests confirm the
 * worker never issues 401/403 regardless of the Authorization header value.
 *
 * TODO (follow-ups once endpoints are implemented):
 *   - #109  x402 per-connection metering (402 Payment Required flow)
 *   - #110  wire AI-spoke producers → event bus
 *   - POST /whip/{streamKey} happy path (201 + SDP answer + Location header)
 *   - POST /whep/{slug}      happy path (201 + SDP answer + Location header)
 *   - CORS/OPTIONS preflight (no CORS logic exists in the current worker)
 */

import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

// Minimal stubs — the current worker.ts only uses `request`; env/ctx are unused.
const env = {} as never;
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function req(method: string, path: string, headers?: Record<string, string>): Request {
	return new Request(`https://rt.wave.online${path}`, {
		method,
		headers: headers ?? {},
	});
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------
describe("GET /health", () => {
	it("returns 200", async () => {
		const res = await worker.fetch(req("GET", "/health"), env, ctx);
		expect(res.status).toBe(200);
	});

	it("returns application/json content-type", async () => {
		const res = await worker.fetch(req("GET", "/health"), env, ctx);
		expect(res.headers.get("content-type")).toMatch(/application\/json/);
	});

	it("body has ok:true and all required fields", async () => {
		const res = await worker.fetch(req("GET", "/health"), env, ctx);
		const body = await res.json() as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.service).toBe("wave-realtime-edge");
		expect(body.layer).toBe("edge");
		expect(body.protocol).toBe("webrtc-sfu");
		expect(typeof body.version).toBe("string");
	});

	it("no auth required — works without Authorization header", async () => {
		const res = await worker.fetch(req("GET", "/health"), env, ctx);
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// /whip/{streamKey} — planned; returns 501 at scaffold stage
// ---------------------------------------------------------------------------
describe("POST /whip/{streamKey} (scaffold — 501)", () => {
	it("returns 501", async () => {
		const res = await worker.fetch(req("POST", "/whip/test-key"), env, ctx);
		expect(res.status).toBe(501);
	});

	it("body.error is REALTIME_NOT_IMPLEMENTED", async () => {
		const res = await worker.fetch(req("POST", "/whip/test-key"), env, ctx);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("body.path reflects the request path", async () => {
		const res = await worker.fetch(req("POST", "/whip/test-key"), env, ctx);
		const body = await res.json() as Record<string, unknown>;
		expect(body.path).toBe("/whip/test-key");
	});

	it("no 401 even without auth (auth is gateway-delegated, not enforced here)", async () => {
		const res = await worker.fetch(req("POST", "/whip/test-key"), env, ctx);
		// Worker does not enforce auth — expects 501, not 401
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
	});
});

// ---------------------------------------------------------------------------
// /whep/{slug} — planned; returns 501 at scaffold stage
// ---------------------------------------------------------------------------
describe("POST /whep/{slug} (scaffold — 501)", () => {
	it("returns 501", async () => {
		const res = await worker.fetch(req("POST", "/whep/my-stream"), env, ctx);
		expect(res.status).toBe(501);
	});

	it("body.error is REALTIME_NOT_IMPLEMENTED", async () => {
		const res = await worker.fetch(req("POST", "/whep/my-stream"), env, ctx);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("body.path reflects the request path", async () => {
		const res = await worker.fetch(req("POST", "/whep/my-stream"), env, ctx);
		const body = await res.json() as Record<string, unknown>;
		expect(body.path).toBe("/whep/my-stream");
	});
});

// ---------------------------------------------------------------------------
// Unknown / arbitrary paths
// ---------------------------------------------------------------------------
describe("unknown paths → 501 REALTIME_NOT_IMPLEMENTED", () => {
	it("GET /nope → 501", async () => {
		const res = await worker.fetch(req("GET", "/nope"), env, ctx);
		expect(res.status).toBe(501);
	});

	it("GET /nope body has correct error code and path", async () => {
		const res = await worker.fetch(req("GET", "/nope"), env, ctx);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe("REALTIME_NOT_IMPLEMENTED");
		expect(body.path).toBe("/nope");
	});

	it("POST / → 501", async () => {
		const res = await worker.fetch(req("POST", "/"), env, ctx);
		expect(res.status).toBe(501);
	});

	it("GET /v1/streams → 501", async () => {
		const res = await worker.fetch(req("GET", "/v1/streams"), env, ctx);
		expect(res.status).toBe(501);
	});
});

// ---------------------------------------------------------------------------
// Auth behavior — confirmed no-op in this worker (gateway-delegated)
// ---------------------------------------------------------------------------
describe("auth — worker does not enforce (gateway-delegated)", () => {
	it("missing Authorization on /whip → 501, not 401", async () => {
		const res = await worker.fetch(req("POST", "/whip/key"), env, ctx);
		expect(res.status).toBe(501);
	});

	it("invalid Bearer on /whip → still 501 (no auth logic in worker)", async () => {
		const res = await worker.fetch(
			req("POST", "/whip/key", { Authorization: "Bearer invalid-token" }),
			env,
			ctx,
		);
		expect(res.status).toBe(501);
	});

	it("valid wave-token-v1 pattern on /whip → still 501 (not implemented)", async () => {
		const res = await worker.fetch(
			req("POST", "/whip/key", { Authorization: "Bearer wave-token-v1.abc123" }),
			env,
			ctx,
		);
		expect(res.status).toBe(501);
	});
});
