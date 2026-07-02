// E-ROOMS P4 (#73) — presence / state-sync / data channel.
//
// The pure engine (projectRoomView / parseInbound / PresenceHub) is exercised with in-memory fakes, and the
// Durable-Object glue (acceptPresenceSocket / onPresenceMessage / broadcastPresence) with a fake DO state + a
// stubbed WebSocketPair — no live DO runtime, matching room.fetch.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	projectRoomView,
	parseInbound,
	PresenceHub,
	acceptPresenceSocket,
	onPresenceMessage,
	broadcastPresence,
	DEFAULT_MAX_MESSAGE_BYTES,
	type PresenceConn,
	type PresenceServerMsg,
	type SocketRegistry,
} from "../src/presence.js";
import type { RoomState, Participant, RoomTrack } from "../src/room.js";

// ── State + fake builders ─────────────────────────────────────────────────────────────────────────

function participant(id: string, over: Partial<Participant> = {}): Participant {
	return {
		participantId: id,
		sessionId: `sess-${id}`,
		role: "speaker",
		permissions: { canPublish: true, canSubscribe: true },
		joinedAt: 1000,
		...over,
	};
}

function track(name: string, pid: string, kind: "audio" | "video" = "audio"): RoomTrack {
	return { trackName: name, sessionId: `sess-${pid}`, participantId: pid, kind, lastSeenAt: 1000 };
}

function roomState(over: Partial<RoomState> = {}): RoomState {
	return {
		config: { roomId: "room-1", org: "org-A", ttlMs: 60000 },
		participants: {},
		tracks: {},
		emptyAt: null,
		policy: { mode: "knock", locked: false, capacity: null, defaultRole: "speaker", allowAnonymous: false },
		waiting: {},
		banned: [],
		admitted: [],
		...over,
	};
}

/** A fake PresenceConn that records everything sent + any close. */
function fakeConn(participantId: string, role: "host" | "speaker" | "viewer" = "speaker") {
	const sent: PresenceServerMsg[] = [];
	let closed: { code: number; reason: string } | null = null;
	const conn: PresenceConn = {
		participantId,
		role,
		send: (m) => void sent.push(m),
		close: (code, reason) => void (closed = { code, reason }),
	};
	return { conn, sent, get closed() { return closed; } };
}

function registryOf(...conns: PresenceConn[]): SocketRegistry {
	return { all: () => conns };
}

// ── projectRoomView ─────────────────────────────────────────────────────────────────────────────

describe("projectRoomView — client-safe projection", () => {
	it("never leaks SFU sessionIds, the ban list, or admitted markers", () => {
		const state = roomState({
			participants: { p1: participant("p1", { publishedAudio: true }) },
			tracks: { "t-1": track("t-1", "p1", "video") },
			banned: ["evil"],
			admitted: ["p9"],
		});
		const view = projectRoomView(state, { includeWaiting: false });
		const json = JSON.stringify(view);
		expect(json).not.toContain("sess-p1");
		expect(json).not.toContain("evil");
		expect(json).not.toContain("p9");
		expect(view.participants[0]).toEqual({ participantId: "p1", role: "speaker", publishedAudio: true, publishedVideo: false });
		expect(view.tracks[0]).toEqual({ trackName: "t-1", participantId: "p1", kind: "video" });
		expect(view.occupancy).toBe(1);
	});

	it("shows the waiting list ONLY to hosts (moderation), never to others", () => {
		const state = roomState({ waiting: { w1: { participantId: "w1", role: "viewer", requestedAt: 5 } } });
		const hostView = projectRoomView(state, { includeWaiting: true });
		const viewerView = projectRoomView(state, { includeWaiting: false });
		expect(hostView.waiting).toEqual([{ participantId: "w1", role: "viewer", requestedAt: 5 }]);
		expect(hostView.waitingCount).toBe(1);
		expect(viewerView.waiting).toBeUndefined();
		expect(viewerView.waitingCount).toBe(1); // count is safe to share; identities are not
	});
});

// ── parseInbound (hardening) ───────────────────────────────────────────────────────────────────────

describe("parseInbound — frame validation", () => {
	it("accepts ping and data (JSON text)", () => {
		expect(parseInbound(JSON.stringify({ type: "ping" }))).toEqual({ ok: true, msg: { type: "ping" } });
		expect(parseInbound(JSON.stringify({ type: "data", data: { hi: 1 } }))).toEqual({ ok: true, msg: { type: "data", data: { hi: 1 } } });
	});
	it("rejects a binary frame (media never flows on the presence channel)", () => {
		const res = parseInbound(new ArrayBuffer(4));
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("BAD_FRAME");
	});
	it("rejects an over-cap payload by BYTE length", () => {
		const big = JSON.stringify({ type: "data", data: "x".repeat(DEFAULT_MAX_MESSAGE_BYTES) });
		const res = parseInbound(big);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("MESSAGE_TOO_LARGE");
	});
	it("rejects invalid JSON, non-objects, unknown types, and a data message with no data", () => {
		expect(parseInbound("{not json").ok).toBe(false);
		expect(parseInbound("42").ok).toBe(false);
		expect(parseInbound(JSON.stringify({ type: "nope" })).ok).toBe(false);
		const noData = parseInbound(JSON.stringify({ type: "data" }));
		expect(noData.ok).toBe(false);
		if (!noData.ok) expect(noData.code).toBe("BAD_MESSAGE");
	});
});

// ── PresenceHub ─────────────────────────────────────────────────────────────────────────────────

describe("PresenceHub — state-sync", () => {
	it("welcomes a socket with a role-appropriate snapshot + version", () => {
		const state = roomState({ waiting: { w1: { participantId: "w1", role: "viewer", requestedAt: 5 } } });
		const host = fakeConn("h", "host");
		const viewer = fakeConn("v", "viewer");
		const hub = new PresenceHub(registryOf(host.conn, viewer.conn));
		hub.welcome(host.conn, state, 7);
		hub.welcome(viewer.conn, state, 7);
		expect(host.sent[0]).toMatchObject({ type: "welcome", version: 7 });
		expect((host.sent[0] as { view: { waiting?: unknown[] } }).view.waiting).toHaveLength(1);
		expect((viewer.sent[0] as { view: { waiting?: unknown[] } }).view.waiting).toBeUndefined();
	});

	it("broadcasts the authoritative view to every subscriber, projected per-role", () => {
		const state = roomState({
			participants: { p1: participant("p1") },
			waiting: { w1: { participantId: "w1", role: "viewer", requestedAt: 5 } },
		});
		const host = fakeConn("h", "host");
		const viewer = fakeConn("v", "viewer");
		const hub = new PresenceHub(registryOf(host.conn, viewer.conn));
		hub.broadcast(state, 3);
		expect(host.sent[0]).toMatchObject({ type: "state", version: 3 });
		expect((host.sent[0] as { view: { waiting?: unknown[] } }).view.waiting).toHaveLength(1);
		expect((viewer.sent[0] as { view: { waiting?: unknown[] } }).view.waiting).toBeUndefined();
	});
});

describe("PresenceHub — data channel + hardening", () => {
	it("fans a data message out to the OTHER participants, never echoing the sender", () => {
		const a = fakeConn("a");
		const b = fakeConn("b");
		const c = fakeConn("c");
		const hub = new PresenceHub(registryOf(a.conn, b.conn, c.conn));
		const closed = hub.handle(a.conn, JSON.stringify({ type: "data", data: { msg: "hi" } }));
		expect(closed).toBe(false);
		expect(a.sent).toHaveLength(0); // sender is not echoed
		expect(b.sent[0]).toEqual({ type: "data", from: "a", data: { msg: "hi" } });
		expect(c.sent[0]).toEqual({ type: "data", from: "a", data: { msg: "hi" } });
	});

	it("answers ping with pong", () => {
		const a = fakeConn("a");
		const hub = new PresenceHub(registryOf(a.conn));
		hub.handle(a.conn, JSON.stringify({ type: "ping" }));
		expect(a.sent[0]).toEqual({ type: "pong" });
	});

	it("returns a typed error and closes a socket after repeated violations (abuse guard)", () => {
		const a = fakeConn("a");
		const hub = new PresenceHub(registryOf(a.conn), { maxViolations: 3 });
		expect(hub.handle(a.conn, "{bad")).toBe(false);
		expect(hub.handle(a.conn, "{bad")).toBe(false);
		expect(a.closed).toBeNull();
		const closedNow = hub.handle(a.conn, "{bad");
		expect(closedNow).toBe(true);
		expect(a.closed).toEqual({ code: 1008, reason: "too many protocol violations" });
		expect(a.sent.every((m) => m.type === "error")).toBe(true);
	});
});

// ── Durable-Object glue (fake state + stubbed WebSocketPair) ────────────────────────────────────────

class FakeWs {
	sent: string[] = [];
	closed: { code: number; reason: string } | null = null;
	private attachment: unknown = null;
	send(s: string) { this.sent.push(s); }
	close(code: number, reason: string) { this.closed = { code, reason }; }
	serializeAttachment(a: unknown) { this.attachment = a; }
	deserializeAttachment() { return this.attachment; }
}

class FakeDOState {
	sockets: FakeWs[] = [];
	storage = (() => {
		const map = new Map<string, unknown>();
		return { get: async <T>(k: string) => map.get(k) as T | undefined, put: async <T>(k: string, v: T) => void map.set(k, v) };
	})();
	acceptWebSocket(ws: WebSocket, _tags?: string[]) { this.sockets.push(ws as unknown as FakeWs); }
	getWebSockets(_tag?: string): WebSocket[] { return this.sockets as unknown as WebSocket[]; }
}

let serverWs: FakeWs;
beforeEach(() => {
	serverWs = new FakeWs();
	(globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair = class {
		0 = new FakeWs(); // client
		1 = serverWs; // server
	};
});
afterEach(() => {
	delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
});

function lastMsg(ws: FakeWs): PresenceServerMsg {
	return JSON.parse(ws.sent[ws.sent.length - 1]!) as PresenceServerMsg;
}

describe("DO glue — accept / broadcast / message", () => {
	it("acceptPresenceSocket registers the socket, stamps identity, and sends the welcome snapshot", () => {
		const state = new FakeDOState();
		const res = acceptPresenceSocket(state as unknown as never, { participantId: "p1", role: "host" }, roomState(), 4);
		expect([101, 200]).toContain(res.status); // node Response ctor rejects 101 → 200 fallback
		expect(state.sockets).toHaveLength(1);
		const welcome = lastMsg(serverWs);
		expect(welcome).toMatchObject({ type: "welcome", version: 4 });
	});

	it("503s when the runtime has no WebSocketPair", () => {
		delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
		const res = acceptPresenceSocket(new FakeDOState() as unknown as never, { participantId: "p1", role: "viewer" }, roomState(), 0);
		expect(res.status).toBe(503);
	});

	it("broadcastPresence pushes a state frame to every connected socket", () => {
		const state = new FakeDOState();
		// two connected presence sockets with attachments
		const w1 = new FakeWs(); w1.serializeAttachment({ participantId: "a", role: "viewer" });
		const w2 = new FakeWs(); w2.serializeAttachment({ participantId: "b", role: "host" });
		state.sockets.push(w1, w2);
		broadcastPresence(state as unknown as never, roomState({ participants: { a: participant("a") } }), 9);
		expect(lastMsg(w1)).toMatchObject({ type: "state", version: 9 });
		expect(lastMsg(w2)).toMatchObject({ type: "state", version: 9 });
	});

	it("onPresenceMessage relays a data frame to other sockets and closes an unidentified socket", () => {
		const state = new FakeDOState();
		const a = new FakeWs(); a.serializeAttachment({ participantId: "a", role: "speaker" });
		const b = new FakeWs(); b.serializeAttachment({ participantId: "b", role: "speaker" });
		state.sockets.push(a, b);
		onPresenceMessage(state as unknown as never, a as unknown as WebSocket, JSON.stringify({ type: "data", data: 1 }));
		expect(lastMsg(b)).toEqual({ type: "data", from: "a", data: 1 });
		expect(a.sent).toHaveLength(0);

		const orphan = new FakeWs(); // no attachment
		onPresenceMessage(state as unknown as never, orphan as unknown as WebSocket, JSON.stringify({ type: "ping" }));
		expect(orphan.closed).toEqual({ code: 1008, reason: "unidentified presence socket" });
	});
});
