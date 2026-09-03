// channel-do.test.ts — item #5: the ChannelDO Durable-Object glue (channel-do.ts). Fake DO state + a
// stubbed WebSocketPair — no live DO runtime, matching presence.test.ts's "DO glue" section and
// room.fetch.test.ts's convention for this repo.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChannelDO } from "../src/channel-do.js";

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
		return {
			get: async <T>(k: string) => map.get(k) as T | undefined,
			put: async <T>(k: string, v: T) => void map.set(k, v),
		};
	})();
	acceptWebSocket(ws: WebSocket, _tags?: string[]) { this.sockets.push(ws as unknown as FakeWs); }
	getWebSockets(_tag?: string): WebSocket[] { return this.sockets as unknown as WebSocket[]; }
}

/** A DO state with NO hibernation API — exercises the 503 fail-closed path. */
class NoRuntimeDOState {
	storage = { get: async () => undefined, put: async () => {} };
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

function connectReq(channel: string, as?: string): Request {
	const url = new URL("https://channel/connect");
	url.searchParams.set("channel", channel);
	if (as) url.searchParams.set("as", as);
	return new Request(url.toString());
}

function lastMsg(ws: FakeWs): Record<string, unknown> {
	return JSON.parse(ws.sent[ws.sent.length - 1]!) as Record<string, unknown>;
}

/** The `welcome` frame is always the FIRST message a just-connected socket receives (sent before the join/
 *  presence broadcast that follows it) — grab it by index rather than "last", which is a later presence sync. */
function welcomeMsg(ws: FakeWs): Record<string, unknown> {
	return JSON.parse(ws.sent[0]!) as Record<string, unknown>;
}

describe("ChannelDO — connect (GET .../connect)", () => {
	it("registers the socket, stamps identity, sends welcome, and returns 101/200", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		const res = await doInst.fetch(connectReq("stream:1", "alice"));
		expect([101, 200]).toContain(res.status); // node Response ctor rejects 101 → 200 fallback
		expect(state.sockets).toHaveLength(1);
		const welcome = welcomeMsg(serverWs);
		expect(welcome).toMatchObject({ type: "welcome", channel: "stream:1" });
		expect((welcome.members as { id: string }[]).map((m) => m.id)).toContain("alice");
	});

	it("generates a member id when `as` is omitted", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		await doInst.fetch(connectReq("stream:1"));
		const welcome = welcomeMsg(serverWs);
		const members = welcome.members as { id: string }[];
		expect(members).toHaveLength(1);
		expect(members[0]!.id.length).toBeGreaterThan(0);
	});

	it("503s when the runtime has no hibernation API", async () => {
		const doInst = new ChannelDO(new NoRuntimeDOState() as unknown as never);
		const res = await doInst.fetch(connectReq("stream:1", "alice"));
		expect(res.status).toBe(503);
	});

	it("503s when the runtime has no WebSocketPair", async () => {
		delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
		const doInst = new ChannelDO(new FakeDOState() as unknown as never);
		const res = await doInst.fetch(connectReq("stream:1", "alice"));
		expect(res.status).toBe(503);
	});

	it("welcome carries recent history for a subscriber who joins after a publish", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		await doInst.fetch(new Request("https://channel/publish?channel=stream:1", {
			method: "POST",
			body: JSON.stringify({ event: "caption.cue", data: { text: "hi" } }),
		}));
		await doInst.fetch(connectReq("stream:1", "bob"));
		const welcome = welcomeMsg(serverWs);
		expect(welcome.history).toHaveLength(1);
		expect((welcome.history as { event: string }[])[0]!.event).toBe("caption.cue");
	});
});

describe("ChannelDO — publish (POST .../publish)", () => {
	it("delivers to every connected subscriber and returns {ok, delivered, id}", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		await doInst.fetch(connectReq("stream:1", "alice"));
		const secondWs = new FakeWs();
		(globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair = class {
			0 = new FakeWs();
			1 = secondWs;
		};
		await doInst.fetch(connectReq("stream:1", "bob"));

		const res = await doInst.fetch(new Request("https://channel/publish?channel=stream:1", {
			method: "POST",
			body: JSON.stringify({ event: "sentiment.tick", data: { score: 0.9 } }),
		}));
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: boolean; delivered: number; id: string; channel: string };
		expect(body.ok).toBe(true);
		expect(body.delivered).toBe(2);
		expect(body.channel).toBe("stream:1");
		expect(typeof body.id).toBe("string");
		const msg = lastMsg(secondWs);
		expect(msg).toMatchObject({ type: "message", event: "sentiment.tick", data: { score: 0.9 } });
	});

	it("400s a publish with no `event`", async () => {
		const doInst = new ChannelDO(new FakeDOState() as unknown as never);
		const res = await doInst.fetch(new Request("https://channel/publish?channel=stream:1", { method: "POST", body: "{}" }));
		expect(res.status).toBe(400);
	});

	it("400s a publish with an unparsable body", async () => {
		const doInst = new ChannelDO(new FakeDOState() as unknown as never);
		const res = await doInst.fetch(new Request("https://channel/publish?channel=stream:1", { method: "POST", body: "not json" }));
		expect(res.status).toBe(400);
	});
});

describe("ChannelDO — presence (GET .../presence)", () => {
	it("returns the current, de-duplicated member list", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		await doInst.fetch(connectReq("stream:1", "alice"));
		const res = await doInst.fetch(new Request("https://channel/presence?channel=stream:1"));
		const body = await res.json() as { channel: string; members: { id: string }[] };
		expect(body.channel).toBe("stream:1");
		expect(body.members).toEqual([{ id: "alice" }]);
	});
});

describe("ChannelDO — history (GET .../history)", () => {
	it("returns published events, most-recent last, and honors `limit`", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		for (let i = 0; i < 3; i++) {
			await doInst.fetch(new Request("https://channel/publish?channel=stream:1", {
				method: "POST",
				body: JSON.stringify({ event: `e${i}` }),
			}));
		}
		const all = await (await doInst.fetch(new Request("https://channel/history?channel=stream:1"))).json() as { events: { event: string }[] };
		expect(all.events.map((e) => e.event)).toEqual(["e0", "e1", "e2"]);

		const limited = await (await doInst.fetch(new Request("https://channel/history?channel=stream:1&limit=1"))).json() as { events: { event: string }[] };
		expect(limited.events.map((e) => e.event)).toEqual(["e2"]);
	});

	it("history is durable across a fresh ChannelDO instance sharing the same storage (eviction survival)", async () => {
		const state = new FakeDOState();
		const first = new ChannelDO(state as unknown as never);
		await first.fetch(new Request("https://channel/publish?channel=stream:1", { method: "POST", body: JSON.stringify({ event: "e0" }) }));

		const second = new ChannelDO(state as unknown as never); // simulates a re-instantiation after eviction
		const res = await second.fetch(new Request("https://channel/history?channel=stream:1"));
		const body = await res.json() as { events: { event: string }[] };
		expect(body.events).toHaveLength(1);
	});
});

describe("ChannelDO — unknown intent", () => {
	it("400s an unrecognized internal path", async () => {
		const doInst = new ChannelDO(new FakeDOState() as unknown as never);
		const res = await doInst.fetch(new Request("https://channel/bogus"));
		expect(res.status).toBe(400);
	});
});

describe("ChannelDO — webSocketClose / webSocketError announce a leave", () => {
	it("closing a socket broadcasts leave + presence to the remaining subscriber", async () => {
		const state = new FakeDOState();
		const doInst = new ChannelDO(state as unknown as never);
		await doInst.fetch(connectReq("stream:1", "alice"));
		const aliceWs = serverWs;

		const bobWs = new FakeWs();
		(globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair = class {
			0 = new FakeWs();
			1 = bobWs;
		};
		await doInst.fetch(connectReq("stream:1", "bob"));

		// simulate alice's socket closing: the runtime still returns it from getWebSockets during the close
		// callback (matching the live CF hibernation semantics this glue is written against).
		doInst.webSocketClose(aliceWs as unknown as WebSocket);
		const leaveMsg = JSON.parse(bobWs.sent.find((s) => JSON.parse(s).type === "leave")!);
		expect(leaveMsg).toEqual({ type: "leave", id: "alice" });
	});

	it("never throws for an unidentified socket", () => {
		const doInst = new ChannelDO(new FakeDOState() as unknown as never);
		expect(() => doInst.webSocketError(new FakeWs() as unknown as WebSocket)).not.toThrow();
	});
});
