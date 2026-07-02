// E-ROOMS P4 (#73) — RoomDO presence intent wiring: the DO owns the hibernatable socket, welcomes it, and
// broadcasts the authoritative view after a room mutation (join). Constructs RoomDO directly with an
// in-memory storage + hibernation stub — no live DO runtime (matching room.fetch.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RoomDO } from "../src/room.js";
import type { PresenceServerMsg } from "../src/presence.js";

function memStorage() {
	const map = new Map<string, unknown>();
	return { get: async <T>(k: string) => map.get(k) as T | undefined, put: async <T>(k: string, v: T) => void map.set(k, v) };
}

function sfuFetch(): typeof fetch {
	let n = 0;
	return (async (input: string) => {
		const url = String(input);
		if (url.endsWith("/sessions/new")) return new Response(JSON.stringify({ sessionId: `sess-abc-${++n}` }), { status: 200, headers: { "content-type": "application/json" } });
		if (url.includes("/tracks/new")) return new Response(JSON.stringify({ tracks: [{ trackName: "t", mid: "0" }] }), { status: 200, headers: { "content-type": "application/json" } });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
}

class FakeWs {
	sent: string[] = [];
	private attachment: unknown = null;
	send(s: string) { this.sent.push(s); }
	close() {}
	serializeAttachment(a: unknown) { this.attachment = a; }
	deserializeAttachment() { return this.attachment; }
}

// A DO state with the optional hibernation API (presence-capable).
function wsState() {
	const sockets: FakeWs[] = [];
	return {
		storage: memStorage(),
		sockets,
		acceptWebSocket(ws: WebSocket) { sockets.push(ws as unknown as FakeWs); },
		getWebSockets(): WebSocket[] { return sockets as unknown as WebSocket[]; },
	};
}

function env() {
	return { CF_CALLS_APP_ID: "a".repeat(32), CF_CALLS_APP_SECRET: "shh", __sfuFetch: sfuFetch() };
}

let serverWs: FakeWs;
beforeEach(() => {
	serverWs = new FakeWs();
	(globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair = class { 0 = new FakeWs(); 1 = serverWs; };
});
afterEach(() => { delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair; });

function presenceReq(qs: string): Request {
	return new Request(`https://room/presence?${qs}`, { method: "GET" });
}
function intent(action: string, body: Record<string, unknown>): Request {
	return new Request(`https://room/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("RoomDO.fetch — presence intent", () => {
	it("503s when the runtime lacks the hibernation API (storage-only state)", async () => {
		const do_ = new RoomDO({ storage: memStorage() }, env());
		const res = await do_.fetch(presenceReq("participantId=p1&role=viewer"));
		expect(res.status).toBe(503);
	});

	it("400s a presence upgrade with no participantId", async () => {
		const do_ = new RoomDO(wsState(), env());
		const res = await do_.fetch(presenceReq("role=viewer"));
		expect(res.status).toBe(400);
	});

	it("accepts the socket and sends a welcome snapshot", async () => {
		const do_ = new RoomDO(wsState(), env());
		const res = await do_.fetch(presenceReq("participantId=p1&role=host"));
		expect([101, 200]).toContain(res.status);
		const welcome = JSON.parse(serverWs.sent[0]!) as PresenceServerMsg;
		expect(welcome).toMatchObject({ type: "welcome", version: 0 });
	});

	it("broadcasts an authoritative state frame to the subscriber after a join (bumped version)", async () => {
		const state = wsState();
		const do_ = new RoomDO(state, env());
		// subscribe first (welcome @ v0), then a participant joins → the socket receives a state frame
		await do_.fetch(presenceReq("participantId=watcher&role=viewer"));
		expect(serverWs.sent).toHaveLength(1); // welcome only
		const joinRes = await do_.fetch(intent("join", { ctx: { org: "org-A", room: "room-1", participantId: "p1" }, role: "host" }));
		expect(joinRes.status).toBe(200);
		const frames = serverWs.sent.map((s) => JSON.parse(s) as PresenceServerMsg);
		const state1 = frames.find((f) => f.type === "state");
		expect(state1).toBeTruthy();
		expect((state1 as { version: number }).version).toBe(1); // bumped past the welcome's v0
		expect((state1 as { view: { occupancy: number } }).view.occupancy).toBe(1);

		// A second mutation bumps monotonically (v2) — the conflict-free ordering signal.
		await do_.fetch(intent("join", { ctx: { org: "org-A", room: "room-1", participantId: "p2" }, role: "speaker" }));
		const versions = serverWs.sent.map((s) => JSON.parse(s) as PresenceServerMsg).filter((f) => f.type === "state").map((f) => (f as { version: number }).version);
		expect(versions).toEqual([1, 2]);
	});
});
