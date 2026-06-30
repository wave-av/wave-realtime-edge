// #53 — IETF WHEP v1 egress listener contract tests (docs/whep-v1-frozen-contract.md §3/§4/§9/§10).
//
// Drives the WHEP surface THROUGH the worker entry (so the flag-gate + gateway-trust + org wiring are covered)
// with WHEP_EGRESS_ENABLED on. The SFU is mocked via the handleWhep deps seam (no live network). KV is an
// in-memory stub seeded with a WHIP source record (the WHIP→WHEP join point). Asserts: 201 + Location + SDP
// answer body + renegotiation header, 400 (missing track/resource), 404 (unknown/cross-org source), 415/422/503
// errors, PATCH 204 trickle, DELETE teardown + meter emit + idempotency. Also re-confirms 501 when flag is OFF.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";
import {
	handleWhep,
	buildWhepMeterLine,
	whepEgressEnabled,
	emitWhepTeardownMeter,
	METER_WHEP_EGRESS_MINUTES,
	type WhepEnv,
	type WhepDeps,
	type WhepKv,
} from "../src/whep.js";
import { SfuError, type SessionDescription } from "../src/sfu.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";

/** In-memory KV stub implementing the minimal WhepKv surface. */
function memKv(): WhepKv & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(k) {
			return store.get(k) ?? null;
		},
		async put(k, v) {
			store.set(k, v);
		},
		async delete(k) {
			store.delete(k);
		},
	};
}

/** Deps with a mocked SFU (newSession→answer, pullTracks→track), deterministic clock + id, recording fetch. */
function mockDeps(
	over: Partial<WhepDeps> = {},
	pullResult: { requiresImmediateRenegotiation?: boolean } = {},
): { deps: WhepDeps; meterCalls: { url: string; body: unknown }[] } {
	const meterCalls: { url: string; body: unknown }[] = [];
	const deps: WhepDeps = {
		sfu: () =>
			({
				newSession: async () => ({ sessionId: "sub00001abcd", sessionDescription: { type: "answer", sdp: ANSWER_SDP } }),
				pullTracks: async () => ({ tracks: [{ trackName: "cam0" }], ...pullResult }),
			}) as never,
		now: () => 1_000_000,
		mintResourceId: () => "wep00000001",
		fetch: (async (url: string, init?: RequestInit) => {
			meterCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
		...over,
	};
	return { deps, meterCalls };
}

/** Env with an in-memory KV pre-seeded with a WHIP source record `whip:pub00000001` owned by `org_A`. */
function whepEnv(over: Record<string, unknown> = {}): WhepEnv & Record<string, unknown> {
	const kv = memKv();
	kv.store.set("whip:pub00000001", JSON.stringify({ sessionId: "pubsess0001", org: "org_A", startedAt: 1 }));
	return {
		WHEP_EGRESS_ENABLED: "1",
		CF_CALLS_APP_ID: "a".repeat(32),
		CF_CALLS_APP_SECRET: "sekret",
		RT_MEETING_ORG: kv,
		...over,
	} as never;
}

function whepReq(method: string, path: string, headers: Record<string, string> = {}, body?: string): Request {
	return new Request(`https://rt.wave.online${path}`, { method, headers, body });
}

const SUB = "/v1/whep/subscribe?resource=pub00000001&track=cam0";

// ── Direct handler tests (deps injected) ──────────────────────────────────
describe("handleWhep — POST /v1/whep/subscribe (happy path)", () => {
	it("201 + Location + application/sdp answer body; persists the resource; renegotiation header", async () => {
		const { deps } = mockDeps();
		const env = whepEnv();
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(201);
		expect(res!.headers.get("content-type")).toMatch(/application\/sdp/);
		expect(res!.headers.get("location")).toBe("/v1/whep/resource/wep00000001");
		expect(res!.headers.get("x-wave-whep-renegotiation")).toBe("0");
		expect(await res!.text()).toBe(ANSWER_SDP);
		const kv = env.RT_MEETING_ORG as WhepKv & { store: Map<string, string> };
		expect(kv.store.has("whep:wep00000001")).toBe(true);
	});

	it("signals x-wave-whep-renegotiation=1 when the SFU pull requires renegotiation (§10 gap 1)", async () => {
		const { deps } = mockDeps({}, { requiresImmediateRenegotiation: true });
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", deps);
		expect(res!.status).toBe(201);
		expect(res!.headers.get("x-wave-whep-renegotiation")).toBe("1");
	});

	it("relays a NEWLINE-TERMINATED offer to the SFU (CF rejects a trimmed SDP 400)", async () => {
		let seen: SessionDescription | undefined;
		const { deps } = mockDeps({
			sfu: () =>
				({
					newSession: async (offer?: SessionDescription) => {
						seen = offer;
						return { sessionId: "sub00001abcd", sessionDescription: { type: "answer", sdp: ANSWER_SDP } };
					},
					pullTracks: async () => ({ tracks: [] }),
				}) as never,
		});
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", deps);
		expect(seen?.type).toBe("offer");
		expect(seen?.sdp.endsWith("\n")).toBe(true);
		expect(seen?.sdp).toBe(OFFER_SDP.trim() + "\r\n");
	});

	it("pulls the NAMED track from the resolved PUBLISHER session (§3 source resolution)", async () => {
		let pulledFrom: { sessionId: string; trackName: string } | undefined;
		const { deps } = mockDeps({
			sfu: () =>
				({
					newSession: async () => ({ sessionId: "sub00001abcd", sessionDescription: { type: "answer", sdp: ANSWER_SDP } }),
					pullTracks: async (sessionId: string, tracks: { sessionId: string; trackName: string }[]) => {
						pulledFrom = { sessionId: tracks[0].sessionId, trackName: tracks[0].trackName };
						return { tracks: [] };
					},
				}) as never,
		});
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", deps);
		expect(pulledFrom).toEqual({ sessionId: "pubsess0001", trackName: "cam0" });
	});

	it("400 when ?track is missing", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(
			whepReq("POST", "/v1/whep/subscribe?resource=pub00000001", { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(400);
	});

	it("404 when the source resource is unknown", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(
			whepReq("POST", "/v1/whep/subscribe?resource=ghost0000001&track=cam0", { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(404);
	});

	it("404 when the source resource is owned by a DIFFERENT org (§9.6 tenant isolation)", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_OTHER", deps);
		expect(res!.status).toBe(404);
	});

	it("415 when Content-Type is not application/sdp", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/json" }, "{}"), whepEnv(), "org_A", deps);
		expect(res!.status).toBe(415);
	});

	it("422 when the SDP offer is unparseable", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, "not an sdp"), whepEnv(), "org_A", deps);
		expect(res!.status).toBe(422);
	});

	it("503 when the SFU is unavailable (newSession throws SfuError 503)", async () => {
		const { deps } = mockDeps({
			sfu: () => ({ newSession: async () => { throw new SfuError("REALTIME_NOT_CONFIGURED", "no app", 503); } }) as never,
		});
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", deps);
		expect(res!.status).toBe(503);
	});
});

describe("handleWhep — PATCH/DELETE on the resource", () => {
	it("PATCH trickle → 204 for a known resource", async () => {
		const { deps } = mockDeps();
		const env = whepEnv();
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		const res = await handleWhep(
			whepReq("PATCH", "/v1/whep/resource/wep00000001", { "content-type": "application/trickle-ice-sdpfrag" }, "a=candidate:..."),
			env,
			"org_A",
			deps,
		);
		expect(res!.status).toBe(204);
	});

	it("PATCH with wrong content-type → 415", async () => {
		const { deps } = mockDeps();
		const env = whepEnv();
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		const res = await handleWhep(whepReq("PATCH", "/v1/whep/resource/wep00000001", { "content-type": "text/plain" }, "x"), env, "org_A", deps);
		expect(res!.status).toBe(415);
	});

	it("DELETE → 204, emits the teardown meter (idempotency=resourceId), clears the record", async () => {
		const { deps, meterCalls } = mockDeps({ now: () => 1_000_000 + 90_000 }); // +90s → ceil = 2 min
		const env = whepEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-token" });
		// subscribe (startedAt = 1_000_000), then seed the known startedAt + advance the delete clock.
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", mockDeps().deps);
		const kv = env.RT_MEETING_ORG as WhepKv;
		await kv.put(
			"whep:wep00000001",
			JSON.stringify({ subscriberSessionId: "sub00001abcd", publisherSessionId: "pubsess0001", trackName: "cam0", org: "org_A", startedAt: 1_000_000 }),
		);
		const res = await handleWhep(whepReq("DELETE", "/v1/whep/resource/wep00000001"), env, "org_A", deps);
		expect(res!.status).toBe(204);
		expect(meterCalls.length).toBe(1);
		expect(meterCalls[0].url).toMatch(/\/v1\/internal\/usage$/);
		const body = meterCalls[0].body as { org: string; usage: { meter: string; meter_value: number; event_id: string } };
		expect(body.org).toBe("org_A");
		expect(body.usage.meter).toBe(METER_WHEP_EGRESS_MINUTES);
		expect(body.usage.meter_value).toBe(2);
		expect(body.usage.event_id).toBe("wep00000001");
		// record cleared → idempotent re-DELETE is a clean 204 with NO second meter emit
		const res2 = await handleWhep(whepReq("DELETE", "/v1/whep/resource/wep00000001"), env, "org_A", deps);
		expect(res2!.status).toBe(204);
		expect(meterCalls.length).toBe(1);
	});

	it("DELETE of an unknown resource is an idempotent 204 (no error, no meter)", async () => {
		const { deps, meterCalls } = mockDeps();
		const res = await handleWhep(whepReq("DELETE", "/v1/whep/resource/doesnotexist1"), whepEnv(), "org_A", deps);
		expect(res!.status).toBe(204);
		expect(meterCalls.length).toBe(0);
	});
});

describe("buildWhepMeterLine — ceil-minutes, idempotent on resourceId", () => {
	it("90s → 2 minutes (ceil)", () => {
		expect(buildWhepMeterLine("r1", 0, 90_000).meter_value).toBe(2);
	});
	it("0/negative duration → 0 (not billable)", () => {
		expect(buildWhepMeterLine("r1", 1000, 1000).meter_value).toBe(0);
		expect(buildWhepMeterLine("r1", 2000, 1000).meter_value).toBe(0);
	});
	it("event_id is the resourceId; meter is the egress SKU", () => {
		const line = buildWhepMeterLine("res-xyz", 0, 1);
		expect(line.event_id).toBe("res-xyz");
		expect(line.meter).toBe(METER_WHEP_EGRESS_MINUTES);
	});
});

describe("emitWhepTeardownMeter — fail-open + provisioning gate", () => {
	it("no-op (no network) when emit is not provisioned", async () => {
		const calls: string[] = [];
		const f = (async (u: string) => { calls.push(u); return new Response(null); }) as unknown as typeof fetch;
		await emitWhepTeardownMeter({} as WhepEnv, "org_A", buildWhepMeterLine("r1", 0, 90_000), f);
		expect(calls.length).toBe(0);
	});
	it("no-op when meter_value is 0", async () => {
		const calls: string[] = [];
		const f = (async (u: string) => { calls.push(u); return new Response(null); }) as unknown as typeof fetch;
		const env = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "t" } as unknown as WhepEnv;
		await emitWhepTeardownMeter(env, "org_A", buildWhepMeterLine("r1", 0, 0), f);
		expect(calls.length).toBe(0);
	});
});

// ── Worker-level gating tests (flag + gateway-trust through the entry) ─────
describe("worker /v1/whep/* gating", () => {
	it("flag OFF → 501 (catch-all unchanged)", async () => {
		const res = await worker.fetch(
			whepReq("POST", SUB, { "content-type": "application/sdp", "x-wave-org": "org_A" }, OFFER_SDP),
			{ WHEP_EGRESS_ENABLED: "0" } as never,
			ctx,
		);
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("flag ON + gateway-trust set + MISSING x-wave-internal → 401", async () => {
		const res = await worker.fetch(
			whepReq("POST", SUB, { "content-type": "application/sdp", "x-wave-org": "org_A" }, OFFER_SDP),
			whepEnv({ WAVE_INTERNAL_SECRET: "s3cret" }) as never,
			ctx,
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("UNAUTHORIZED");
	});

	it("flag ON + missing x-wave-org → 400", async () => {
		const res = await worker.fetch(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv() as never, ctx);
		expect(res.status).toBe(400);
	});
});

describe("whepEgressEnabled flag parsing", () => {
	it.each([
		[undefined, false],
		["0", false],
		["", false],
		["false", false],
		["1", true],
		["true", true],
		[true, true],
	])("WHEP_EGRESS_ENABLED=%s → %s", (v, expected) => {
		expect(whepEgressEnabled({ WHEP_EGRESS_ENABLED: v } as WhepEnv)).toBe(expected);
	});
});
