// P5.2 wiring — worker entry → CF-Calls SFU control plane.
//
// Verifies the worker ROUTES realtime intents (POST /v1/realtime/rooms/:room/{join,publish,subscribe,
// renegotiate,leave}) through the Room DO, keyed per-org (idFromName on `${org}:${room}`), behind the SAME
// gateway-trust chokepoint /rtk/* uses (WAVE_INTERNAL_SECRET / x-wave-internal), with org taken from the
// gateway-stamped x-wave-org header. No live DO runtime: env.ROOM is a stub namespace whose stub returns a
// recorded fetch so we can assert the worker looked up the right DO id and forwarded the intent.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// A stub DO namespace: records idFromName(name) and forwards stub.fetch() to a recorder.
function stubRoomNamespace(handler?: (req: Request) => Response | Promise<Response>) {
	const seen: { name?: string; intentUrl?: string } = {};
	return {
		seen,
		idFromName(name: string) {
			seen.name = name;
			return { __name: name, toString: () => name };
		},
		get(_id: unknown) {
			return {
				fetch: async (req: Request) => {
					seen.intentUrl = new URL(req.url).pathname.replace(/^\//, "");
					if (handler) return handler(req);
					return Response.json({ ok: true }, { status: 200 });
				},
			};
		},
	};
}

function env(over: Record<string, unknown> = {}) {
	return { ROOM: stubRoomNamespace(), ...over } as never;
}

function rt(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Request {
	return new Request(`https://rt.wave.online${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const BODY = { participantId: "p1", role: "host" };

describe("SFU routes — gateway-trust auth chokepoint (same as /rtk/*)", () => {
	it("guard ON + missing x-wave-internal → 401", async () => {
		const res = await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, BODY),
			env({ WAVE_INTERNAL_SECRET: "s3cret" }),
			ctx,
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("UNAUTHORIZED");
	});

	it("guard ON + correct x-wave-internal → forwarded to the DO (not 401)", async () => {
		const ns = stubRoomNamespace();
		const res = await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-internal": "s3cret", "x-wave-org": "org-A" }, BODY),
			env({ WAVE_INTERNAL_SECRET: "s3cret", ROOM: ns }),
			ctx,
		);
		expect(res.status).not.toBe(401);
		expect(res.status).toBe(200);
	});

	it("guard OFF (no secret) → no 401 (gateway-delegated contract preserved)", async () => {
		const res = await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, BODY),
			env(),
			ctx,
		);
		expect(res.status).not.toBe(401);
	});
});

describe("SFU routes — org is required (gateway-stamped), per-org DO isolation", () => {
	it("missing x-wave-org → 400", async () => {
		const res = await worker.fetch(rt("POST", "/v1/realtime/rooms/room-1/join", {}, BODY), env(), ctx);
		expect(res.status).toBe(400);
	});

	it("DO id is keyed on `${org}:${room}` (per-org isolation)", async () => {
		const ns = stubRoomNamespace();
		await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, BODY),
			env({ ROOM: ns }),
			ctx,
		);
		expect(ns.seen.name).toBe("org-A:room-1");
	});

	it("same room name, different org → different DO id", async () => {
		const a = stubRoomNamespace();
		const b = stubRoomNamespace();
		await worker.fetch(rt("POST", "/v1/realtime/rooms/r/join", { "x-wave-org": "org-A" }, BODY), env({ ROOM: a }), ctx);
		await worker.fetch(rt("POST", "/v1/realtime/rooms/r/join", { "x-wave-org": "org-B" }, BODY), env({ ROOM: b }), ctx);
		expect(a.seen.name).toBe("org-A:r");
		expect(b.seen.name).toBe("org-B:r");
		expect(a.seen.name).not.toBe(b.seen.name);
	});
});

describe("SFU routes — action mapping", () => {
	for (const action of ["join", "publish", "subscribe", "renegotiate", "leave"]) {
		it(`POST .../${action} forwards intent "${action}" to the DO`, async () => {
			const ns = stubRoomNamespace();
			const res = await worker.fetch(
				rt("POST", `/v1/realtime/rooms/room-1/${action}`, { "x-wave-org": "org-A" }, BODY),
				env({ ROOM: ns }),
				ctx,
			);
			expect(res.status).toBe(200);
			expect(ns.seen.intentUrl).toBe(action);
		});
	}

	it("unknown realtime sub-path → 501 (unchanged fall-through)", async () => {
		const res = await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/teleport", { "x-wave-org": "org-A" }, BODY),
			env(),
			ctx,
		);
		expect(res.status).toBe(501);
	});

	it("the DO error status/body is propagated verbatim", async () => {
		const ns = stubRoomNamespace(() => Response.json({ error: "ROOM_ORG_MISMATCH", message: "no" }, { status: 403 }));
		const res = await worker.fetch(
			rt("POST", "/v1/realtime/rooms/room-1/join", { "x-wave-org": "org-A" }, BODY),
			env({ ROOM: ns }),
			ctx,
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("ROOM_ORG_MISMATCH");
	});
});

describe("existing surface unchanged", () => {
	it("/health still 200", async () => {
		const res = await worker.fetch(rt("GET", "/health"), env(), ctx);
		expect(res.status).toBe(200);
	});
	it("unknown path still 501", async () => {
		const res = await worker.fetch(rt("GET", "/nope"), env(), ctx);
		expect(res.status).toBe(501);
	});
});
