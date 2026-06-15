// CF-3.1.2 deploy guard — /rtk/join is protected when WAVE_INTERNAL_SECRET is set (gateway-only).
// These tests need no network: a 401 returns before join(), and the "passes guard" cases fall
// through to join() which fails fast (503) on the empty CF config — proving the guard was cleared.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
function join(headers: Record<string, string> = {}): Request {
	return new Request("https://rt.wave.online/rtk/join", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name: "Ada" }),
	});
}

describe("/rtk/join internal-auth guard", () => {
	it("guard OFF (no WAVE_INTERNAL_SECRET) → no 401 (gateway-delegated contract preserved)", async () => {
		const res = await worker.fetch(join(), {} as never, ctx);
		expect(res.status).not.toBe(401); // falls through to join() → 503 (unconfigured), not 401
	});

	it("guard ON + missing x-wave-internal → 401", async () => {
		const res = await worker.fetch(join(), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).toBe(401);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("UNAUTHORIZED");
	});

	it("guard ON + WRONG x-wave-internal → 401", async () => {
		const res = await worker.fetch(join({ "x-wave-internal": "nope" }), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).toBe(401);
	});

	it("guard ON + CORRECT x-wave-internal → passes the guard (503 unconfigured, not 401)", async () => {
		const res = await worker.fetch(join({ "x-wave-internal": "s3cret" }), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).not.toBe(401); // cleared the guard; join() then 503s on empty CF config
		expect(res.status).toBe(503);
	});

	it("health stays public regardless of the guard", async () => {
		const res = await worker.fetch(new Request("https://rt.wave.online/health"), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).toBe(200);
	});
});

function turnReq(headers: Record<string, string> = {}): Request {
	return new Request("https://rt.wave.online/rtk/turn", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ ttl: 3600 }),
	});
}

describe("/rtk/turn internal-auth guard (same chokepoint as /rtk/join)", () => {
	it("guard ON + missing x-wave-internal → 401", async () => {
		const res = await worker.fetch(turnReq(), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).toBe(401);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("UNAUTHORIZED");
	});

	it("guard ON + WRONG x-wave-internal → 401", async () => {
		const res = await worker.fetch(turnReq({ "x-wave-internal": "nope" }), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).toBe(401);
	});

	it("guard ON + CORRECT x-wave-internal → passes the guard (503 TURN unconfigured, not 401)", async () => {
		const res = await worker.fetch(turnReq({ "x-wave-internal": "s3cret" }), { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
		expect(res.status).not.toBe(401); // cleared the guard; turn() then 503s on empty TURN config
		expect(res.status).toBe(503);
	});
});
