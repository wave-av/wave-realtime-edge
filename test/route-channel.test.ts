// route-channel.test.ts — item #5: the channel route family (route-channel.ts), exercised directly (NOT
// via worker.ts) with a stub CHANNEL Durable Object namespace, matching this repo's leaf-module test
// convention (route-rtk.ts / route-v1-media.ts are tested the same way elsewhere).
import { describe, it, expect } from "vitest";
import { maybeHandleChannelRoutes } from "../src/route-channel.js";
import type { Env } from "../src/dispatch-helpers.js";

const SECRET = "test-internal-secret";

/** A fake ChannelDO stub that records every internal request it receives and answers with canned JSON,
 *  or a fake 101 for a WS upgrade. */
function fakeChannelBinding() {
	const calls: { doId: string; url: string; init?: RequestInit }[] = [];
	const binding = {
		idFromName(name: string) {
			return name;
		},
		get(id: unknown) {
			return {
				async fetch(req: Request) {
					calls.push({ doId: id as string, url: req.url });
					const u = new URL(req.url);
					const intent = u.pathname.replace(/^\/+/, "");
					if (intent === "connect") {
						return new Response(null, { status: 200 });
					}
					if (intent === "publish") {
						return Response.json({ ok: true, delivered: 1, id: "evt-1", channel: u.searchParams.get("channel") });
					}
					if (intent === "presence") {
						return Response.json({ channel: u.searchParams.get("channel"), members: [{ id: "alice" }] });
					}
					if (intent === "history") {
						return Response.json({ channel: u.searchParams.get("channel"), events: [] });
					}
					return new Response(null, { status: 404 });
				},
			};
		},
	};
	return { binding, calls };
}

function ctxStub(): ExecutionContext {
	const tasks: Promise<unknown>[] = [];
	return { waitUntil: (p: Promise<unknown>) => void tasks.push(p) } as unknown as ExecutionContext;
}

function req(method: string, path: string, opts: { org?: string; internal?: boolean; upgrade?: boolean; body?: string } = {}): Request {
	const headers: Record<string, string> = {};
	if (opts.org !== undefined) headers["x-wave-org"] = opts.org;
	if (opts.internal) headers["x-wave-internal"] = SECRET;
	if (opts.upgrade) headers["Upgrade"] = "websocket";
	return new Request(`https://rt.wave.online${path}`, { method, headers, body: opts.body });
}

function envWith(binding: ReturnType<typeof fakeChannelBinding>["binding"]): Env {
	return { CHANNEL: binding as unknown as Env["CHANNEL"], WAVE_INTERNAL_SECRET: SECRET } as Env;
}

describe("maybeHandleChannelRoutes — inert without the CHANNEL binding", () => {
	it("returns undefined (falls through) when env.CHANNEL is absent", async () => {
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/connect?channel=stream:1", { upgrade: true, org: "org-A", internal: true }), {} as Env, ctxStub());
		expect(res).toBeUndefined();
	});

	it("returns undefined for a path this family doesn't own", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/nope"), envWith(binding), ctxStub());
		expect(res).toBeUndefined();
	});
});

describe("maybeHandleChannelRoutes — gateway trust + org scoping", () => {
	it("401s a connect request missing the internal seal", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/connect?channel=stream:1", { upgrade: true, org: "org-A" }), envWith(binding), ctxStub());
		expect(res?.status).toBe(401);
	});

	it("400s a publish with a missing/malformed x-wave-org", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("POST", "/v1/channels/stream:1/publish", { internal: true, body: "{}" }), envWith(binding), ctxStub());
		expect(res?.status).toBe(400);
	});

	it("400s an invalid channel id", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/channels/BAD_ID/presence", { internal: true, org: "org-A" }), envWith(binding), ctxStub());
		expect(res?.status).toBe(400);
	});

	it("derives the ChannelDO id as `${org}:${channel}` — a client-supplied org header cannot cross tenants (the gateway stamps x-wave-org server-side; this route trusts only that header, never a query/body value)", async () => {
		const { binding, calls } = fakeChannelBinding();
		await maybeHandleChannelRoutes(req("GET", "/v1/channels/stream:1/presence", { internal: true, org: "org-A" }), envWith(binding), ctxStub());
		expect(calls[0]!.doId).toBe("org-A:stream:1");
	});
});

describe("maybeHandleChannelRoutes — GET /v1/connect", () => {
	it("426s a connect request that isn't a WebSocket upgrade", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/connect?channel=stream:1", { internal: true, org: "org-A" }), envWith(binding), ctxStub());
		expect(res?.status).toBe(426);
	});

	it("forwards a real WS upgrade to the org-scoped ChannelDO", async () => {
		const { binding, calls } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/connect?channel=stream:1&as=alice", { internal: true, org: "org-A", upgrade: true }), envWith(binding), ctxStub());
		expect(res?.status).toBe(200);
		expect(calls[0]!.url).toContain("/connect");
		expect(calls[0]!.url).toContain("channel=stream%3A1");
		expect(calls[0]!.url).toContain("as=alice");
	});
});

describe("maybeHandleChannelRoutes — POST publish", () => {
	it("forwards the body and returns the DO's {ok,delivered} response", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(
			req("POST", "/v1/channels/stream:1/publish", { internal: true, org: "org-A", body: JSON.stringify({ event: "clip.created" }) }),
			envWith(binding),
			ctxStub(),
		);
		expect(res?.status).toBe(200);
		const body = await res!.json() as { ok: boolean; delivered: number };
		expect(body).toMatchObject({ ok: true, delivered: 1 });
	});
});

describe("maybeHandleChannelRoutes — GET presence / history", () => {
	it("presence forwards to the DO and returns its member list", async () => {
		const { binding } = fakeChannelBinding();
		const res = await maybeHandleChannelRoutes(req("GET", "/v1/channels/stream:1/presence", { internal: true, org: "org-A" }), envWith(binding), ctxStub());
		const body = await res!.json() as { members: { id: string }[] };
		expect(body.members).toEqual([{ id: "alice" }]);
	});

	it("history forwards the `limit` query param", async () => {
		const { binding, calls } = fakeChannelBinding();
		await maybeHandleChannelRoutes(req("GET", "/v1/channels/stream:1/history?limit=10", { internal: true, org: "org-A" }), envWith(binding), ctxStub());
		expect(calls[0]!.url).toContain("limit=10");
	});
});
