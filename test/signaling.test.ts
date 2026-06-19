// P5.2 — unit tests for the signaling layer (mocked SfuClient HTTP + in-memory Room storage, no network).
//
// Signaling translates client intents (join/leave/publish/subscribe/renegotiate) ↔ Room DO state
// (RoomCore) ↔ the CF Realtime SFU client (sfu.ts). AUTH IS OUT (P5.2-auth, separate): every call
// receives an already-validated { org, room, participantId } context.
import { describe, it, expect, vi } from "vitest";
import { Signaling, SignalError } from "../src/signaling.js";
import { RoomCore, RoomStorage } from "../src/room.js";
import { SfuClient } from "../src/sfu.js";

/** In-memory RoomStorage stub. */
function memStorage(): RoomStorage {
	const map = new Map<string, unknown>();
	return {
		async get<T>(k: string) {
			return map.get(k) as T | undefined;
		},
		async put<T>(k: string, v: T) {
			map.set(k, v);
		},
	};
}

const CFG = { appId: "0123456789abcdef0123456789abcdef", appSecret: "test-secret" };
const SESSION_A = "sess-AAAAAAAA";
const SESSION_B = "sess-BBBBBBBB";

function jsonResp(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

/**
 * A scripted fetch: routes by URL substring + method to a queued/handler response so each SFU call
 * (newSession / tracks/new / tracks/close / renegotiate) returns a deterministic body. No network.
 */
function scriptedFetch(routes: Array<{ match: string; method?: string; body: unknown; status?: number }>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fn = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const method = init?.method ?? "GET";
		const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method));
		if (!route) throw new Error(`no scripted route for ${method} ${url}`);
		return jsonResp(route.body, route.status ?? 200);
	});
	return { fn, calls };
}

function makeSignaling(fetchImpl: (u: string, i?: RequestInit) => Promise<Response>, now?: () => number) {
	const core = new RoomCore(memStorage(), now);
	const sfu = new SfuClient(CFG, fetchImpl as never);
	return { sig: new Signaling(core, sfu), core };
}

const CTX_A = { org: "org_a", room: "room-1", participantId: "p_alice" };
const CTX_B = { org: "org_a", room: "room-1", participantId: "p_bob" };

describe("Signaling.join", () => {
	it("creates an SFU session, binds the room to the org, and records the participant", async () => {
		const { fn, calls } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
		]);
		const { sig, core } = makeSignaling(fn);

		const res = await sig.join(CTX_A);
		expect(res.sessionId).toBe(SESSION_A);
		expect(res.participantId).toBe("p_alice");

		const snap = await core.snapshot();
		expect(snap.config?.org).toBe("org_a");
		expect(snap.participants["p_alice"].sessionId).toBe(SESSION_A);
		// the SFU offer (if any) is forwarded to /sessions/new
		expect(calls[0].url).toContain("/sessions/new");
	});

	it("forwards a client SDP offer to the SFU and returns the SFU answer", async () => {
		const { fn } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A, sessionDescription: { type: "answer", sdp: "a=ans" } } },
		]);
		const { sig } = makeSignaling(fn);
		const res = await sig.join(CTX_A, { offer: { type: "offer", sdp: "v=0" } });
		expect(res.sessionDescription).toEqual({ type: "answer", sdp: "a=ans" });
	});

	it("honors an explicit role (viewer cannot publish later)", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig, core } = makeSignaling(fn);
		await sig.join(CTX_A, { role: "viewer" });
		expect((await core.snapshot()).participants["p_alice"].role).toBe("viewer");
	});

	it("rejects a missing participantId → 400", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await expect(sig.join({ org: "org_a", room: "room-1", participantId: "" })).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	});

	it("an org-A token cannot join an org-B-bound room → 403 (per-org isolation)", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await sig.join({ org: "org_b", room: "room-1", participantId: "p_first" });
		// ensureRoom binds room-1 to org_b first; a join from org_a is rejected at the binding check.
		await expect(sig.join({ org: "org_a", room: "room-1", participantId: "p_alice" })).rejects.toMatchObject({ code: "ROOM_ORG_MISMATCH" });
	});
});

describe("Signaling.publishTrack", () => {
	it("pushes tracks to the SFU and registers them in the room registry", async () => {
		const { fn } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
			{ match: "/tracks/new", method: "POST", body: { tracks: [{ mid: "0", trackName: "cam" }], sessionDescription: { type: "answer", sdp: "a=ok" } } },
		]);
		const { sig, core } = makeSignaling(fn);
		await sig.join(CTX_A);

		const res = await sig.publishTrack(CTX_A, {
			tracks: [{ mid: "0", trackName: "cam", kind: "video" }],
			offer: { type: "offer", sdp: "v=0" },
		});
		expect(res.sessionDescription?.type).toBe("answer");
		const snap = await core.snapshot();
		expect(snap.tracks["cam"]).toMatchObject({ sessionId: SESSION_A, participantId: "p_alice", kind: "video" });
	});

	it("a viewer (canPublish=false) is denied → 403, no SFU call", async () => {
		const { fn, calls } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await sig.join(CTX_A, { role: "viewer" });
		await expect(
			sig.publishTrack(CTX_A, { tracks: [{ mid: "0", trackName: "cam", kind: "video" }], offer: { type: "offer", sdp: "v=0" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
		expect(calls.some((c) => c.url.includes("/tracks/new"))).toBe(false);
	});

	it("publishing before joining → 409 PARTICIPANT_NOT_IN_ROOM", async () => {
		const { fn } = scriptedFetch([{ match: "/tracks/new", method: "POST", body: { tracks: [] } }]);
		const { sig } = makeSignaling(fn);
		await expect(
			sig.publishTrack(CTX_A, { tracks: [{ mid: "0", trackName: "cam", kind: "video" }], offer: { type: "offer", sdp: "v=0" } }),
		).rejects.toMatchObject({ code: "PARTICIPANT_NOT_IN_ROOM", status: 409 });
	});

	it("requires at least one track → 400", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await sig.join(CTX_A);
		await expect(sig.publishTrack(CTX_A, { tracks: [], offer: { type: "offer", sdp: "v=0" } })).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
	});
});

describe("Signaling.subscribeTrack", () => {
	it("a second participant pulls a published track from the publisher's session", async () => {
		const { fn, calls } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }, // alice joins → reused for bob via override below
			{ match: "/tracks/new", method: "POST", body: { tracks: [{ mid: "0", trackName: "cam" }] } },
		]);
		// alice joins+publishes
		const { sig, core } = makeSignaling(fn);
		await sig.join(CTX_A);
		await sig.publishTrack(CTX_A, { tracks: [{ mid: "0", trackName: "cam", kind: "video" }], offer: { type: "offer", sdp: "v=0" } });

		// bob joins with a distinct session, then subscribes to alice's "cam"
		// re-script: newSession returns SESSION_B for bob's join
		const bobRoutes = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_B } },
			{ match: "/tracks/new", method: "POST", body: { tracks: [{ trackName: "cam" }], sessionDescription: { type: "offer", sdp: "v=pull" }, requiresImmediateRenegotiation: true } },
		]);
		const sig2 = new Signaling(core, new SfuClient(CFG, bobRoutes.fn as never));
		await sig2.join(CTX_B);
		const res = await sig2.subscribeTrack(CTX_B, { trackName: "cam" });
		expect(res.requiresImmediateRenegotiation).toBe(true);
		// the pull body referenced the PUBLISHER's session id (alice's)
		const pull = bobRoutes.calls.find((c) => c.url.includes("/tracks/new"));
		const body = JSON.parse(pull!.init!.body as string);
		expect(body.tracks[0]).toMatchObject({ location: "remote", sessionId: SESSION_A, trackName: "cam" });
	});

	it("subscribing to an unknown track → 404 TRACK_NOT_FOUND, no SFU call", async () => {
		const { fn, calls } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await sig.join(CTX_A);
		await expect(sig.subscribeTrack(CTX_A, { trackName: "ghost" })).rejects.toMatchObject({ code: "TRACK_NOT_FOUND", status: 404 });
		expect(calls.some((c) => c.url.includes("/tracks/new"))).toBe(false);
	});

	it("a viewer may subscribe (canSubscribe=true)", async () => {
		const { fn } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
			{ match: "/tracks/new", method: "POST", body: { tracks: [{ mid: "0", trackName: "cam" }] } },
		]);
		const { sig, core } = makeSignaling(fn);
		await sig.join(CTX_A);
		await sig.publishTrack(CTX_A, { tracks: [{ mid: "0", trackName: "cam", kind: "audio" }], offer: { type: "offer", sdp: "v=0" } });

		const viewerRoutes = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_B } },
			{ match: "/tracks/new", method: "POST", body: { tracks: [{ trackName: "cam" }] } },
		]);
		const sig2 = new Signaling(core, new SfuClient(CFG, viewerRoutes.fn as never));
		await sig2.join(CTX_B, { role: "viewer" });
		const res = await sig2.subscribeTrack(CTX_B, { trackName: "cam" });
		expect(res.tracks[0].trackName).toBe("cam");
	});
});

describe("Signaling.renegotiate", () => {
	it("forwards a client renegotiation SDP to the SFU for the participant's session", async () => {
		const { fn, calls } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
			{ match: "/renegotiate", method: "PUT", body: { sessionDescription: { type: "answer", sdp: "a=reneg" } } },
		]);
		const { sig } = makeSignaling(fn);
		await sig.join(CTX_A);
		const res = await sig.renegotiate(CTX_A, { answer: { type: "answer", sdp: "v=client" } });
		expect(res.sessionDescription).toEqual({ type: "answer", sdp: "a=reneg" });
		const reneg = calls.find((c) => c.url.includes("/renegotiate"));
		expect(reneg?.url).toContain(`/sessions/${SESSION_A}/renegotiate`);
	});

	it("renegotiating before joining → 409 PARTICIPANT_NOT_IN_ROOM", async () => {
		const { fn } = scriptedFetch([{ match: "/renegotiate", method: "PUT", body: {} }]);
		const { sig } = makeSignaling(fn);
		await expect(sig.renegotiate(CTX_A, { answer: { type: "answer", sdp: "x" } })).rejects.toMatchObject({ code: "PARTICIPANT_NOT_IN_ROOM", status: 409 });
	});
});

describe("Signaling.leave", () => {
	it("removes the participant and GCs their tracks", async () => {
		const { fn } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
			{ match: "/tracks/new", method: "POST", body: { tracks: [{ mid: "0", trackName: "cam" }] } },
		]);
		const { sig, core } = makeSignaling(fn);
		await sig.join(CTX_A);
		await sig.publishTrack(CTX_A, { tracks: [{ mid: "0", trackName: "cam", kind: "video" }], offer: { type: "offer", sdp: "v=0" } });

		await sig.leave(CTX_A);
		const snap = await core.snapshot();
		expect(snap.participants["p_alice"]).toBeUndefined();
		expect(snap.tracks["cam"]).toBeUndefined();
	});

	it("leave is idempotent (leaving twice does not throw)", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await sig.join(CTX_A);
		await sig.leave(CTX_A);
		await expect(sig.leave(CTX_A)).resolves.toBeUndefined();
	});

	it("an org mismatch on leave → 403", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await sig.join(CTX_A);
		await expect(sig.leave({ org: "org_b", room: "room-1", participantId: "p_alice" })).rejects.toMatchObject({ code: "ROOM_ORG_MISMATCH", status: 403 });
	});
});

describe("SignalError", () => {
	it("carries a code + status and is an Error", () => {
		const e = new SignalError("BAD_REQUEST", "x", 400);
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe("BAD_REQUEST");
		expect(e.status).toBe(400);
	});
});
