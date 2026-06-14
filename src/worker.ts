// wave-realtime-edge — edge entry for CF Realtime.
//   GET  /health     → 200 liveness
//   POST /rtk/join   → CF-3.1.2: RealtimeKit join (create meeting + mint participant token)
//   <other>          → 501 (WHIP/WHEP raw-SFU surfaces are a follow-up; D2 = CF Realtime SFU)
// Auth is gateway-delegated (api.wave.online enforces scope/payment); this worker never issues 401/403.
import { join, RtkError } from "./realtimekit";

interface Env {
	CF_API_TOKEN?: string; // wrangler SECRET — account API token (Calls/Realtime scope). Never logged/returned.
	CF_ACCOUNT_ID?: string; // var
	RTK_APP_ID?: string; // var — the RealtimeKit app id
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
