// #53 — IETF WHEP v1 egress listener contract tests (docs/whep-v1-frozen-contract.md §0/§3/§4/§9/§10).
//
// REPOINTED to Cloudflare Stream WebRTC playback (one-shot WHEP). Drives the WHEP surface THROUGH the worker
// entry (so the flag-gate + gateway-trust + org wiring are covered) with WHEP_EGRESS_ENABLED on. The Stream
// WHEP playback endpoint is mocked via the handleWhep deps.fetch seam (no live network). KV is an in-memory
// stub seeded with a `stream-input-org:{uid}` record (the tenant-isolation join point). Asserts: 201 + Location
// + SDP answer body (verbatim) + NO renegotiation header, offer relayed verbatim+newline-terminated to the
// resolved playback URL, 400 (bad resource), 404 (unknown/cross-org input), 415/422/503 errors, PATCH 204
// trickle proxy, DELETE teardown + meter emit + Stream DELETE proxy + idempotency. Also 501 when flag is OFF.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";
import {
	handleWhep,
	liveWhepDeps,
	buildWhepMeterLine,
	whepEgressEnabled,
	useCloudflareStream,
	resolveStreamPlaybackUrl,
	emitWhepTeardownMeter,
	METER_WHEP_EGRESS_MINUTES,
	type WhepEnv,
	type WhepDeps,
	type WhepKv,
} from "../src/whep.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
const UID = "a1b2c3d4e5f6071829304a5b6c7d8e9f"; // 32-hex CF Stream live-input uid
const TEMPLATE = "https://customer-test.cloudflarestream.com/{uid}/webRTC/play";
const STREAM_RESOURCE = `https://customer-test.cloudflarestream.com/${UID}/webRTC/play/sessions/SESS123`;

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

interface RelayCall {
	url: string;
	method?: string;
	body?: unknown;
	ct?: string;
}

/**
 * Deps with a mocked Stream WHEP endpoint (POST→201+answer+Location; PATCH/DELETE→204) AND the meter emit
 * (POST /v1/internal/usage→200), distinguished by URL. Deterministic clock + id.
 */
function mockDeps(over: Partial<WhepDeps> = {}, relayStatus = 201): {
	deps: WhepDeps;
	meterCalls: { url: string; body: unknown }[];
	relayCalls: RelayCall[];
} {
	const meterCalls: { url: string; body: unknown }[] = [];
	const relayCalls: RelayCall[] = [];
	const deps: WhepDeps = {
		now: () => 1_000_000,
		mintResourceId: () => "wep00000001",
		fetch: (async (input: string, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/v1/internal/usage")) {
				meterCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
				return new Response(null, { status: 200 });
			}
			const ct = (init?.headers as Record<string, string> | undefined)?.["content-type"];
			relayCalls.push({ url, method: init?.method, body: init?.body, ct });
			if (init?.method === "POST") {
				return new Response(ANSWER_SDP, {
					status: relayStatus,
					headers: { "content-type": "application/sdp", location: STREAM_RESOURCE },
				});
			}
			return new Response(null, { status: 204 }); // PATCH / DELETE proxy
		}) as unknown as typeof fetch,
		...over,
	};
	return { deps, meterCalls, relayCalls };
}

/** Env with USE_CLOUDFLARE_STREAM + a playback template, and KV pre-seeded with `stream-input-org:{UID}`=org_A. */
function whepEnv(over: Record<string, unknown> = {}): WhepEnv & Record<string, unknown> {
	const kv = memKv();
	kv.store.set(`stream-input-org:${UID}`, "org_A");
	return {
		WHEP_EGRESS_ENABLED: "1",
		USE_CLOUDFLARE_STREAM: "1",
		WHEP_SRC_URL_TEMPLATE: TEMPLATE,
		RT_MEETING_ORG: kv,
		...over,
	} as never;
}

function whepReq(method: string, path: string, headers: Record<string, string> = {}, body?: string): Request {
	return new Request(`https://rt.wave.online${path}`, { method, headers, body });
}

const SUB = `/v1/whep/subscribe?resource=${UID}`;

// ── Direct handler tests (deps injected) ──────────────────────────────────
describe("handleWhep — POST /v1/whep/subscribe (happy path, Stream relay)", () => {
	it("201 + Location + application/sdp answer body; persists the resource; NO renegotiation header", async () => {
		const { deps } = mockDeps();
		const env = whepEnv();
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(201);
		expect(res!.headers.get("content-type")).toMatch(/application\/sdp/);
		expect(res!.headers.get("location")).toBe("/v1/whep/resource/wep00000001");
		expect(res!.headers.get("x-wave-whep-renegotiation")).toBeNull();
		expect(await res!.text()).toBe(ANSWER_SDP);
		const kv = env.RT_MEETING_ORG as WhepKv & { store: Map<string, string> };
		expect(kv.store.has("whep:wep00000001")).toBe(true);
		expect(JSON.parse(kv.store.get("whep:wep00000001")!).streamResourceUrl).toBe(STREAM_RESOURCE);
	});

	it("relays a NEWLINE-TERMINATED offer verbatim to the resolved Stream playback URL", async () => {
		const { deps, relayCalls } = mockDeps();
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", deps);
		expect(relayCalls.length).toBe(1);
		expect(relayCalls[0].url).toBe(`https://customer-test.cloudflarestream.com/${UID}/webRTC/play`);
		expect(relayCalls[0].method).toBe("POST");
		expect(relayCalls[0].ct).toMatch(/application\/sdp/);
		expect(String(relayCalls[0].body)).toBe(OFFER_SDP.trim() + "\r\n");
	});

	it("uses the DEFAULT liveWhepDeps fetch bound to globalThis (regression: 503 Illegal invocation)", async () => {
		// Reproduces the LIVE bug: the Workers/undici global `fetch` throws "Illegal invocation" unless called with
		// `this === globalThis`. liveWhepDeps() stored the UNBOUND global, so `deps.fetch(...)` (this === deps) threw
		// → caught → REALTIME_UPSTREAM 503, silently 503'ing the real Stream relay. Mocked-deps tests can't catch it —
		// only the DEFAULT (uninjected) liveWhepDeps path does. The bind fix keeps `this` correct.
		const original = globalThis.fetch;
		const strictFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
			if (this !== globalThis && this !== undefined) {
				throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
			}
			if ((init?.method ?? "GET").toUpperCase() === "POST") {
				return Promise.resolve(
					new Response(ANSWER_SDP, {
						status: 201,
						headers: { "content-type": "application/sdp", location: STREAM_RESOURCE },
					}),
				);
			}
			return Promise.resolve(new Response(null, { status: 204 }));
		} as unknown as typeof fetch;
		globalThis.fetch = strictFetch;
		try {
			// NO deps injected → exercises liveWhepDeps()'s `fetch.bind(globalThis)` default through the worker seam.
			const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", liveWhepDeps());
			expect(res!.status).toBe(201);
			expect(await res!.text()).toBe(ANSWER_SDP);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("400 when ?resource is missing/invalid (not a 32-hex uid)", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(
			whepReq("POST", "/v1/whep/subscribe?resource=nope", { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(400);
	});

	it("404 when the source live-input is unknown (no stream-input-org record)", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(
			whepReq("POST", "/v1/whep/subscribe?resource=ffffffffffffffffffffffffffffffff", { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv(),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(404);
	});

	it("404 when the source live-input is owned by a DIFFERENT org (§9.6 tenant isolation)", async () => {
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

	it("503 when USE_CLOUDFLARE_STREAM is off (fail-closed)", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(
			whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv({ USE_CLOUDFLARE_STREAM: "0" }),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(503);
	});

	it("503 when no playback URL is resolvable (no template, no customer code)", async () => {
		const { deps } = mockDeps();
		const res = await handleWhep(
			whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv({ WHEP_SRC_URL_TEMPLATE: undefined }),
			"org_A",
			deps,
		);
		expect(res!.status).toBe(503);
	});

	it("503 when the Stream WHEP relay returns a non-201", async () => {
		const { deps } = mockDeps({}, 500);
		const res = await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), whepEnv(), "org_A", deps);
		expect(res!.status).toBe(503);
	});

	it("builds the playback URL from CF_STREAM_CUSTOMER_CODE when no template is set", async () => {
		const { deps, relayCalls } = mockDeps();
		await handleWhep(
			whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP),
			whepEnv({ WHEP_SRC_URL_TEMPLATE: undefined, CF_STREAM_CUSTOMER_CODE: "abc123" }),
			"org_A",
			deps,
		);
		expect(relayCalls[0].url).toBe(`https://customer-abc123.cloudflarestream.com/${UID}/webRTC/play`);
	});
});

describe("handleWhep — PATCH/DELETE on the resource", () => {
	it("PATCH trickle → 204 for a known resource; proxies the frag to the Stream resource", async () => {
		const { deps, relayCalls } = mockDeps();
		const env = whepEnv();
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		const res = await handleWhep(
			whepReq("PATCH", "/v1/whep/resource/wep00000001", { "content-type": "application/trickle-ice-sdpfrag" }, "a=candidate:..."),
			env,
			"org_A",
			deps,
		);
		expect(res!.status).toBe(204);
		const patch = relayCalls.find((c) => c.method === "PATCH");
		expect(patch?.url).toBe(STREAM_RESOURCE);
	});

	it("PATCH with wrong content-type → 415", async () => {
		const { deps } = mockDeps();
		const env = whepEnv();
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", deps);
		const res = await handleWhep(whepReq("PATCH", "/v1/whep/resource/wep00000001", { "content-type": "text/plain" }, "x"), env, "org_A", deps);
		expect(res!.status).toBe(415);
	});

	it("DELETE → 204, emits the teardown meter (idempotency=resourceId), proxies DELETE, clears the record", async () => {
		const { deps, meterCalls, relayCalls } = mockDeps({ now: () => 1_000_000 + 90_000 }); // +90s → ceil = 2 min
		const env = whepEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-token" });
		// subscribe (startedAt = 1_000_000) with a separate mock, then advance the delete clock.
		await handleWhep(whepReq("POST", SUB, { "content-type": "application/sdp" }, OFFER_SDP), env, "org_A", mockDeps().deps);
		const res = await handleWhep(whepReq("DELETE", "/v1/whep/resource/wep00000001"), env, "org_A", deps);
		expect(res!.status).toBe(204);
		expect(relayCalls.some((c) => c.method === "DELETE" && c.url === STREAM_RESOURCE)).toBe(true);
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

describe("resolveStreamPlaybackUrl — template substitution + code fallback", () => {
	it("substitutes {uid} in the template", () => {
		expect(resolveStreamPlaybackUrl({ WHEP_SRC_URL_TEMPLATE: TEMPLATE } as WhepEnv, UID)).toBe(
			`https://customer-test.cloudflarestream.com/${UID}/webRTC/play`,
		);
	});
	it("builds from the customer code when no template", () => {
		expect(resolveStreamPlaybackUrl({ CF_STREAM_CUSTOMER_CODE: "xyz" } as WhepEnv, UID)).toBe(
			`https://customer-xyz.cloudflarestream.com/${UID}/webRTC/play`,
		);
	});
	it("accepts the CLOUDFLARE_STREAM_CUSTOMER_CODE alias", () => {
		expect(resolveStreamPlaybackUrl({ CLOUDFLARE_STREAM_CUSTOMER_CODE: "leg" } as WhepEnv, UID)).toBe(
			`https://customer-leg.cloudflarestream.com/${UID}/webRTC/play`,
		);
	});
	it("null when nothing is configured", () => {
		expect(resolveStreamPlaybackUrl({} as WhepEnv, UID)).toBeNull();
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

describe("whepEgressEnabled / useCloudflareStream flag parsing", () => {
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
	it.each([
		[undefined, false],
		["0", false],
		["1", true],
		["true", true],
		[true, true],
	])("USE_CLOUDFLARE_STREAM=%s → %s", (v, expected) => {
		expect(useCloudflareStream({ USE_CLOUDFLARE_STREAM: v } as WhepEnv)).toBe(expected);
	});
});
