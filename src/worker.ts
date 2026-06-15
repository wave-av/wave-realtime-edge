// wave-realtime-edge — edge entry for CF Realtime.
//   GET  /health     → 200 liveness (public)
//   POST /rtk/join   → CF-3.1.2: RealtimeKit join (create meeting + mint participant token)
//   POST /rtk/turn   → CF-3: mint short-lived TURN/ICE credentials (raw WebRTC / WHIP-WHEP NAT traversal)
//   <other>          → 501 (raw-SFU WHIP/WHEP surfaces are a follow-up; D2 = CF Realtime SFU)
//
// PROTECTING PAID ENDPOINTS (the whole point): /rtk/join mints RealtimeKit participant tokens and /rtk/turn
// mints TURN credentials — both cost money when used. Access is EITHER (a) via the WAVE gateway —
// api.wave.online, which authenticates + CHARGES the caller over x402/MPP and then forwards with a trusted
// internal header, OR (b) nothing. When WAVE_INTERNAL_SECRET is set (every deployed env), a direct/unpaid
// call that lacks the matching `x-wave-internal` header gets 401. Unset (local/test) → no enforcement, which
// preserves the gateway-delegated contract + the existing contract tests.
import { join, turn, RtkError } from "./realtimekit";

interface Env {
	CF_API_TOKEN?: string; // wrangler SECRET — account API token (Calls/Realtime scope). Never logged/returned.
	CF_ACCOUNT_ID?: string; // var
	RTK_APP_ID?: string; // var — the RealtimeKit app id
	WAVE_INTERNAL_SECRET?: string; // wrangler SECRET — when set, ONLY the gateway (x-wave-internal) may /rtk/*
	TURN_KEY_ID?: string; // wrangler SECRET — the CF TURN key uid (32-hex). Out of the public repo; persists across deploys.
	TURN_KEY_TOKEN?: string; // wrangler SECRET — the TURN key's api token. Never logged/returned; only ephemeral ICE creds are.
}

/** Constant-time string compare (length check, then XOR-accumulate — no early return on content). */
function timingSafeEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	if (ea.length !== eb.length) return false;
	let diff = 0;
	for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
	return diff === 0;
}

/**
 * Gate a paid/token-minting endpoint: when WAVE_INTERNAL_SECRET is set (every deployed env), the request
 * MUST carry the matching `x-wave-internal` header (the gateway injects it AFTER charging) — else 401.
 * Unset (local/test) → null (no enforcement), preserving the gateway-delegated contract. Returns the 401
 * Response to short-circuit, or null to proceed. Shared by /rtk/join and /rtk/turn (one chokepoint).
 */
function gatewayGate(request: Request, secret: string | undefined): Response | null {
	if (secret && !timingSafeEqual(request.headers.get("x-wave-internal") ?? "", secret)) {
		return Response.json(
			{ error: "UNAUTHORIZED", message: "paid endpoint — call via api.wave.online" },
			{ status: 401 },
		);
	}
	return null;
}

export default {
	async fetch(request: Request, env: Env = {} as Env, _ctx?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				service: "wave-realtime-edge",
				layer: "edge",
				protocol: "webrtc-sfu",
				version: "dev",
			});
		}

		if (request.method === "POST" && url.pathname === "/rtk/join") {
			const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
			if (denied) return denied;

			let body: Record<string, unknown> = {};
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				body = {}; // invalid/empty JSON → validated as missing `name` below
			}
			try {
				const result = await join(
					{ accountId: env.CF_ACCOUNT_ID ?? "", appId: env.RTK_APP_ID ?? "", token: env.CF_API_TOKEN ?? "" },
					{
						title: typeof body.title === "string" ? body.title : undefined,
						name: typeof body.name === "string" ? body.name : "",
						presetName: typeof body.preset_name === "string" ? body.preset_name : undefined,
						customParticipantId:
							typeof body.custom_participant_id === "string" ? body.custom_participant_id : undefined,
					},
				);
				return Response.json(result, { status: 200 });
			} catch (e) {
				const err = e instanceof RtkError ? e : new RtkError("REALTIME_ERROR", "unexpected error", 500);
				return Response.json({ error: err.code, message: err.message }, { status: err.status });
			}
		}

		if (request.method === "POST" && url.pathname === "/rtk/turn") {
			const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
			if (denied) return denied;

			let body: Record<string, unknown> = {};
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				body = {}; // invalid/empty JSON → ttl defaults (clampTurnTtl handles undefined)
			}
			try {
				const result = await turn(
					{ keyId: env.TURN_KEY_ID ?? "", token: env.TURN_KEY_TOKEN ?? "" },
					body.ttl, // clamped to a bounded integer inside turn()
				);
				return Response.json(result, { status: 200 });
			} catch (e) {
				const err = e instanceof RtkError ? e : new RtkError("REALTIME_ERROR", "unexpected error", 500);
				return Response.json({ error: err.code, message: err.message }, { status: err.status });
			}
		}

		return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
	},
};
