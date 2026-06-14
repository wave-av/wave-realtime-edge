// CF-3.1.2 — unit tests for the RealtimeKit join flow (mocked fetch, no network).
import { describe, it, expect, vi } from "vitest";
import { join, RtkError } from "../src/realtimekit.js";

const CFG = {
	accountId: "d674452f756fe46885a0d6ce7bc23f0a", // 32-hex (matches HEX32 guard)
	appId: "6dee33e5-cd89-41e8-a81c-9a8cd48bb9c3",
	token: "test-token",
};

// Build a fetch stub that returns the RealtimeKit `data`-envelope shapes (verified live).
function fetchStub(meetingId = "bbb63343-59f8-448c-95c6-6b0fd25b3561", token = "participant-jwt") {
	return vi.fn(async (urlStr: string) => {
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
