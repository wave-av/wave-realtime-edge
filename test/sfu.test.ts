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

	it("sends a non-empty User-Agent (CF Realtime blocks a UA-less request → 1010/400 → WHIP 503; #100B)", async () => {
		const f = stub(() => jsonResp({ sessionId: SESSION }));
		await new SfuClient(CFG, f as never).newSession();
		const init = f.mock.calls[0][1] as RequestInit;
		const ua = (init.headers as Record<string, string>)["User-Agent"];
		expect(ua).toBeTruthy();
		expect(ua.length).toBeGreaterThan(0);
	});

	// Regression (live 500 "Illegal invocation"): the client must invoke fetchImpl DETACHED from `this`.
	// The global `fetch` builtin throws when called with a non-global receiver, so calling it as
	// `this.fetchImpl(...)` (receiver = the SfuClient instance) breaks at runtime. A this-sensitive stub
	// reproduces that: a plain function records its own `this`, which MUST be undefined at the call site.
	it("invokes fetchImpl with `this` === undefined (no Illegal invocation against the real fetch)", async () => {
		let receiver: unknown = "unset";
		const thisSensitive = function (this: unknown): Promise<Response> {
			receiver = this;
			return Promise.resolve(jsonResp({ sessionId: SESSION }));
		};
		await new SfuClient(CFG, thisSensitive as never).newSession();
		expect(receiver).toBeUndefined();
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
		const init = f.mock.calls[0][1] as { body: string; headers: Record<string, string> };
		const body = JSON.parse(init.body);
		expect(body.sessionDescription).toEqual({ type: "offer", sdp: "v=0..." });
		expect(init.headers["Content-Type"]).toBe("application/json");
	});

	// Regression (live CF 400 "Body JSON validation error: sessionDescription"): a no-offer session must
	// send NO body (and no JSON Content-Type) — CF rejects an empty `{}` but accepts a bodyless POST.
	it("sends NO body and NO Content-Type when there is no offer", async () => {
		const f = stub(() => jsonResp({ sessionId: SESSION }));
		await new SfuClient(CFG, f as never).newSession();
		const init = f.mock.calls[0][1] as { body?: unknown; headers: Record<string, string> };
		expect(init.body).toBeUndefined();
		expect(init.headers["Content-Type"]).toBeUndefined();
		expect(init.headers.Authorization).toBe(`Bearer ${CFG.appSecret}`);
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

describe("SfuClient.sessionLiveness", () => {
	it("200 with a non-inactive track → alive", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ tracks: [{ status: "active" }] })));
		expect(await c.sessionLiveness(SESSION)).toBe("alive");
	});

	it("200 with every track inactive → gone", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ tracks: [{ status: "inactive" }, { status: "inactive" }] })));
		expect(await c.sessionLiveness(SESSION)).toBe("gone");
	});

	it("200 with tracks:[] → idle (a healthy no-pushTracks WHIP publish looks like this, #233)", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ tracks: [], dataChannels: [] })));
		expect(await c.sessionLiveness(SESSION)).toBe("idle");
	});

	it("404 → gone (the SFU no longer knows this session)", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ errorCode: "not_found" }, 404)));
		expect(await c.sessionLiveness(SESSION)).toBe("gone");
	});

	// #240 — live-verified 2026-07-19: a disconnected WHIP session (PeerConnection gone) answers 410 Gone,
	// while a live trackless publish answers 200. Before this fix, 410 fell into `!res.ok → "unknown"` and
	// the sweeper treated a dead orphan as ALIVE until the 24h TTL. 410 must map to "gone" like 404.
	it("410 Gone (disconnected PeerConnection) → gone", async () => {
		const c = new SfuClient(
			CFG,
			stub(() =>
				jsonResp(
					{ errorCode: "session_error", errorDescription: "Session appears to be disconnected. Please check if the PeerConnection is connected." },
					410,
				),
			),
		);
		expect(await c.sessionLiveness(SESSION)).toBe("gone");
	});

	it("other non-ok (500) → unknown (must NOT close a session on a server error)", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ errorCode: "internal" }, 500)));
		expect(await c.sessionLiveness(SESSION)).toBe("unknown");
	});

	it("401 Unauthorized → unknown (auth failure is not proof the session is gone)", async () => {
		const c = new SfuClient(CFG, stub(() => jsonResp({ errorCode: "unauthorized" }, 401)));
		expect(await c.sessionLiveness(SESSION)).toBe("unknown");
	});

	it("transport throw → unknown (cannot tell, so the sweeper assumes live)", async () => {
		const c = new SfuClient(CFG, vi.fn(async () => { throw new Error("boom"); }) as never);
		expect(await c.sessionLiveness(SESSION)).toBe("unknown");
	});

	it("non-JSON 200 body → unknown", async () => {
		const c = new SfuClient(CFG, stub(() => new Response("<html>not json</html>", { status: 200 })));
		expect(await c.sessionLiveness(SESSION)).toBe("unknown");
	});

	it("malformed session id → unknown (no upstream call)", async () => {
		const f = stub(() => jsonResp({ tracks: [] }));
		const c = new SfuClient(CFG, f as never);
		expect(await c.sessionLiveness("bad/id/slashes")).toBe("unknown");
		expect(f).not.toHaveBeenCalled();
	});
});
