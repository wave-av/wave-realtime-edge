// CF-3.1.2 — unit tests for the RealtimeKit join flow (mocked fetch, no network).
import { describe, it, expect, vi } from "vitest";
import { join, turn, clampTurnTtl, RtkError } from "../src/realtimekit.js";

const CFG = {
	accountId: "d674452f756fe46885a0d6ce7bc23f0a", // 32-hex (matches HEX32 guard)
	appId: "6dee33e5-cd89-41e8-a81c-9a8cd48bb9c3",
	token: "test-token",
};

// Build a fetch stub that returns the RealtimeKit `data`-envelope shapes (verified live).
function fetchStub(meetingId = "bbb63343-59f8-448c-95c6-6b0fd25b3561", token = "participant-jwt") {
	return vi.fn(async (urlStr: string, _init?: RequestInit) => {
		if (urlStr.endsWith("/meetings")) {
			return new Response(JSON.stringify({ success: true, data: { id: meetingId, status: "ACTIVE" } }), { status: 201 });
		}
		if (urlStr.includes(`/meetings/${meetingId}/participants`)) {
			return new Response(JSON.stringify({ success: true, data: { id: "aaa-1", token } }), { status: 200 });
		}
		return new Response(JSON.stringify({ success: false, errors: [{ message: "unexpected" }] }), { status: 404 });
	});
}

describe("realtimekit.join", () => {
	it("happy path → {meetingId, token, appId}", async () => {
		const f = fetchStub();
		const r = await join(CFG, { name: "Ada" }, f as never);
		expect(r).toEqual({
			meetingId: "bbb63343-59f8-448c-95c6-6b0fd25b3561",
			token: "participant-jwt",
			appId: CFG.appId,
		});
		// two upstream calls: create meeting, then add participant
		expect(f).toHaveBeenCalledTimes(2);
	});

	it("calls the correct CF Realtime endpoints in order", async () => {
		const f = fetchStub();
		await join(CFG, { name: "Ada" }, f as never);
		const urls = f.mock.calls.map((c) => c[0] as string);
		expect(urls[0]).toContain(`/accounts/${CFG.accountId}/realtime/kit/${CFG.appId}/meetings`);
		expect(urls[1]).toContain(`/meetings/bbb63343-59f8-448c-95c6-6b0fd25b3561/participants`);
		expect(urls[0].startsWith("https://api.cloudflare.com/")).toBe(true); // SSRF: fixed host
	});

	it("ALWAYS sends a custom_participant_id (RealtimeKit requires it; 400 without)", async () => {
		const f = fetchStub();
		await join(CFG, { name: "Ada" }, f as never); // no customParticipantId provided
		const participantBody = JSON.parse((f.mock.calls[1][1] as unknown as { body: string }).body) as Record<string, unknown>;
		expect(typeof participantBody.custom_participant_id).toBe("string");
		expect((participantBody.custom_participant_id as string).length).toBeGreaterThan(0);
	});

	it("uses the caller's custom_participant_id when provided", async () => {
		const f = fetchStub();
		await join(CFG, { name: "Ada", customParticipantId: "u-42" }, f as never);
		const participantBody = JSON.parse((f.mock.calls[1][1] as unknown as { body: string }).body) as Record<string, unknown>;
		expect(participantBody.custom_participant_id).toBe("u-42");
	});

	it("missing config → 503 REALTIME_NOT_CONFIGURED", async () => {
		await expect(join({ accountId: "", appId: "", token: "" }, { name: "Ada" }, fetchStub() as never)).rejects.toMatchObject({
			code: "REALTIME_NOT_CONFIGURED",
			status: 503,
		});
	});

	it("missing participant name → 400 BAD_REQUEST", async () => {
		await expect(join(CFG, { name: "" }, fetchStub() as never)).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	});

	it("upstream non-2xx → 502, and never leaks the upstream body", async () => {
		const f = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "secret-internal" }] }), { status: 500 }));
		let err: RtkError | undefined;
		try {
			await join(CFG, { name: "Ada" }, f as never);
		} catch (e) {
			err = e as RtkError;
		}
		expect(err).toBeInstanceOf(RtkError);
		expect(err?.status).toBe(502);
		expect(err?.message).not.toContain("secret-internal");
	});

	it("participant response without a token → 502", async () => {
		const f = vi.fn(async (urlStr: string) => {
			if (urlStr.endsWith("/meetings")) return new Response(JSON.stringify({ success: true, data: { id: "bbb63343-59f8-448c-95c6-6b0fd25b3561" } }), { status: 201 });
			return new Response(JSON.stringify({ success: true, data: { id: "aaa-1" } }), { status: 200 }); // no token
		});
		await expect(join(CFG, { name: "Ada" }, f as never)).rejects.toMatchObject({ code: "REALTIME_UPSTREAM", status: 502 });
	});
});

// CF-3 — TURN/ICE credentials. Fake 32-hex key id (never the real account uid in a public repo).
const TURN_CFG = { keyId: "0123456789abcdef0123456789abcdef", token: "turn-api-token" };
function turnFetchStub(status = 201) {
	return vi.fn(async (_urlStr: string, _init?: RequestInit) =>
		new Response(JSON.stringify({ iceServers: { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478"], username: "u-eph", credential: "c-eph" } }), { status }),
	);
}

describe("realtimekit.clampTurnTtl", () => {
	it("defaults garbage / missing to 86400, and clamps to [60, 86400]", () => {
		expect(clampTurnTtl(undefined)).toBe(86400);
		expect(clampTurnTtl("not-a-number")).toBe(86400);
		expect(clampTurnTtl(NaN)).toBe(86400);
		expect(clampTurnTtl(999999)).toBe(86400); // over max
		expect(clampTurnTtl(-5)).toBe(60); // under min
		expect(clampTurnTtl(30)).toBe(60); // under min
		expect(clampTurnTtl(3600)).toBe(3600); // in range
		expect(clampTurnTtl("7200")).toBe(7200); // numeric string
	});
});

describe("realtimekit.turn", () => {
	it("happy path → W3C RTCIceServer[] array + ttl, ONE call to the fixed TURN host (SSRF-safe)", async () => {
		const f = turnFetchStub();
		const r = await turn(TURN_CFG, 3600, f as never);
		expect(Array.isArray(r.iceServers)).toBe(true); // normalized to the W3C array shape (drop-in for RTCPeerConnection)
		expect(r.iceServers).toHaveLength(1);
		expect(r.iceServers[0].username).toBe("u-eph");
		expect(r.iceServers[0].credential).toBe("c-eph");
		expect(Array.isArray(r.iceServers[0].urls)).toBe(true);
		expect(r.ttl).toBe(3600);
		expect(f).toHaveBeenCalledTimes(1);
		const u = f.mock.calls[0][0] as string;
		expect(u.startsWith(`https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_CFG.keyId}/credentials/generate`)).toBe(true);
	});

	it("clamps the ttl it sends upstream AND echoes the clamped value", async () => {
		const f = turnFetchStub();
		const r = await turn(TURN_CFG, 999999, f as never);
		const sentBody = JSON.parse((f.mock.calls[0][1] as unknown as { body: string }).body) as { ttl: number };
		expect(sentBody.ttl).toBe(86400);
		expect(r.ttl).toBe(86400);
	});

	it("unconfigured key id (not 32-hex) or empty token → 503 REALTIME_NOT_CONFIGURED", async () => {
		await expect(turn({ keyId: "short", token: "t" }, 60, turnFetchStub() as never)).rejects.toMatchObject({ code: "REALTIME_NOT_CONFIGURED", status: 503 });
		await expect(turn({ keyId: TURN_CFG.keyId, token: "" }, 60, turnFetchStub() as never)).rejects.toMatchObject({ code: "REALTIME_NOT_CONFIGURED", status: 503 });
	});

	it("upstream non-2xx → 502", async () => {
		await expect(turn(TURN_CFG, 60, turnFetchStub(500) as never)).rejects.toMatchObject({ code: "REALTIME_UPSTREAM", status: 502 });
	});

	it("upstream 200 but missing iceServers fields → 502", async () => {
		const f = vi.fn(async () => new Response(JSON.stringify({ iceServers: { urls: ["turn:x"] } }), { status: 201 })); // no username/credential
		await expect(turn(TURN_CFG, 60, f as never)).rejects.toMatchObject({ code: "REALTIME_UPSTREAM", status: 502 });
	});
});
