// LK-rip #42 — WAVE-native ingress listeners on the worker entry.
//
// POST /v1/realtime/ingress/:protocol/:intent is the server-side counterpart to wave-gateway PR #204  # guard:allow cross-repo PR reference in a design comment, not a leak
// (identity-path forward) and wave-surfer-connect PR #4982's WaveIngressProviderService. The protocol +  # guard:allow cross-repo PR reference in a design comment, not a leak
// intent allowlist MUST line up with #204 for the eventual #74 cutover proof. Feasibility, by design:
//   • WHIP  → LIVE: WebRTC-over-HTTP, forwarded to the Room DO `join` intent (offer → SFU answer).
//   • rtmp/srt/url → honest 501 {"error":"ingress_protocol_requires_vm_listener"} (need a VM listener).
//
// The ROOM binding is mocked: the worker's job is the ROUTING + gateway-trust + org/role wiring; the DO
// internals are covered by room.fetch.test.ts. WAVE_INTERNAL_SECRET is left unset (local/test) so the
// gatewayGate is inert, exactly like the existing rooms tests.
import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker.js";

/** Mock ROOM Durable Object namespace — captures the forwarded request so we can assert the wiring. */
function mockRoom() {
	const captured: { url?: string; body?: unknown } = {};
	const ns = {
		idFromName: (name: string) => ({ name }),
		get: (_id: unknown) => ({
			fetch: async (req: Request) => {
				captured.url = req.url;
				captured.body = await req.clone().json();
				return new Response(JSON.stringify({ sessionId: "sess-1", sessionDescription: { type: "answer", sdp: "v=0..." } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		}),
	};
	return { ns, captured };
}

function ingReq(protocol: string, intent: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
	return new Request(`https://rt.wave.online/v1/realtime/ingress/${protocol}/${intent}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-wave-org": "org_test", ...headers },
		body: JSON.stringify(body),
	});
}

describe("WAVE ingress listeners (LK-rip #42)", () => {
	it("WHIP create forwards an SDP offer to the Room DO join intent and returns the SFU answer", async () => {
		const { ns, captured } = mockRoom();
		const res = await worker.fetch(
			ingReq("whip", "create", { room: "show-2026", offer: { type: "offer", sdp: "v=0..." } }),
			{ ROOM: ns } as never,
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.sessionId).toBe("sess-1");
		// forwarded to the room's /join with the gateway-stamped org bound into ctx
		expect(captured.url).toBe("https://room/join");
		const fwd = captured.body as { ctx: { org: string; room: string; role: string } };
		expect(fwd.ctx.org).toBe("org_test");
		expect(fwd.ctx.room).toBe("show-2026");
		expect(fwd.ctx.role).toBe("speaker"); // ingress source default
	});

	it("WHIP create accepts streamKey as the room id", async () => {
		const { ns, captured } = mockRoom();
		const res = await worker.fetch(ingReq("whip", "create", { streamKey: "sk-live-1" }), { ROOM: ns } as never);
		expect(res.status).toBe(200);
		expect((captured.body as { ctx: { room: string } }).ctx.room).toBe("sk-live-1");
	});

	it("WHIP create without a room/streamKey is a 400", async () => {
		const { ns } = mockRoom();
		const res = await worker.fetch(ingReq("whip", "create", { offer: {} }), { ROOM: ns } as never);
		expect(res.status).toBe(400);
	});

	it("WHIP delete is acknowledged idempotently without touching the room", async () => {
		const { ns, captured } = mockRoom();
		const res = await worker.fetch(ingReq("whip", "delete", { room: "show-2026" }), { ROOM: ns } as never);
		expect(res.status).toBe(200);
		expect((await res.json() as Record<string, unknown>).ok).toBe(true);
		expect(captured.url).toBeUndefined(); // never forwarded to the DO
	});

	it.each(["rtmp", "srt", "url"])("%s create returns honest 501 with the VM-listener marker", async (protocol) => {
		const { ns } = mockRoom();
		const res = await worker.fetch(ingReq(protocol, "create", { room: "r" }), { ROOM: ns } as never);
		expect(res.status).toBe(501);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.error).toBe("ingress_protocol_requires_vm_listener");
		expect(json.protocol).toBe(protocol);
	});

	it("WHEP (egress, not ingress) and unknown protocols are rejected 404", async () => {
		const { ns } = mockRoom();
		const whep = await worker.fetch(ingReq("whep", "create", {}), { ROOM: ns } as never);
		expect(whep.status).toBe(404);
		const bogus = await worker.fetch(ingReq("dante", "create", {}), { ROOM: ns } as never);
		expect(bogus.status).toBe(404);
	});

	it("an unknown intent is rejected 404", async () => {
		const { ns } = mockRoom();
		const res = await worker.fetch(ingReq("whip", "destroy", {}), { ROOM: ns } as never);
		expect(res.status).toBe(404);
	});

	it("GET on an ingress path is not a write route (falls through to 501 NOT_IMPLEMENTED)", async () => {
		const res = await worker.fetch(
			new Request("https://rt.wave.online/v1/realtime/ingress/whip/create", { method: "GET" }),
			{} as never,
		);
		expect(res.status).toBe(501);
		expect((await res.json() as Record<string, unknown>).error).toBe("REALTIME_NOT_IMPLEMENTED");
	});

	it("missing x-wave-org is a 400 for a WHIP create", async () => {
		const { ns } = mockRoom();
		const req = new Request("https://rt.wave.online/v1/realtime/ingress/whip/create", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ room: "r" }),
		});
		const res = await worker.fetch(req, { ROOM: ns } as never);
		expect(res.status).toBe(400);
	});

	it("WAVE_INTERNAL_SECRET set + wrong x-wave-internal → 401 (gateway-trust chokepoint)", async () => {
		const { ns } = mockRoom();
		const res = await worker.fetch(ingReq("whip", "create", { room: "r" }), { ROOM: ns, WAVE_INTERNAL_SECRET: "s3cr3t" } as never);
		expect(res.status).toBe(401);
	});
});
