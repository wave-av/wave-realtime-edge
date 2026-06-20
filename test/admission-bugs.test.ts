// P5.2-auth — regression tests for the admission state-machine correctness bugs (PR #46).
// Each describe block pins one reviewer-flagged bug. TDD: these failed before the fix.
import { describe, it, expect } from "vitest";
import { RoomCore, RoomStorage, RoomState } from "../src/room.js";
import { Signaling, JoinResult } from "../src/signaling.js";
import { SfuClient } from "../src/sfu.js";
import worker from "../src/worker.js";

// ── shared stubs (mirrors admission.test.ts) ───────────────────────────────────────────────────────

function memStorage(seed?: unknown): RoomStorage {
	const map = new Map<string, unknown>();
	if (seed !== undefined) map.set("room:state", seed);
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
	const fn = async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const method = init?.method ?? "GET";
		const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method));
		if (!route) throw new Error(`no scripted route for ${method} ${url}`);
		return jsonResp(route.body, route.status ?? 200);
	};
	return { fn, calls };
}

function makeSignaling(fetchImpl: (u: string, i?: RequestInit) => Promise<Response>, storage?: RoomStorage) {
	const core = new RoomCore(storage ?? memStorage());
	const sfu = new SfuClient(CFG, fetchImpl as never);
	return { sig: new Signaling(core, sfu), core };
}

const ORG = "org_aaa";
const ROOM = "room-1";

// ── Bug 1: admitted users re-enter the waiting room ────────────────────────────────────────────────

describe("Bug 1 — admitted participant must not be re-queued on retry join", () => {
	it("knock → join(waiting) → admit → join again → gets a session, NOT waiting", async () => {
		const { fn, calls } = scriptedFetch([
			{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
		]);
		const { sig, core } = makeSignaling(fn);
		// first join → knocking
		const first = await sig.join({ org: ORG, room: ROOM, participantId: "p1", type: "meeting", role: "viewer" });
		expect(first).toMatchObject({ waiting: true });
		expect(calls.some((c) => c.url.includes("/sessions/new"))).toBe(false);
		// host admits
		await core.admit("p1");
		// retry join → must be seated, not re-queued
		const second = await sig.join({ org: ORG, room: ROOM, participantId: "p1", type: "meeting", role: "viewer" });
		expect("waiting" in second).toBe(false);
		expect((second as JoinResult).sessionId).toBe(SESSION_A);
		const snap = await core.snapshot();
		expect(snap.participants["p1"]).toBeDefined();
		expect(snap.waiting["p1"]).toBeUndefined();
		// admitted marker consumed
		expect(snap.admitted ?? []).not.toContain("p1");
	});

	it("admissionCheck returns null for an already-admitted pid in knock mode", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		await r.admissionCheck(ORG, { participantId: "p1" });
		await r.admit("p1");
		const res = await r.admissionCheck(ORG, { participantId: "p1" });
		expect(res).toBeNull();
	});
});

// ── Bug 2: hosts blocked in knock rooms ─────────────────────────────────────────────────────────────

describe("Bug 2 — host bypasses the waiting room in knock mode", () => {
	it("host join on a knock meeting is seated immediately (no waiting)", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig, core } = makeSignaling(fn);
		const res = await sig.join({ org: ORG, room: ROOM, participantId: "host1", type: "meeting", role: "host" });
		expect("waiting" in res).toBe(false);
		expect((res as JoinResult).sessionId).toBe(SESSION_A);
		expect((await core.snapshot()).participants["host1"].role).toBe("host");
	});

	it("non-host joiners still wait in a knock room", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		expect(await r.admissionCheck(ORG, { participantId: "viewer1", role: "viewer" })).toMatchObject({ waiting: true });
		expect(await r.admissionCheck(ORG, { participantId: "spk1", role: "speaker" })).toMatchObject({ waiting: true });
	});

	it("RoomCore.admissionCheck lets a host through (returns null) in knock mode", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		expect(await r.admissionCheck(ORG, { participantId: "host1", role: "host" })).toBeNull();
	});
});

// ── Bug 3: backfill persisted fields on load (legacy state) ────────────────────────────────────────

describe("Bug 3 — legacy state without policy/waiting/banned/admitted does not crash", () => {
	function legacyState(): Partial<RoomState> {
		// A record written before the admission change: missing policy/waiting/banned/admitted.
		return {
			config: { roomId: ROOM, org: ORG, ttlMs: 1_800_000 },
			participants: {},
			tracks: {},
			emptyAt: null,
		};
	}

	it("join on legacy state does not throw", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn, memStorage(legacyState()));
		await expect(sig.join({ org: ORG, room: ROOM, participantId: "p1" })).resolves.toBeDefined();
	});

	it("ban on legacy state does not throw (banned[] backfilled)", async () => {
		const r = new RoomCore(memStorage(legacyState()));
		await expect(r.ban("p1")).resolves.toBeNull();
		expect((await r.snapshot()).banned).toContain("p1");
	});

	it("admit/deny on legacy state does not throw (waiting backfilled)", async () => {
		const r = new RoomCore(memStorage(legacyState()));
		await expect(r.deny("p1")).resolves.toBeUndefined();
		await expect(r.admit("ghost")).rejects.toMatchObject({ code: "PARTICIPANT_NOT_WAITING" });
	});
});

// ── Bug 4: invalid room type breaks policy ─────────────────────────────────────────────────────────

describe("Bug 4 — unknown room type does not produce an empty policy", () => {
	it("ensureRoom with an unknown type rejects loudly", async () => {
		const r = new RoomCore(memStorage());
		await expect(r.ensureRoom({ roomId: ROOM, org: ORG, type: "bogus" as never })).rejects.toMatchObject({ code: "BAD_ROOM_TYPE", status: 400 });
		// no half-bound policy left behind
		const snap = await r.snapshot();
		expect(snap.policy).toBeNull();
	});

	it("a known type still produces a complete policy", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		const p = (await r.snapshot()).policy!;
		expect(p.mode).toBe("knock");
		expect(typeof p.locked).toBe("boolean");
		expect(p.capacity === null || typeof p.capacity === "number").toBe(true);
	});
});

// ── Bug 5: worker must validate role & type before trusting them ────────────────────────────────────

const execCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function stubRoomNamespace() {
	const seen: { ctxBody?: Record<string, unknown> } = {};
	return {
		seen,
		idFromName(name: string) { return { __name: name }; },
		get(_id: unknown) {
			return {
				fetch: async (req: Request) => {
					const body = await req.json() as Record<string, unknown>;
					seen.ctxBody = body.ctx as Record<string, unknown>;
					return Response.json({ ok: true });
				},
			};
		},
	};
}

function rt(path: string, headers: Record<string, string>, body: unknown): Request {
	return new Request(`https://rt.wave.online${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("Bug 5 — worker rejects junk role/type (whitelist before trust)", () => {
	it("junk x-wave-role is not propagated as a role", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-role": "superadmin" }, { participantId: "p1" }),
			{ ROOM: ns } as never, execCtx,
		);
		expect(ns.seen.ctxBody?.role).toBeUndefined();
	});

	it("junk x-wave-room-type is not propagated as a type", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-room-type": "bogus" }, { participantId: "p1" }),
			{ ROOM: ns } as never, execCtx,
		);
		expect(ns.seen.ctxBody?.type).toBeUndefined();
	});

	it("junk body type is not propagated", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, { participantId: "p1", type: "evil" }),
			{ ROOM: ns } as never, execCtx,
		);
		expect(ns.seen.ctxBody?.type).toBeUndefined();
	});

	it("valid role + type still pass through", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-role": "host", "x-wave-room-type": "webinar" }, { participantId: "p1" }),
			{ ROOM: ns } as never, execCtx,
		);
		expect(ns.seen.ctxBody?.role).toBe("host");
		expect(ns.seen.ctxBody?.type).toBe("webinar");
	});
});

// ── Bug 6: enforce allowAnonymous ──────────────────────────────────────────────────────────────────

describe("Bug 6 — allowAnonymous is enforced", () => {
	it("allowAnonymous:false + anonymous ctx → rejected", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" }); // allowAnonymous false
		await expect(
			r.admissionCheck(ORG, { participantId: "anon1", role: "host", anon: true }),
		).rejects.toMatchObject({ code: "ANONYMOUS_FORBIDDEN", status: 403 });
	});

	it("allowAnonymous:false + identified ctx → allowed", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting" });
		// identified host bypasses knock → null
		expect(await r.admissionCheck(ORG, { participantId: "host1", role: "host", anon: false })).toBeNull();
	});

	it("allowAnonymous:true (webinar) + anonymous ctx → allowed", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" }); // allowAnonymous true, auto
		expect(await r.admissionCheck(ORG, { participantId: "anon1", anon: true })).toBeNull();
	});

	it("Signaling threads ctx.anon and rejects anonymous when not allowed", async () => {
		const { fn } = scriptedFetch([{ match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } }]);
		const { sig } = makeSignaling(fn);
		await expect(
			sig.join({ org: ORG, room: ROOM, participantId: "anon1", type: "meeting", role: "host", anon: true }),
		).rejects.toMatchObject({ code: "ANONYMOUS_FORBIDDEN", status: 403 });
	});

	it("worker threads x-wave-anon into ctx.anon", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A", "x-wave-anon": "1" }, { participantId: "p1" }),
			{ ROOM: ns } as never, execCtx,
		);
		expect(ns.seen.ctxBody?.anon).toBe(true);
	});

	it("worker defaults ctx.anon to false when header absent", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, { participantId: "p1" }),
			{ ROOM: ns } as never, execCtx,
		);
		expect(ns.seen.ctxBody?.anon).toBe(false);
	});
});

// ── Bug 7: keep room alive while knocks pending ────────────────────────────────────────────────────

describe("Bug 7 — room with pending knocks/admitted is not expired", () => {
	it("a room with only a pending knock is not expired past TTL", async () => {
		const c = clock();
		const r = new RoomCore(memStorage(), c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting", ttlMs: 1000 });
		await r.admissionCheck(ORG, { participantId: "p1" }); // pending knock, no seat
		c.advance(10_000); // well past TTL
		expect(await r.isExpired()).toBe(false);
	});

	it("a room with an admitted-but-not-seated pid is not expired", async () => {
		const c = clock();
		const r = new RoomCore(memStorage(), c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting", ttlMs: 1000 });
		await r.admissionCheck(ORG, { participantId: "p1" });
		await r.admit("p1"); // moved to admitted, not yet seated
		c.advance(10_000);
		expect(await r.isExpired()).toBe(false);
	});

	it("after the last knock is denied, the room can expire", async () => {
		const c = clock();
		const r = new RoomCore(memStorage(), c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "meeting", ttlMs: 1000 });
		await r.admissionCheck(ORG, { participantId: "p1" });
		await r.deny("p1"); // no knocks, no seats
		c.advance(10_000);
		expect(await r.isExpired()).toBe(true);
	});
});

// ── Bug 8: validate capacity ───────────────────────────────────────────────────────────────────────

describe("Bug 8 — setCapacity validates its argument", () => {
	it("setCapacity(-1) is rejected", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await expect(r.setCapacity(-1)).rejects.toMatchObject({ code: "BAD_CAPACITY", status: 400 });
	});

	it("setCapacity(NaN) is rejected", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await expect(r.setCapacity(Number.NaN)).rejects.toMatchObject({ code: "BAD_CAPACITY", status: 400 });
	});

	it("setCapacity(1.5) is rejected (non-integer)", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await expect(r.setCapacity(1.5)).rejects.toMatchObject({ code: "BAD_CAPACITY", status: 400 });
	});

	it("setCapacity(5) is accepted", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.setCapacity(5);
		expect((await r.snapshot()).policy?.capacity).toBe(5);
	});

	it("setCapacity(null) is accepted (unlimited)", async () => {
		const r = new RoomCore(memStorage());
		await r.ensureRoom({ roomId: ROOM, org: ORG, type: "webinar" });
		await r.setCapacity(null);
		expect((await r.snapshot()).policy?.capacity).toBeNull();
	});
});
