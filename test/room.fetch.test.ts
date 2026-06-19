// P5.2 wiring — RoomDO.fetch() control-plane surface.
//
// The DO's fetch() is the in-DO chokepoint the worker entry forwards realtime intents to. It runs the
// Signaling orchestration (src/signaling.ts) over THIS room's RoomCore (DO storage) + an SfuClient built
// from the DO's env. These tests construct RoomDO directly with an in-memory storage stub and a stubbed
// SFU (env.__sfuFetch) so no live DO runtime / CF network is needed.
import { describe, it, expect } from "vitest";
import { RoomDO } from "../src/room.js";

// In-memory DO storage stub (matches RoomStorage: get/put).
function memStorage() {
	const map = new Map<string, unknown>();
	return {
		get: async <T>(k: string) => map.get(k) as T | undefined,
		put: async <T>(k: string, v: T) => void map.set(k, v),
	};
}

// A stub CF Realtime SFU: answers sessions/new + tracks/new so join/publish succeed without network.
function sfuFetch(): typeof fetch {
	let n = 0;
	return (async (input: string) => {
		const url = String(input);
		if (url.endsWith("/sessions/new")) {
			return new Response(JSON.stringify({ sessionId: `sess-abc-${++n}` }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("/tracks/new")) {
			return new Response(JSON.stringify({ tracks: [{ trackName: "t", mid: "0" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
}

// Env the DO reads. CF_CALLS_APP_ID must look like a CF app id (long hex) so SfuClient constructs.
function env(extra: Record<string, unknown> = {}) {
	return {
		CF_CALLS_APP_ID: "a".repeat(32),
		CF_CALLS_APP_SECRET: "shh-secret",
		__sfuFetch: sfuFetch(),
		...extra,
	};
}

function intent(action: string, body: Record<string, unknown>): Request {
	return new Request(`https://do/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const ctx = { org: "org-A", room: "room-1", participantId: "p1" };

describe("RoomDO.fetch — join", () => {
	it("creates an SFU session and records the participant (200 + sessionId)", async () => {
		const do_ = new RoomDO({ storage: memStorage() }, env());
		const res = await do_.fetch(intent("join", { ctx, role: "host" }));
		expect(res.status).toBe(200);
		const b = (await res.json()) as Record<string, unknown>;
		expect(b.participantId).toBe("p1");
		expect(typeof b.sessionId).toBe("string");
	});

	it("a second org cannot join a room bound to the first (per-org isolation → 4xx)", async () => {
		const storage = memStorage();
		const a = new RoomDO({ storage }, env());
		await a.fetch(intent("join", { ctx, role: "host" }));
		const b = new RoomDO({ storage }, env());
		const res = await b.fetch(intent("join", { ctx: { ...ctx, org: "org-B" }, role: "host" }));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
	});
});

describe("RoomDO.fetch — leave emits metering when provisioned", () => {
	it("flushes participant usage to the gateway /v1/internal/usage on leave", async () => {
		const storage = memStorage();
		// The metering tap (metering.ts emitParticipantUsage) uses the GLOBAL fetch; stub it. The SFU client
		// uses the injected __sfuFetch, so this stub only ever sees the gateway internal-usage call.
		const calls: { url: string }[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string) => {
			calls.push({ url: String(input) });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const e = env({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-token" });
			// join → publish video → leave (so there is billable video time).
			await new RoomDO({ storage }, e).fetch(intent("join", { ctx, role: "host" }));
			await new RoomDO({ storage }, e).fetch(
				intent("publish", {
					ctx,
					tracks: [{ mid: "0", trackName: "video-1", kind: "video" }],
					offer: { type: "offer", sdp: "v=0" },
				}),
			);
			const res = await new RoomDO({ storage }, e).fetch(intent("leave", { ctx }));
			expect(res.status).toBe(200);
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.every((c) => c.url.includes("/v1/internal/usage"))).toBe(true);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("does NOT emit metering when GATEWAY/token are unset (inert)", async () => {
		const storage = memStorage();
		let metered = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			metered++;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const e = env(); // no GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN
			await new RoomDO({ storage }, e).fetch(intent("join", { ctx, role: "host" }));
			await new RoomDO({ storage }, e).fetch(intent("leave", { ctx }));
			expect(metered).toBe(0);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("RoomDO.fetch — fails closed when SFU unconfigured", () => {
	it("returns 503 REALTIME_NOT_CONFIGURED on join without app creds", async () => {
		const do_ = new RoomDO({ storage: memStorage() }, { __sfuFetch: sfuFetch() }); // no app id/secret
		const res = await do_.fetch(intent("join", { ctx, role: "host" }));
		expect(res.status).toBe(503);
		const b = (await res.json()) as Record<string, unknown>;
		expect(b.error).toBe("REALTIME_NOT_CONFIGURED");
	});
});

describe("RoomDO.fetch — unknown action", () => {
	it("returns 400 for an unknown intent", async () => {
		const do_ = new RoomDO({ storage: memStorage() }, env());
		const res = await do_.fetch(intent("frobnicate", { ctx }));
		expect(res.status).toBe(400);
	});
});
