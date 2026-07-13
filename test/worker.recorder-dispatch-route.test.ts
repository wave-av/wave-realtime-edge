// #151 — Worker recorder-DISPATCH route: POST /v1/realtime/recorder-dispatch/:org/:room. Stubs the ROOM
// namespace (no live DO). Proves: gated behind the internal-secret chokepoint (gateway-trust ONLY — no token
// alternative, since this endpoint MINTS tokens); DORMANT unless RECORDER_INGEST_ENABLED (disarmed → 501);
// armed+authed → forwards to the DO keyed `${org}:${room}` and passes the descriptor list through; bad path → 400.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function stubRoomNamespace(descriptors: unknown = []) {
	const seen: { name?: string; forwards: Request[] } = { forwards: [] };
	return {
		seen,
		idFromName(name: string) {
			seen.name = name;
			return { __name: name };
		},
		get(_id: unknown) {
			return {
				fetch: async (r: Request) => {
					seen.forwards.push(r);
					return Response.json({ descriptors }, { status: 200 });
				},
			};
		},
	};
}

function env(over: Record<string, unknown> = {}, ns = stubRoomNamespace()) {
	return { env: { ROOM: ns, ...over } as never, ns };
}

const PATH = "/v1/realtime/recorder-dispatch/org_x/r1"; // :org/:room

function post(headers: Record<string, string> = {}, path = PATH): Request {
	return new Request(`https://rt.wave.online${path}`, { method: "POST", headers });
}

describe("recorder-dispatch route — auth + gating + forward", () => {
	it("guard ON + no auth → 401 (before the flag is even consulted)", async () => {
		const { env: e } = env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" });
		const res = await worker.fetch(post(), e, ctx);
		expect(res.status).toBe(401);
	});

	it("armed but DISARMED flag (RECORDER_INGEST_ENABLED off) → 501, even with x-wave-internal", async () => {
		const { env: e } = env({ WAVE_INTERNAL_SECRET: "s" });
		const res = await worker.fetch(post({ "x-wave-internal": "s" }), e, ctx);
		expect(res.status).toBe(501);
	});

	it("invalid path segment → 400 (no DO forward)", async () => {
		const bad = "/v1/realtime/recorder-dispatch/org_x/has a space";
		const { env: e, ns } = env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" });
		const res = await worker.fetch(post({ "x-wave-internal": "s" }, bad), e, ctx);
		expect(res.status).toBe(400);
		expect(ns.seen.forwards.length).toBe(0);
	});

	it("armed + x-wave-internal → forwards to the DO keyed `${org}:${room}` and passes descriptors through", async () => {
		const descriptors = [{ org: "org_x", room: "r1", trackName: "vid", token: "1.aa", ingestPath: "/x" }];
		const ns = stubRoomNamespace(descriptors);
		const { env: e } = env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" }, ns);
		const res = await worker.fetch(post({ "x-wave-internal": "s" }), e, ctx);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ descriptors });
		expect(ns.seen.name).toBe("org_x:r1"); // per-org DO isolation
		expect(ns.seen.forwards[0].url).toContain("recorder-dispatch");
	});

	it("GET is not a dispatch call → does not forward (method-scoped)", async () => {
		const { ns } = env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" });
		const e = { ROOM: ns, WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" } as never;
		const res = await worker.fetch(new Request(`https://rt.wave.online${PATH}`, { method: "GET", headers: { "x-wave-internal": "s" } }), e, ctx);
		expect(ns.seen.forwards.length).toBe(0);
		expect(res.status).not.toBe(200);
	});
});
