// channel.test.ts — item #5: the pure ChannelHub engine (channel.ts). Exercised with in-memory fakes, no DO
// runtime (mirrors presence.test.ts's split between the pure engine and the DO glue).
import { describe, it, expect } from "vitest";
import {
	ChannelHub,
	HistoryRing,
	HISTORY_CAP,
	CHANNEL_ID_PATTERN,
	MEMBER_ID_PATTERN,
	type ChannelConn,
	type ChannelServerMsg,
	type SocketRegistry,
} from "../src/channel.js";

function fakeConn(id: string) {
	const sent: ChannelServerMsg[] = [];
	let closed: { code: number; reason: string } | null = null;
	const conn: ChannelConn = {
		id,
		send: (m) => void sent.push(m),
		close: (code, reason) => void (closed = { code, reason }),
	};
	return { conn, sent, get closed() { return closed; } };
}

function registryOf(...conns: ChannelConn[]): SocketRegistry {
	return { all: () => conns };
}

// ── CHANNEL_ID_PATTERN / MEMBER_ID_PATTERN ──────────────────────────────────────────────────────────

describe("CHANNEL_ID_PATTERN — matches spec/realtime.yaml ^[a-z0-9][a-z0-9:_-]{0,127}$", () => {
	it("accepts namespaced ids", () => {
		expect(CHANNEL_ID_PATTERN.test("stream:abc")).toBe(true);
		expect(CHANNEL_ID_PATTERN.test("room:xyz")).toBe(true);
		expect(CHANNEL_ID_PATTERN.test("a")).toBe(true);
		expect(CHANNEL_ID_PATTERN.test("a".repeat(128))).toBe(true);
	});
	it("rejects an id that doesn't start with alnum, is too long, or has bad chars", () => {
		expect(CHANNEL_ID_PATTERN.test(":stream")).toBe(false);
		expect(CHANNEL_ID_PATTERN.test("a".repeat(129))).toBe(false);
		expect(CHANNEL_ID_PATTERN.test("Stream:ABC")).toBe(false); // uppercase not allowed
		expect(CHANNEL_ID_PATTERN.test("stream/abc")).toBe(false);
		expect(CHANNEL_ID_PATTERN.test("")).toBe(false);
	});
});

describe("MEMBER_ID_PATTERN", () => {
	it("accepts a plausible member id", () => {
		expect(MEMBER_ID_PATTERN.test("user_123")).toBe(true);
	});
	it("rejects an empty or over-length id", () => {
		expect(MEMBER_ID_PATTERN.test("")).toBe(false);
		expect(MEMBER_ID_PATTERN.test("a".repeat(129))).toBe(false);
	});
});

// ── HistoryRing ──────────────────────────────────────────────────────────────────────────────────────

describe("HistoryRing — bounded FIFO", () => {
	it("evicts the oldest event once the cap is exceeded", () => {
		const ring = new HistoryRing(3);
		for (let i = 0; i < 5; i++) ring.push({ id: `e${i}`, ts: i, event: "x" });
		expect(ring.snapshot().map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
	});

	it("list(limit) returns the most recent N, oldest-first, clamped to the cap", () => {
		const ring = new HistoryRing(5);
		for (let i = 0; i < 5; i++) ring.push({ id: `e${i}`, ts: i, event: "x" });
		expect(ring.list(2).map((e) => e.id)).toEqual(["e3", "e4"]);
		expect(ring.list(100)).toHaveLength(5); // clamped to cap, never over-returns
		expect(ring.list()).toHaveLength(5); // omitted limit = full ring
	});

	it("HISTORY_CAP matches spec/realtime.yaml's history `limit` ceiling (maximum: 50)", () => {
		expect(HISTORY_CAP).toBe(50);
	});

	it("fromArray rehydrates and defensively caps even an over-long stored array", () => {
		const stored = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, ts: i, event: "x" }));
		const ring = HistoryRing.fromArray(stored, 4);
		expect(ring.snapshot().map((e) => e.id)).toEqual(["e6", "e7", "e8", "e9"]);
	});

	it("fromArray(undefined) yields an empty ring", () => {
		expect(HistoryRing.fromArray(undefined).snapshot()).toEqual([]);
	});
});

// ── ChannelHub ───────────────────────────────────────────────────────────────────────────────────────

describe("ChannelHub.members — de-duplicated by id", () => {
	it("collapses two sockets sharing one id into one member", () => {
		const hub = new ChannelHub(registryOf(fakeConn("a").conn, fakeConn("a").conn, fakeConn("b").conn), new HistoryRing());
		expect(hub.members().map((m) => m.id).sort()).toEqual(["a", "b"]);
	});
});

describe("ChannelHub.welcome — current members + recent history", () => {
	it("sends a welcome frame carrying the channel name, members, and history", () => {
		const a = fakeConn("a");
		const b = fakeConn("b");
		const history = new HistoryRing();
		history.push({ id: "e1", ts: 1, event: "hello" });
		const hub = new ChannelHub(registryOf(a.conn, b.conn), history);
		hub.welcome(a.conn, "stream:1");
		expect(a.sent[0]).toEqual({
			type: "welcome",
			channel: "stream:1",
			members: [{ id: "a" }, { id: "b" }],
			history: [{ id: "e1", ts: 1, event: "hello" }],
		});
	});
});

describe("ChannelHub.announceJoin / announceLeave", () => {
	it("announces a join to every OTHER socket, then resyncs presence to everyone", () => {
		const a = fakeConn("a");
		const b = fakeConn("b");
		const hub = new ChannelHub(registryOf(a.conn, b.conn), new HistoryRing());
		hub.announceJoin(a.conn);
		expect(a.sent.find((m) => m.type === "join")).toBeUndefined(); // never echoed to self
		expect(b.sent[0]).toEqual({ type: "join", id: "a" });
		expect(a.sent.at(-1)).toEqual({ type: "presence", members: [{ id: "a" }, { id: "b" }] });
		expect(b.sent.at(-1)).toEqual({ type: "presence", members: [{ id: "a" }, { id: "b" }] });
	});

	it("announces a leave to every OTHER socket, then resyncs presence", () => {
		const a = fakeConn("a");
		const b = fakeConn("b");
		const hub = new ChannelHub(registryOf(b.conn), new HistoryRing()); // "a" already removed from the registry
		hub.announceLeave(a.conn);
		expect(b.sent[0]).toEqual({ type: "leave", id: "a" });
		expect(b.sent.at(-1)).toEqual({ type: "presence", members: [{ id: "b" }] });
	});
});

describe("ChannelHub.publish", () => {
	it("fans the event out to every current subscriber and returns the delivered count", () => {
		const a = fakeConn("a");
		const b = fakeConn("b");
		const hub = new ChannelHub(registryOf(a.conn, b.conn), new HistoryRing());
		const { event, delivered } = hub.publish("caption.cue", { text: "hi" });
		expect(delivered).toBe(2);
		expect(event.event).toBe("caption.cue");
		expect(typeof event.id).toBe("string");
		expect(a.sent[0]).toEqual({ type: "message", id: event.id, ts: event.ts, event: "caption.cue", data: { text: "hi" } });
		expect(b.sent[0]).toEqual(a.sent[0]);
	});

	it("records the published event into history (visible to a subsequent welcome)", () => {
		const history = new HistoryRing();
		const hub = new ChannelHub(registryOf(), history);
		hub.publish("clip.created", { id: 1 });
		expect(history.list()).toHaveLength(1);
		expect(history.list()[0]?.event).toBe("clip.created");
	});

	it("delivers to zero subscribers without throwing when the channel is empty", () => {
		const hub = new ChannelHub(registryOf(), new HistoryRing());
		const { delivered } = hub.publish("stream.started", undefined);
		expect(delivered).toBe(0);
	});
});
