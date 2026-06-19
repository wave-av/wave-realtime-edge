// P5.1 — unit tests for the CF Realtime SFU client (mocked fetch, no network).
import { describe, it, expect, vi } from "vitest";
import { SfuClient, SfuError } from "../src/sfu.js";

const CFG = {
	appId: "0123456789abcdef0123456789abcdef", // 32-hex (matches APPID guard)
	appSecret: "test-app-secret",
};
const SESSION = "sess-AbC123_dEf456";

function jsonResp(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

/** A typed fetch stub (so .mock.calls is well-typed) that always returns the given response. */
function stub(make: () => Response) {
	return vi.fn(async (_url: string, _init?: RequestInit) => make());
}

describe("SfuClient construction", () => {
	it("unconfigured app id/secret → 503 REALTIME_NOT_CONFIGURED", () => {
		expect(() => new SfuClient({ appId: "", appSecret: "" }, vi.fn() as never)).toThrowError(
			expect.objectContaining({ code: "REALTIME_NOT_CONFIGURED", status: 503 }),
		);
		expect(() => new SfuClient({ appId: CFG.appId, appSecret: "" }, vi.fn() as never)).toThrowError(
			expect.objectContaining({ code: "REALTIME_NOT_CONFIGURED" }),
		);
	});

	it("uses the default CF host and the configured app id (SSRF: fixed host)", async () => {
		const f = stub(() => jsonResp({ sessionId: SESSION }));
		const c = new SfuClient(CFG, f as never);
		await c.newSession();
		const url = f.mock.calls[0][0] as string;
		expect(url.startsWith("https://rtc.live.cloudflare.com/v1/apps/")).toBe(true);
		expect(url).toContain(`/apps/${CFG.appId}/sessions/new`);
	});

	it("honors an injected baseUrl (staging/test) and strips a trailing slash", async () => {
		const f = stub(() => jsonResp({ sessionId: SESSION }));
		const c = new SfuClient({ ...CFG, baseUrl: "https://stub.local/v1/" }, f as never);
		await c.newSession();
		expect(f.mock.calls[0][0]).toBe("https://stub.local/v1/apps/0123456789abcdef0123456789abcdef/sessions/new");
	});

	it("sends the app secret as a Bearer token, never in the URL", async () => {
		const f = stub(() => jsonResp({ sessionId: SESSION }));
		await new SfuClient(CFG, f as never).newSession();
		const init = f.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CFG.appSecret}`);
		expect(f.mock.calls[0][0]).not.toContain(CFG.appSecret);
	});
});

describe("SfuClient.newSession", () => {
	it("happy path → { sessionId }", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ sessionId: SESSION })));
		expect(await c.newSession()).toEqual({ sessionId: SESSION });
	});

	it("forwards an SDP offer when provided", async () => {
		const f = stub(() => jsonResp({ sessionId: SESSION }));
		await new SfuClient(CFG, f as never).newSession({ type: "offer", sdp: "v=0..." });
		const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
		expect(body.sessionDescription).toEqual({ type: "offer", sdp: "v=0..." });
	});

	it("missing session id in response → 502", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({})));
		await expect(c.newSession()).rejects.toMatchObject({ code: "REALTIME_UPSTREAM", status: 502 });
	});

	it("upstream non-2xx → 502 (never leaks upstream body)", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ secret: "internal-detail" }, 500)));
		let err: SfuError | undefined;
		try {
			await c.newSession();
		} catch (e) {
			err = e as SfuError;
		}
		expect(err?.status).toBe(502);
		expect(err?.message).not.toContain("internal-detail");
	});
});

describe("SfuClient.pushTracks", () => {
	it("happy path → tracks + renegotiation SDP, posts to /tracks/new", async () => {
		const f = stub(() =>
			jsonResp({ tracks: [{ mid: "0", trackName: "cam" }], sessionDescription: { type: "answer", sdp: "a=..." }, requiresImmediateRenegotiation: true }),
		);
		const c = new SfuClient(CFG, f as never);
		const r = await c.pushTracks(SESSION, [{ location: "local", mid: "0", trackName: "cam" }], { type: "offer", sdp: "v=0" });
		expect(r.tracks).toHaveLength(1);
		expect(r.sessionDescription?.type).toBe("answer");
		expect(r.requiresImmediateRenegotiation).toBe(true);
		expect(f.mock.calls[0][0]).toContain(`/sessions/${SESSION}/tracks/new`);
		const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
		expect(body.tracks[0]).toMatchObject({ location: "local", trackName: "cam" });
		expect(body.sessionDescription.type).toBe("offer");
	});

	it("empty track list → 400 BAD_REQUEST (no upstream call)", async () => {
		const f = stub(() => jsonResp({}));
		await expect(new SfuClient(CFG, f as never).pushTracks(SESSION, [])).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
		expect(f).not.toHaveBeenCalled();
	});

	it("invalid session id → 400 (SSRF guard, no upstream call)", async () => {
		const f = stub(() => jsonResp({}));
		await expect(new SfuClient(CFG, f as never).pushTracks("bad id/with/slashes", [{ location: "local", mid: "0", trackName: "x" }])).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(f).not.toHaveBeenCalled();
	});

	it("per-track errorCode in response → 502", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ errorCode: "TrackNotFound", errorDescription: "x" })));
		await expect(c.pushTracks(SESSION, [{ location: "local", mid: "0", trackName: "cam" }])).rejects.toMatchObject({ code: "REALTIME_UPSTREAM", status: 502 });
	});
});

describe("SfuClient.pullTracks", () => {
	it("happy path → subscribes to a remote session's track", async () => {
		const f = stub(() => jsonResp({ tracks: [{ trackName: "cam", sessionId: "other-sess" }], requiresImmediateRenegotiation: false }));
		const c = new SfuClient(CFG, f as never);
		const r = await c.pullTracks(SESSION, [{ location: "remote", sessionId: "other-sess", trackName: "cam" }]);
		expect(r.tracks[0].trackName).toBe("cam");
		const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
		expect(body.tracks[0]).toEqual({ location: "remote", sessionId: "other-sess", trackName: "cam" });
	});

	it("empty list → 400", async () => {
		await expect(new SfuClient(CFG, stub(() => jsonResp({}))).pullTracks(SESSION, [])).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("SfuClient.closeTracks", () => {
	it("happy path → PUT /tracks/close with mids", async () => {
		const f = stub(() => jsonResp({ tracks: [{ mid: "0", trackName: "cam" }] }));
		const c = new SfuClient(CFG, f as never);
		const r = await c.closeTracks(SESSION, ["0"]);
		expect(r.tracks).toHaveLength(1);
		expect((f.mock.calls[0][1] as RequestInit).method).toBe("PUT");
		expect(f.mock.calls[0][0]).toContain(`/sessions/${SESSION}/tracks/close`);
		const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
		expect(body.tracks).toEqual([{ mid: "0" }]);
	});

	it("empty mids → 400", async () => {
		await expect(new SfuClient(CFG, stub(() => jsonResp({}))).closeTracks(SESSION, [])).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("upstream error → 502", async () => {
		await expect(new SfuClient(CFG, stub(() => jsonResp({}, 500))).closeTracks(SESSION, ["0"])).rejects.toMatchObject({ code: "REALTIME_UPSTREAM" });
	});
});

describe("SfuClient.newDataChannel", () => {
	it("happy path → opens a local data channel", async () => {
		const f = stub(() => jsonResp({ dataChannels: [{ id: 1, dataChannelName: "chat" }] }));
		const c = new SfuClient(CFG, f as never);
		const r = await c.newDataChannel(SESSION, [{ location: "local", dataChannelName: "chat" }]);
		expect(r.dataChannels[0].dataChannelName).toBe("chat");
		expect(f.mock.calls[0][0]).toContain(`/sessions/${SESSION}/datachannels/new`);
	});

	it("empty channel list → 400", async () => {
		await expect(new SfuClient(CFG, stub(() => jsonResp({}))).newDataChannel(SESSION, [])).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("SfuClient.renegotiate", () => {
	it("PUTs the sessionDescription to /renegotiate and returns the SFU answer", async () => {
		const f = stub(() => jsonResp({ sessionDescription: { type: "answer", sdp: "a=ok" } }));
		const c = new SfuClient(CFG, f as never);
		const r = await c.renegotiate(SESSION, { type: "answer", sdp: "v=client" });
		expect(r.sessionDescription).toEqual({ type: "answer", sdp: "a=ok" });
		expect(f.mock.calls[0][0]).toContain(`/sessions/${SESSION}/renegotiate`);
		expect((f.mock.calls[0][1] as RequestInit).method).toBe("PUT");
	});

	it("rejects a missing/invalid sessionDescription → 400", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({})));
		await expect(c.renegotiate(SESSION, { type: "answer", sdp: "" })).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	});

	it("rejects an invalid session id → 400", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({})));
		await expect(c.renegotiate("bad/id", { type: "answer", sdp: "v=x" })).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	});
});
