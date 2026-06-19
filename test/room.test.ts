// P5.1 — unit tests for the Room DO state machine (in-memory storage, injectable clock, no DO runtime).
import { describe, it, expect } from "vitest";
import { RoomCore, RoomStorage, TRACK_GC_MS, DEFAULT_ROOM_TTL_MS } from "../src/room.js";

/** In-memory RoomStorage stub. */
function memStorage(): RoomStorage & { map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		map,
		async get<T>(k: string) {
			return map.get(k) as T | undefined;
		},
		async put<T>(k: string, v: T) {
			map.set(k, v);
		},
	};
}

/** A controllable clock so GC/TTL transitions are deterministic. */
function clock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms) };
}

const ORG_A = "org_aaa";
const ORG_B = "org_bbb";
const ROOM = "room-1";

function makeRoom(now?: () => number) {
	return new RoomCore(memStorage(), now);
}

describe("RoomCore.ensureRoom (org binding)", () => {
	it("binds the room to an org with the default TTL", async () => {
		const r = makeRoom();
		const cfg = await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		expect(cfg.org).toBe(ORG_A);
		expect(cfg.ttlMs).toBe(DEFAULT_ROOM_TTL_MS);
	});

	it("is idempotent for the same (room, org)", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		const again = await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		expect(again.org).toBe(ORG_A);
	});

	it("rejects rebinding to a different org → 409 ROOM_ORG_MISMATCH (per-org isolation)", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await expect(r.ensureRoom({ roomId: ROOM, org: ORG_B })).rejects.toMatchObject({ code: "ROOM_ORG_MISMATCH", status: 409 });
	});
});

describe("RoomCore.joinRoom / leaveRoom", () => {
	it("joins a participant with role-default permissions", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		const p = await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1", role: "host" });
		expect(p.permissions).toEqual({ canPublish: true, canSubscribe: true });
		expect((await r.listParticipants()).map((x) => x.participantId)).toEqual(["p1"]);
	});

	it("viewer role defaults to subscribe-only", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		const p = await r.joinRoom(ORG_A, { participantId: "v1", sessionId: "s1", role: "viewer" });
		expect(p.permissions).toEqual({ canPublish: false, canSubscribe: true });
	});

	it("join into an unbound room → 409 ROOM_NOT_BOUND", async () => {
		const r = makeRoom();
		await expect(r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" })).rejects.toMatchObject({ code: "ROOM_NOT_BOUND" });
	});

	it("leave removes the participant and is idempotent", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await r.leaveRoom(ORG_A, "p1");
		expect(await r.listParticipants()).toHaveLength(0);
		await r.leaveRoom(ORG_A, "p1"); // idempotent, no throw
	});

	it("leave GCs every track owned by the participant's session", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await r.registerTrack(ORG_A, { trackName: "p1-cam", sessionId: "s1", participantId: "p1", kind: "video" });
		await r.registerTrack(ORG_A, { trackName: "p1-mic", sessionId: "s1", participantId: "p1", kind: "audio" });
		await r.leaveRoom(ORG_A, "p1");
		expect(await r.listTracks()).toHaveLength(0);
	});
});

describe("RoomCore — per-org isolation invariant", () => {
	it("org B cannot join org A's room → 403 ROOM_ORG_MISMATCH", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await expect(r.joinRoom(ORG_B, { participantId: "intruder", sessionId: "sX" })).rejects.toMatchObject({ code: "ROOM_ORG_MISMATCH", status: 403 });
	});

	it("org B cannot register a track in org A's room", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await expect(r.registerTrack(ORG_B, { trackName: "x", sessionId: "s1", participantId: "p1", kind: "audio" })).rejects.toMatchObject({
			code: "ROOM_ORG_MISMATCH",
		});
	});

	it("org B cannot leave a participant from org A's room", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await expect(r.leaveRoom(ORG_B, "p1")).rejects.toMatchObject({ code: "ROOM_ORG_MISMATCH" });
	});
});

describe("RoomCore — track registry", () => {
	it("registering a track for a participant not in the room → 409", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await expect(r.registerTrack(ORG_A, { trackName: "x", sessionId: "s9", participantId: "ghost", kind: "audio" })).rejects.toMatchObject({
			code: "PARTICIPANT_NOT_IN_ROOM",
		});
	});

	it("unregisterTrack removes a track and is idempotent", async () => {
		const r = makeRoom();
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await r.registerTrack(ORG_A, { trackName: "p1-cam", sessionId: "s1", participantId: "p1", kind: "video" });
		await r.unregisterTrack("p1-cam");
		expect(await r.listTracks()).toHaveLength(0);
		await r.unregisterTrack("p1-cam"); // idempotent
	});
});

describe("RoomCore.reconcileTracks (CF Realtime 30s GC)", () => {
	it("drops tracks idle past TRACK_GC_MS, keeps recently-touched ones", async () => {
		const c = clock();
		const r = makeRoom(c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await r.registerTrack(ORG_A, { trackName: "stale", sessionId: "s1", participantId: "p1", kind: "video" });
		await r.registerTrack(ORG_A, { trackName: "fresh", sessionId: "s1", participantId: "p1", kind: "audio" });

		c.advance(TRACK_GC_MS - 1);
		await r.touchTrack("fresh"); // heartbeat keeps it alive
		c.advance(2); // now "stale" is > GC_MS old, "fresh" is ~2ms old

		const removed = await r.reconcileTracks();
		expect(removed).toEqual(["stale"]);
		expect((await r.listTracks()).map((t) => t.trackName)).toEqual(["fresh"]);
	});

	it("no-op when all tracks are fresh", async () => {
		const c = clock();
		const r = makeRoom(c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await r.registerTrack(ORG_A, { trackName: "t", sessionId: "s1", participantId: "p1", kind: "audio" });
		expect(await r.reconcileTracks()).toEqual([]);
	});
});

describe("RoomCore — room TTL / expiry", () => {
	it("an occupied room is never expired", async () => {
		const c = clock();
		const r = makeRoom(c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG_A, ttlMs: 1000 });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		c.advance(10_000);
		expect(await r.isExpired()).toBe(false);
	});

	it("an empty room expires after its TTL", async () => {
		const c = clock();
		const r = makeRoom(c.now);
		await r.ensureRoom({ roomId: ROOM, org: ORG_A, ttlMs: 1000 });
		await r.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		await r.leaveRoom(ORG_A, "p1"); // now empty, emptyAt set
		expect(await r.isExpired()).toBe(false); // still within TTL
		c.advance(1001);
		expect(await r.isExpired()).toBe(true);
	});
});

describe("RoomCore — persistence", () => {
	it("state survives a fresh RoomCore over the same storage (DO restart)", async () => {
		const storage = memStorage();
		const r1 = new RoomCore(storage);
		await r1.ensureRoom({ roomId: ROOM, org: ORG_A });
		await r1.joinRoom(ORG_A, { participantId: "p1", sessionId: "s1" });
		const r2 = new RoomCore(storage); // simulate DO eviction + reload
		expect((await r2.listParticipants()).map((p) => p.participantId)).toEqual(["p1"]);
		const snap = await r2.snapshot();
		expect(snap.config?.org).toBe(ORG_A);
	});
});
