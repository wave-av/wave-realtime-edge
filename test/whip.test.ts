// B3 (#98) — IETF WHIP v1 ingest listener contract tests (whip-v1-frozen-contract.md §3/§4/§6-B3).
//
// Drives the WHIP surface THROUGH the worker entry (so the flag-gate + gateway-trust + org wiring are covered)
// with WHIP_INGEST_ENABLED on. The SFU is mocked via the handleWhip deps seam (no live network). KV is an
// in-memory stub. Asserts: 201 + Location + SDP answer body, 401 (gateway-trust), 415/422/503 errors, PATCH
// 204 trickle, DELETE teardown + meter emit + idempotency. Also re-confirms 501 when the flag is OFF.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";
import {
	handleWhip,
	buildWhipMeterLine,
	whipIngestEnabled,
	resolveWhipMeter,
	METER_WHIP_INGEST_MINUTES,
	METER_STREAM_BRIDGE_MINUTES,
	WHIP_METER_OVERRIDE_HEADER,
	type WhipEnv,
	type WhipDeps,
	type WhipKv,
} from "../src/whip.js";
import { SfuError, type SessionDescription } from "../src/sfu.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";

/** In-memory KV stub implementing the minimal WhipKv surface. */
function memKv(): WhipKv & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		// #35: the sweeper enumerates records; the stub lists the in-memory store in one complete page.
		async list({ prefix = "" } = {}) {
			const keys = [...store.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name }));
			return { keys, list_complete: true };
		},
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

/** Deps with a mocked SFU (returns a fixed answer), deterministic clock + id, and a recording fetch. */
function mockDeps(over: Partial<WhipDeps> = {}): { deps: WhipDeps; meterCalls: { url: string; body: unknown }[] } {
	const meterCalls: { url: string; body: unknown }[] = [];
	const deps: WhipDeps = {
		sfu: () =>
			({
				newSession: async () => ({ sessionId: "sess0001abcd", sessionDescription: { type: "answer", sdp: ANSWER_SDP } }),
				pushTracks: async () => ({ tracks: [] }),
			}) as never,
		now: () => 1_000_000,
		mintResourceId: () => "res00000001",
		fetch: (async (url: string, init?: RequestInit) => {
			meterCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch,
		...over,
	};
	return { deps, meterCalls };
}

function whipEnv(over: Record<string, unknown> = {}): WhipEnv & Record<string, unknown> {
	return {
		WHIP_INGEST_ENABLED: "1",
		CF_CALLS_APP_ID: "a".repeat(32),
		CF_CALLS_APP_SECRET: "sekret",
		RT_MEETING_ORG: memKv(),
		...over,
	} as never;
}

function whipReq(method: string, path: string, headers: Record<string, string> = {}, body?: string): Request {
	return new Request(`https://rt.wave.online${path}`, { method, headers, body });
}

// ── Direct handler tests (deps injected) ──────────────────────────────────
describe("handleWhip — POST /v1/whip/publish (happy path)", () => {
	it("201 + Location + application/sdp answer body; persists the resource", async () => {
		const { deps } = mockDeps();
		const env = whipEnv();
		const res = await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP),
			env,
			"org_A",
			deps,
		);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(201);
		expect(res!.headers.get("content-type")).toMatch(/application\/sdp/);
		expect(res!.headers.get("location")).toBe("/v1/whip/resource/res00000001");
		expect(await res!.text()).toBe(ANSWER_SDP);
		// resource record persisted under the whip: prefix for PATCH/DELETE
		const kv = env.RT_MEETING_ORG as WhipKv & { store: Map<string, string> };
		expect(kv.store.has("whip:res00000001")).toBe(true);
	});

	it("relays a NEWLINE-TERMINATED offer to the SFU (CF rejects a trimmed SDP 400; #100B)", async () => {
		let seen: SessionDescription | undefined;
		const { deps } = mockDeps({
			sfu: () =>
				({
					newSession: async (offer?: SessionDescription) => {
						seen = offer;
						return { sessionId: "sess0001abcd", sessionDescription: { type: "answer", sdp: ANSWER_SDP } };
					},
					pushTracks: async () => ({ tracks: [] }),
				}) as never,
		});
		await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP),
			whipEnv(),
			"org_A",
			deps,
		);
		expect(seen?.type).toBe("offer");
		// The publisher's trailing CRLF (stripped by the v=0-guard trim) is re-terminated before relay.
		expect(seen?.sdp.endsWith("\n")).toBe(true);
		expect(seen?.sdp).toBe(OFFER_SDP.trim() + "\r\n");
	});

	it("415 when Content-Type is not application/sdp", async () => {
		const { deps } = mockDeps();
		const res = await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/json" }, "{}"),
			whipEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(415);
	});

	it("422 when the SDP offer is unparseable", async () => {
		const { deps } = mockDeps();
		const res = await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, "not an sdp"),
			whipEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(422);
	});

	it("503 when the SFU is unavailable (newSession throws SfuError 503)", async () => {
		const { deps } = mockDeps({
			sfu: () => ({ newSession: async () => { throw new SfuError("REALTIME_NOT_CONFIGURED", "no app", 503); } }) as never,
		});
		const res = await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP),
			whipEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(503);
	});
});

describe("handleWhip — PATCH/DELETE on the resource", () => {
	it("PATCH trickle → 204 for a known resource", async () => {
		const { deps } = mockDeps();
		const env = whipEnv();
		// publish first to create the record
		await handleWhip(whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		const res = await handleWhip(
			whipReq("PATCH", "/v1/whip/resource/res00000001", { "content-type": "application/trickle-ice-sdpfrag" }, "a=candidate:..."),
			env,
			"org_A",
			deps,
		);
		expect(res!.status).toBe(204);
	});

	it("PATCH with wrong content-type → 415", async () => {
		const { deps } = mockDeps();
		const env = whipEnv();
		await handleWhip(whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		const res = await handleWhip(
			whipReq("PATCH", "/v1/whip/resource/res00000001", { "content-type": "text/plain" }, "x"),
			env,
			"org_A",
			deps,
		);
		expect(res!.status).toBe(415);
	});

	it("DELETE → 204, emits the teardown meter (idempotency=resourceId), clears the record", async () => {
		const { deps, meterCalls } = mockDeps({ now: () => 1_000_000 + 90_000 }); // +90s → ceil = 2 min
		const env = whipEnv({
			GATEWAY_BASE_URL: "https://api.wave.online",
			WAVE_SERVICE_TOKEN: "svc-token",
		});
		// publish (startedAt = deps.now at publish). Use a publish-time clock then advance for delete.
		await handleWhip(whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", mockDeps().deps);
		// seed the record with the known startedAt the publish used (1_000_000)
		const kv = env.RT_MEETING_ORG as WhipKv;
		await kv.put("whip:res00000001", JSON.stringify({ sessionId: "sess0001abcd", org: "org_A", startedAt: 1_000_000 }));
		const res = await handleWhip(whipReq("DELETE", "/v1/whip/resource/res00000001"), env, "org_A", deps);
		expect(res!.status).toBe(204);
		expect(meterCalls.length).toBe(1);
		expect(meterCalls[0].url).toMatch(/\/v1\/internal\/usage$/);
		const body = meterCalls[0].body as { org: string; usage: { meter: string; meter_value: number; event_id: string } };
		expect(body.org).toBe("org_A");
		expect(body.usage.meter).toBe(METER_WHIP_INGEST_MINUTES);
		expect(body.usage.meter_value).toBe(2);
		expect(body.usage.event_id).toBe("res00000001");
		// record cleared → idempotent re-DELETE is a clean 204 with NO second meter emit
		const res2 = await handleWhip(whipReq("DELETE", "/v1/whip/resource/res00000001"), env, "org_A", deps);
		expect(res2!.status).toBe(204);
		expect(meterCalls.length).toBe(1);
	});

	it("DELETE of an unknown resource is an idempotent 204 (no error, no meter)", async () => {
		const { deps, meterCalls } = mockDeps();
		const res = await handleWhip(whipReq("DELETE", "/v1/whip/resource/doesnotexist1"), whipEnv(), "org_A", deps);
		expect(res!.status).toBe(204);
		expect(meterCalls.length).toBe(0);
	});
});

describe("buildWhipMeterLine — ceil-minutes, idempotent on resourceId", () => {
	it("90s → 2 minutes (ceil)", () => {
		expect(buildWhipMeterLine("r1", 0, 90_000).meter_value).toBe(2);
	});
	it("0/negative duration → 0 (not billable)", () => {
		expect(buildWhipMeterLine("r1", 1000, 1000).meter_value).toBe(0);
		expect(buildWhipMeterLine("r1", 2000, 1000).meter_value).toBe(0);
	});
	it("event_id is the resourceId", () => {
		expect(buildWhipMeterLine("res-xyz", 0, 1).event_id).toBe("res-xyz");
	});
	it("bills the override meter when one is supplied", () => {
		expect(buildWhipMeterLine("r1", 0, 1, METER_STREAM_BRIDGE_MINUTES).meter).toBe(METER_STREAM_BRIDGE_MINUTES);
	});
});

// ── #91 B2 stream-bridge SKU attribution (distinct meter, gateway-sealed override, allowset-validated) ──
describe("resolveWhipMeter — allowset gate (validate-before-sink)", () => {
	it("honors the allowed bridge override", () => {
		expect(resolveWhipMeter(METER_STREAM_BRIDGE_MINUTES)).toBe(METER_STREAM_BRIDGE_MINUTES);
	});
	it("defaults to WHIP-ingest for absent/empty/unknown overrides", () => {
		expect(resolveWhipMeter(null)).toBe(METER_WHIP_INGEST_MINUTES);
		expect(resolveWhipMeter(undefined)).toBe(METER_WHIP_INGEST_MINUTES);
		expect(resolveWhipMeter("")).toBe(METER_WHIP_INGEST_MINUTES);
		expect(resolveWhipMeter("wave_free_lunch")).toBe(METER_WHIP_INGEST_MINUTES); // not in allowset → rejected
	});
});

describe("handleWhip — bridge SKU teardown billing via the sealed override header", () => {
	it("publish with x-wave-meter-override=bridge → teardown bills wave_stream_bridge_minutes", async () => {
		const { deps: pubDeps } = mockDeps({ now: () => 1_000_000 });
		const { deps: delDeps, meterCalls } = mockDeps({ now: () => 1_000_000 + 90_000 });
		const env = whipEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-token" });
		await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp", [WHIP_METER_OVERRIDE_HEADER]: METER_STREAM_BRIDGE_MINUTES }, OFFER_SDP),
			env,
			"org_bridge",
			pubDeps,
		);
		const res = await handleWhip(whipReq("DELETE", "/v1/whip/resource/res00000001"), env, "org_bridge", delDeps);
		expect(res!.status).toBe(204);
		expect(meterCalls.length).toBe(1);
		const body = meterCalls[0].body as { usage: { meter: string; meter_value: number } };
		expect(body.usage.meter).toBe(METER_STREAM_BRIDGE_MINUTES);
		expect(body.usage.meter_value).toBe(2);
	});

	it("a spoofed/unknown override is rejected → teardown bills the default WHIP-ingest meter", async () => {
		const { deps: pubDeps } = mockDeps({ now: () => 1_000_000 });
		const { deps: delDeps, meterCalls } = mockDeps({ now: () => 1_000_000 + 90_000 });
		const env = whipEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-token" });
		await handleWhip(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp", [WHIP_METER_OVERRIDE_HEADER]: "wave_free_lunch" }, OFFER_SDP),
			env,
			"org_A",
			pubDeps,
		);
		const res = await handleWhip(whipReq("DELETE", "/v1/whip/resource/res00000001"), env, "org_A", delDeps);
		expect(res!.status).toBe(204);
		const body = meterCalls[0].body as { usage: { meter: string } };
		expect(body.usage.meter).toBe(METER_WHIP_INGEST_MINUTES);
	});
});

// ── Worker-level gating tests (flag + gateway-trust through the entry) ─────
describe("worker /v1/whip/* gating", () => {
	it("flag OFF → 501 (catch-all unchanged), SFU never consulted", async () => {
		const res = await worker.fetch(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp", "x-wave-org": "org_A" }, OFFER_SDP),
			{ WHIP_INGEST_ENABLED: "0" } as never,
			ctx,
		);
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("flag ON + gateway-trust set + MISSING x-wave-internal → 401", async () => {
		const res = await worker.fetch(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp", "x-wave-org": "org_A" }, OFFER_SDP),
			whipEnv({ WAVE_INTERNAL_SECRET: "s3cret" }) as never,
			ctx,
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("UNAUTHORIZED");
	});

	it("flag ON + missing x-wave-org → 400", async () => {
		const res = await worker.fetch(
			whipReq("POST", "/v1/whip/publish", { "content-type": "application/sdp" }, OFFER_SDP),
			whipEnv() as never,
			ctx,
		);
		expect(res.status).toBe(400);
	});
});

describe("whipIngestEnabled flag parsing", () => {
	it.each([
		[undefined, false],
		["0", false],
		["", false],
		["false", false],
		["1", true],
		["true", true],
		[true, true],
	])("WHIP_INGEST_ENABLED=%s → %s", (v, expected) => {
		expect(whipIngestEnabled({ WHIP_INGEST_ENABLED: v } as WhipEnv)).toBe(expected);
	});
});
