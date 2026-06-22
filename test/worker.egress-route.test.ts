/**
 * EGRESS ROUTE TESTS (LK-rip #77 server-half) — wave-realtime-edge worker.
 *
 * The gateway-fronted egress control plane the WSC WaveEgressProviderService (#4984) drives:
 *   POST /rtk/egress/start  — arm a WAVE-native recording egress for a room (wraps the proven pull-mode
 *                             recorder: create an RTK meeting, persist meetingId→org, start RTK recording).
 *   POST /rtk/egress/stop   — stop an in-progress egress (best-effort; the RTK recording auto-stops at
 *                             meeting end and the webhook pulls the finished file into our R2).
 *   POST /rtk/egress/info   — status for an egress (egressId == the RTK meetingId == sessionId).
 *
 * ALL behind the SAME internal-secret chokepoint as the other /rtk/* routes (gatewayGate). DORMANT by
 * default: unarmed (pull mode not configured, the live default) → 501 REALTIME_NOT_IMPLEMENTED, which the
 * WSC client maps to RECORDER_BYTESOURCE_UNAVAILABLE (it fails loud until the edge recorder is armed).
 *
 * These call the handler directly with stub env/ctx (no network, no RTK creds) by default → exercises the
 * 401 gate + the dormant 501. The "armed" cases inject a fake encoder/KV via env so the start path is
 * driven without a live RTK call.
 */
import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;

function req(method: string, path: string, init?: { headers?: Record<string, string>; body?: unknown }): Request {
	return new Request(`https://rt.wave.online${path}`, {
		method,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
}

describe("egress routes — internal-secret gate (gatewayGate)", () => {
	const env = { WAVE_INTERNAL_SECRET: "s3cr3t" } as never;
	for (const intent of ["start", "stop", "info"] as const) {
		it(`POST /rtk/egress/${intent} → 401 without x-wave-internal`, async () => {
			const res = await worker.fetch(req("POST", `/rtk/egress/${intent}`, { body: {} }), env, ctx);
			expect(res.status).toBe(401);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.error).toBe("UNAUTHORIZED");
		});
		it(`POST /rtk/egress/${intent} → passes the gate with the matching secret`, async () => {
			const res = await worker.fetch(
				req("POST", `/rtk/egress/${intent}`, { headers: { "x-wave-internal": "s3cr3t" }, body: {} }),
				env,
				ctx,
			);
			expect(res.status).not.toBe(401);
		});
	}
});

describe("egress routes — DORMANT by default (pull mode unconfigured → 501)", () => {
	// No RT_RECORD / RTK creds / RT_RECORDINGS / RT_MEETING_ORG → pullRecordingConfigured(env) is false.
	const env = {} as never; // also no internal secret → gate is a no-op (local/test contract)
	it("POST /rtk/egress/start → 501 REALTIME_NOT_IMPLEMENTED (client maps to RECORDER_BYTESOURCE_UNAVAILABLE)", async () => {
		const res = await worker.fetch(req("POST", "/rtk/egress/start", { body: { room: "show-2026" } }), env, ctx);
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("REALTIME_NOT_IMPLEMENTED");
	});
	it("POST /rtk/egress/stop → 501 when dormant", async () => {
		const res = await worker.fetch(req("POST", "/rtk/egress/stop", { body: { egressId: "m_1" } }), env, ctx);
		expect(res.status).toBe(501);
	});
	it("POST /rtk/egress/info → 501 when dormant", async () => {
		const res = await worker.fetch(req("POST", "/rtk/egress/info", { body: { egressId: "m_1" } }), env, ctx);
		expect(res.status).toBe(501);
	});
	it("an unknown egress intent → 501 (not a recognized route)", async () => {
		const res = await worker.fetch(req("POST", "/rtk/egress/destroy", { body: {} }), env, ctx);
		expect(res.status).toBe(501);
	});
});

describe("egress start — armed path persists meetingId→org and returns the egress shape", () => {
	// Build an env that satisfies pullRecordingConfigured() with an injected encoder + KV, so no live RTK
	// call happens. We stub selectEncoder via the encoder injection seam used by the worker's join path:
	// here we drive it through a fake RT_MEETING_ORG KV + a fake join by monkeypatching realtimekit.join.
	it("returns { egressId, sessionId, room, status } and writes the meetingId→org KV", async () => {
		const kvStore = new Map<string, string>();
		const kv = {
			get: async (k: string) => kvStore.get(k) ?? null,
			put: async (k: string, v: string) => void kvStore.set(k, v),
			list: async () => ({ keys: [], list_complete: true }),
			delete: async (k: string) => void kvStore.delete(k),
		};
		const env = {
			RT_RECORD: "1",
			CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
			RTK_APP_ID: "00000000-0000-0000-0000-000000000000",
			CF_API_TOKEN: "tok",
			RT_RECORDINGS: {} as never,
			RT_MEETING_ORG: kv as never,
			// Inject the egress join + recording-start seam (added by the worker) so no network is touched.
			__egressDeps: {
				join: async () => ({ meetingId: "m_egress_1" }),
				startRecording: async () => ({ recordingId: "rec_1" }),
			},
		} as never;
		const res = await worker.fetch(
			req("POST", "/rtk/egress/start", { headers: { "x-wave-org": "org_abc" }, body: { room: "show-2026" } }),
			env,
			ctx,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.egressId).toBe("m_egress_1");
		expect(body.sessionId).toBe("m_egress_1");
		expect(body.room).toBe("show-2026");
		expect(typeof body.status).toBe("string");
		// meetingId→org persisted so the recording webhook can attribute the pull.
		expect(kvStore.get("m_egress_1")).toBe("org_abc");
	});

	it("start with a missing/bad x-wave-org → 400 (no KV put, no recording)", async () => {
		const kvStore = new Map<string, string>();
		const env = {
			RT_RECORD: "1",
			CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
			RTK_APP_ID: "00000000-0000-0000-0000-000000000000",
			CF_API_TOKEN: "tok",
			RT_RECORDINGS: {} as never,
			RT_MEETING_ORG: { get: async () => null, put: async (k: string, v: string) => void kvStore.set(k, v) } as never,
			__egressDeps: { join: async () => ({ meetingId: "m1" }), startRecording: async () => ({ recordingId: "r1" }) },
		} as never;
		const res = await worker.fetch(req("POST", "/rtk/egress/start", { body: { room: "show-2026" } }), env, ctx);
		expect(res.status).toBe(400);
		expect(kvStore.size).toBe(0);
	});
});
