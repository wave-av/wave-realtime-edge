// wave-realtime-edge — edge entry for CF Realtime.
//   GET  /health     → 200 liveness (public)
//   POST /rtk/join   → CF-3.1.2: RealtimeKit join (create meeting + mint participant token)
//   <other>          → 501 (WHIP/WHEP raw-SFU surfaces are a follow-up; D2 = CF Realtime SFU)
//
// PROTECTING A PAID ENDPOINT (the whole point): /rtk/join mints RealtimeKit participant tokens,
// which cost money when used. Access is EITHER (a) via the WAVE gateway — api.wave.online, which
// authenticates + CHARGES the caller over x402/MPP and then forwards with a trusted internal header,
// OR (b) nothing. When WAVE_INTERNAL_SECRET is set (every deployed env), a direct/unpaid call that
// lacks the matching `x-wave-internal` header gets 401. Unset (local/test) → no enforcement, which
// preserves the gateway-delegated contract + the existing contract tests.
import { join, RtkError } from "./realtimekit";

interface Env {
	CF_API_TOKEN?: string; // wrangler SECRET — account API token (Calls/Realtime scope). Never logged/returned.
	CF_ACCOUNT_ID?: string; // var
	RTK_APP_ID?: string; // var — the RealtimeKit app id
	WAVE_INTERNAL_SECRET?: string; // wrangler SECRET — when set, ONLY the gateway (x-wave-internal) may /rtk/join
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
			// Gate the paid/token-minting endpoint: deployed → must come from the gateway (already charged).
			const secret = env.WAVE_INTERNAL_SECRET;
			if (secret && !timingSafeEqual(request.headers.get("x-wave-internal") ?? "", secret)) {
				return Response.json(
					{ error: "UNAUTHORIZED", message: "join is paid — call via api.wave.online" },
					{ status: 401 },
				);
			}

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

		return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
	},
};
