// P5.2-auth — admission policy, waiting room, and safety ops tests.
// Covers Task 7 (RoomCore), Task 8 (Signaling), Task 9 (worker x-wave-role/type threading).
import { describe, it, expect, vi } from "vitest";
import { RoomCore, RoomStorage } from "../src/room.js";
import { Signaling, JoinResult } from "../src/signaling.js";
import { SfuClient } from "../src/sfu.js";
import worker from "../src/worker.js";

// ── shared stubs ─────────────────────────────────────────────────────────────────────────────────

function memStorage(): RoomStorage {
	const map = new Map<string, unknown>();
	return {
		async get<T>(k: string) { return map.get(k) as T | undefined; },
		async put<T>(k: string, v: T) { map.set(k, v); },
	};
}

function clock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const CFG = { appId: "0123456789abcdef0123456789abcdef", appSecret: "test-secret" };
const SESSION_A = "sess-AAAAAAAA";

function jsonResp(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

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

function makeSignaling(fetchImpl: (u: string, i?: RequestInit) => Promise<Response>) {
	const core = new RoomCore(memStorage());
	const sfu = new SfuClient(CFG, fetchImpl as never);
	return { sig: new Signaling(core, sfu), core };
}

const ORG = "org_aaa";
const ROOM = "room-1";

// ── Task 7: RoomCore admission policy ────────────────────────────────────────────────────────────

describe("RoomCore admission — per-type policy defaults", () => {
	it("meeting type → knock mode, speaker default", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		const snap = await r.snapshot();
		expect(snap.policy?.mode).toBe("knock");
		expect(snap.policy?.defaultRole).toBe("speaker");
		expect(snap.policy?.allowAnonymous).toBe(false);
	});

	it("webinar type → auto mode, viewer default, allowAnonymous", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		const snap = await r.snapshot();
		expect(snap.policy?.mode).toBe("auto");
		expect(snap.policy?.defaultRole).toBe("viewer");
		expect(snap.policy?.allowAnonymous).toBe(true);
	});

	it("event type → auto, capacity 10000", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "event" });
		const snap = await r.snapshot();
		expect(snap.policy?.mode).toBe("auto");
		expect(snap.policy?.capacity).toBe(10000);
	});

	it("breakout type → auto, viewer default, allowAnonymous false", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "breakout" });
		const snap = await r.snapshot();
		expect(snap.policy?.mode).toBe("auto");
		expect(snap.policy?.defaultRole).toBe("viewer");
		expect(snap.policy?.allowAnonymous).toBe(false);
	});

	it("no type → no policy (null), joinRoom works without policy checks", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		const snap = await r.snapshot();
		expect(snap.policy).toBeNull();
		// joinRoom still works
		const p = await r.joinRoom(ORG, { participantId: "p1", sessionId: "s1" });
		expect(p.participantId).toBe("p1");
	});
});

describe("RoomCore admission — knock mode: waiting room", () => {
	it("knock join places participant in waiting, returns WaitingResult", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		const result = await r.admissionCheck(ORG, { participantId: "p1" });
		expect(result).toMatchObject({ waiting: true, participantId: "p1" });
		const snap = await r.snapshot();
		expect(snap.waiting["p1"]).toBeDefined();
		// Not a participant yet
		expect(snap.participants["p1"]).toBeUndefined();
	});

	it("admit() promotes waiting participant and removes from waiting", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		await r.admissionCheck(ORG, { participantId: "p1", role: "speaker" });
		const entry = await r.admit("p1");
		expect(entry.participantId).toBe("p1");
		expect(entry.role).toBe("speaker");
		const snap = await r.snapshot();
		expect(snap.waiting["p1"]).toBeUndefined();
	});

	it("admit() on non-waiting → 404 PARTICIPANT_NOT_WAITING", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		await expect(r.admit("ghost")).rejects.toMatchObject({ code: "PARTICIPANT_NOT_WAITING", status: 404 });
	});

	it("deny() removes from waiting, no error for unknown pid", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		await r.admissionCheck(ORG, { participantId: "p1" });
		await r.deny("p1");
		expect((await r.snapshot()).waiting["p1"]).toBeUndefined();
		await r.deny("p1"); // idempotent
	});
});

describe("RoomCore admission — lock/unlock", () => {
	it("locked room blocks new joins → 423 ROOM_LOCKED", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.lock();
		await expect(r.admissionCheck(ORG, { participantId: "p1" })).rejects.toMatchObject({ code: "ROOM_LOCKED", status: 423 });
	});

	it("unlock() allows joins again", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.lock();
		await r.unlock();
		const result = await r.admissionCheck(ORG, { participantId: "p1" });
		expect(result).toBeNull(); // auto mode, not waiting
	});

	it("lock with no policy is a no-op (does not throw)", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		await expect(r.lock()).resolves.toBeUndefined();
	});
});

describe("RoomCore admission — capacity enforcement", () => {
	it("at-capacity room → 429 ROOM_FULL", async () => {
		const c = clock();
		const r = new RoomCore(memStorage(), c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.setCapacity(1);
		// seat one participant
		await r.admissionCheck(ORG, { participantId: "p1" });
		await r.joinRoom(ORG, { participantId: "p1", sessionId: "s1" });
		// second should be rejected
		await expect(r.admissionCheck(ORG, { participantId: "p2" })).rejects.toMatchObject({ code: "ROOM_FULL", status: 429 });
	});

	it("setCapacity(null) removes limit", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.setCapacity(1);
		await r.joinRoom(ORG, { participantId: "p1", sessionId: "s1" });
		await r.setCapacity(null);
		const result = await r.admissionCheck(ORG, { participantId: "p2" });
		expect(result).toBeNull(); // admitted
	});
});

describe("RoomCore admission — eject", () => {
	it("eject removes participant and GCs their tracks, returns sessionId", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		await r.joinRoom(ORG, { participantId: "p1", sessionId: "s1" });
		await r.registerTrack(ORG, { trackName: "cam", sessionId: "s1", participantId: "p1", kind: "video" });
		const sid = await r.eject("p1");
		expect(sid).toBe("s1");
		const snap = await r.snapshot();
		expect(snap.participants["p1"]).toBeUndefined();
		expect(snap.tracks["cam"]).toBeUndefined();
	});

	it("eject of non-existent participant returns null", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		expect(await r.eject("ghost")).toBeNull();
	});
});

describe("RoomCore admission — ban", () => {
	it("ban persists deny: future admissionCheck → 403 PARTICIPANT_BANNED", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.ban("p1");
		await expect(r.admissionCheck(ORG, { participantId: "p1" })).rejects.toMatchObject({ code: "PARTICIPANT_BANNED", status: 403 });
	});

	it("ban also ejects if participant is in the room, returns sessionId", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		await r.joinRoom(ORG, { participantId: "p1", sessionId: "s1" });
		const sid = await r.ban("p1");
		expect(sid).toBe("s1");
		expect((await r.snapshot()).participants["p1"]).toBeUndefined();
	});

	it("ban removes from waiting room too", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		await r.admissionCheck(ORG, { participantId: "p1" });
		await r.ban("p1");
		expect((await r.snapshot()).waiting["p1"]).toBeUndefined();
	});
});

describe("RoomCore admission — endRoom", () => {
	it("endRoom evicts all participants and returns their sessionIds", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		await r.joinRoom(ORG, { participantId: "p1", sessionId: "s1" });
		await r.joinRoom(ORG, { participantId: "p2", sessionId: "s2" });
		const sids = await r.endRoom();
		expect(sids.sort()).toEqual(["s1", "s2"]);
		const snap = await r.snapshot();
		expect(Object.keys(snap.participants)).toHaveLength(0);
		expect(Object.keys(snap.tracks)).toHaveLength(0);
	});

	it("endRoom on empty room returns empty array", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG });
		expect(await r.endRoom()).toEqual([]);
	});
});

// ── Task 8: Signaling honors admission + role from ctx ───────────────────────────────────────────

describe("Signaling.join — knock room: waiting sentinel, no SFU session", () => {
	it("join on a knock room returns {waiting:true} and does NOT call sfu.newSession", async () => {
		const { fn, calls } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
		]);
		const { sig } = makeSignaling(fn);
		// meeting = knock mode
		const res = await sig.join({ org: "org_a", room: "room-1", participantId: "p_alice", type: "meeting" });
		expect(res).toMatchObject({ waiting: true, participantId: "p_alice" });
		// No SFU call
		expect(calls.some((c) => c.url.includes("/sessions/new"))).toBe(false);
	});

	it("join on a webinar (auto) still mints SFU session", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		const res = await sig.join({ org: "org_a", room: "room-1", participantId: "p_alice", type: "webinar" });
		expect("waiting" in res).toBe(false);
		const joined = res as JoinResult;
		expect(joined.sessionId).toBe(SESSION_A);
	});
});

describe("Signaling.join — role from ctx", () => {
	it("role in ctx takes precedence and is recorded on the participant", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig, core } = makeSignaling(fn);
		await sig.join({ org: "org_a", room: "room-1", participantId: "p_alice", role: "viewer" });
		const snap = await core.snapshot();
		expect(snap.participants["p_alice"].role).toBe("viewer");
	});

	it("ctx.role overrides opts.role", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig, core } = makeSignaling(fn);
		await sig.join({ org: "org_a", room: "room-1", participantId: "p_alice", role: "viewer" }, { role: "host" });
		expect((await core.snapshot()).participants["p_alice"].role).toBe("viewer");
	});
});

// ── Task 9: worker threads x-wave-role and x-wave-room-type into ctx ─────────────────────────────

const execCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function stubRoomNamespace(handler?: (req: Request) => Response | Promise<Response>) {
	const seen: { name?: string; intentUrl?: string; ctxBody?: unknown } = {};
	return {
		seen,
		idFromName(name: string) { seen.name = name; return { __name: name }; },
		get(_id: unknown) {
			return {
				fetch: async (req: Request) => {
					seen.intentUrl = new URL(req.url).pathname.replace(/^\//, "");
					const body = await req.json() as Record<string, unknown>;
					seen.ctxBody = body.ctx;
					if (handler) return handler(req);
					return Response.json({ ok: true });
				},
			};
		},
	};
}

function rt(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Request {
	return new Request(`https://rt.wave.online${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("worker — x-wave-role threaded into DO ctx", () => {
	it("x-wave-role header is forwarded in ctx.role", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-role": "viewer" }, { participantId: "p1" }),
			{ ROOM: ns } as never,
			execCtx,
		);
		expect((ns.seen.ctxBody as Record<string, unknown>)?.role).toBe("viewer");
	});

	it("absent x-wave-role → ctx.role is undefined", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, { participantId: "p1" }),
			{ ROOM: ns } as never,
			execCtx,
		);
		expect((ns.seen.ctxBody as Record<string, unknown>)?.role).toBeUndefined();
	});

	it("x-wave-room-type header is forwarded in ctx.type", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-room-type": "meeting" }, { participantId: "p1" }),
			{ ROOM: ns } as never,
			execCtx,
		);
		expect((ns.seen.ctxBody as Record<string, unknown>)?.type).toBe("meeting");
	});

	it("type from body is forwarded in ctx.type when no header", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, { participantId: "p1", type: "webinar" }),
			{ ROOM: ns } as never,
			execCtx,
		);
		expect((ns.seen.ctxBody as Record<string, unknown>)?.type).toBe("webinar");
	});

	it("header type takes precedence over body type", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-room-type": "event" }, { participantId: "p1", type: "meeting" }),
			{ ROOM: ns } as never,
			execCtx,
		);
		expect((ns.seen.ctxBody as Record<string, unknown>)?.type).toBe("event");
	});
});
