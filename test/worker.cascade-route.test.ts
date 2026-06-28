// #82/#114 — cascade relay wiring on the realtime room JOIN path. Proves: FULLY INERT without RT_CASCADE (a
// join routes to the PRIMARY DO `org:room` with NO locationHint, byte-identical to today); with RT_CASCADE on,
// a regional join (request.cf.continent set) is placed on the nearest region's RELAY DO — a strict-suffix
// `org:room:region` key — via get(id,{locationHint}); an unknown/absent continent falls back to the primary
// (never an invented region); non-join intents always keep the primary path. Stub ROOM namespace capturing
// idFromName(name) + the get() options; no live DO/SFU runtime.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const ORG = "org-1";
const SECRET = "s";

function stubRoomNs() {
	const seen: { name?: string; getOpts?: { locationHint?: string } } = {};
	return {
		seen,
		idFromName(name: string) { seen.name = name; return { __name: name }; },
		get(_id: unknown, options?: { locationHint?: string }) {
			seen.getOpts = options;
			return { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) };
		},
	};
}

// Build a /v1/realtime/rooms/:room/:intent request with an internal-secret seal + optional cf.continent.
function joinReq(room: string, intent = "join", continent?: string): Request {
	const r = new Request(`https://rt/v1/realtime/rooms/${room}/${intent}`, {
		method: "POST",
		headers: { "x-wave-org": ORG, "x-wave-internal": SECRET, "content-type": "application/json" },
		body: JSON.stringify({ participantId: "p1" }),
	});
	if (continent) (r as Request & { cf?: { continent?: string } }).cf = { continent };
	return r;
}

describe("cascade INERT without RT_CASCADE", () => {
	it("a join with a continent still routes to the PRIMARY org:room DO, no locationHint", async () => {
		const ns = stubRoomNs();
		const res = await worker.fetch(joinReq("stage", "join", "EU"), { WAVE_INTERNAL_SECRET: SECRET, ROOM: ns } as never, ctx);
		expect(res.status).toBe(200);
		expect(ns.seen.name).toBe(`${ORG}:stage`); // primary key — no :region suffix
		expect(ns.seen.getOpts).toBeUndefined(); // no locationHint passed (byte-identical to today)
	});
});

describe("cascade ON (RT_CASCADE=1)", () => {
	const base = { WAVE_INTERNAL_SECRET: SECRET, RT_CASCADE: "1" };

	it("places a regional join on the nearest region's RELAY DO (strict suffix) with a locationHint", async () => {
		const ns = stubRoomNs();
		const res = await worker.fetch(joinReq("stage", "join", "EU"), { ...base, ROOM: ns } as never, ctx);
		expect(res.status).toBe(200);
		// EU → nearest region weur; relay key is the primary key + :weur (strict suffix).
		expect(ns.seen.name).toBe(`${ORG}:stage:weur`);
		expect(ns.seen.name!.startsWith(`${ORG}:stage:`)).toBe(true);
		expect(ns.seen.getOpts).toEqual({ locationHint: "weur" });
	});

	it("NA folds to enam", async () => {
		const ns = stubRoomNs();
		await worker.fetch(joinReq("stage", "join", "NA"), { ...base, ROOM: ns } as never, ctx);
		expect(ns.seen.name).toBe(`${ORG}:stage:enam`);
		expect(ns.seen.getOpts).toEqual({ locationHint: "enam" });
	});

	it("falls back to the PRIMARY DO when the continent is absent (never invents a region)", async () => {
		const ns = stubRoomNs();
		await worker.fetch(joinReq("stage", "join"), { ...base, ROOM: ns } as never, ctx); // no cf.continent
		expect(ns.seen.name).toBe(`${ORG}:stage`);
		expect(ns.seen.getOpts).toBeUndefined();
	});

	it("falls back to the PRIMARY DO for an unknown continent", async () => {
		const ns = stubRoomNs();
		await worker.fetch(joinReq("stage", "join", "XX"), { ...base, ROOM: ns } as never, ctx);
		expect(ns.seen.name).toBe(`${ORG}:stage`);
		expect(ns.seen.getOpts).toBeUndefined();
	});

	it("non-join intents keep the PRIMARY path even with a continent", async () => {
		const ns = stubRoomNs();
		await worker.fetch(joinReq("stage", "publish", "EU"), { ...base, ROOM: ns } as never, ctx);
		expect(ns.seen.name).toBe(`${ORG}:stage`);
		expect(ns.seen.getOpts).toBeUndefined();
	});
});
