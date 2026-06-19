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

// Re-export the Room Durable Object so the wrangler `ROOM` binding + migration (v1, new_sqlite_classes)
// resolve from this main module. The class itself is defined in room.ts (P5 substrate); it is not yet
// wired into fetch() — that is the P5.2 signaling follow-up. Exporting it here lets the binding deploy.
export { RoomDO } from "./room";

/** Minimal Durable Object namespace shape (avoids a hard dependency on cloudflare:workers types). */
interface RoomNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface Env {
	CF_API_TOKEN?: string; // wrangler SECRET — account API token (Calls/Realtime scope). Never logged/returned.
	CF_ACCOUNT_ID?: string; // var
	RTK_APP_ID?: string; // var — the RealtimeKit app id
	WAVE_INTERNAL_SECRET?: string; // wrangler SECRET — when set, ONLY the gateway (x-wave-internal) may /rtk/* AND /v1/realtime/*
	TURN_KEY_ID?: string; // wrangler SECRET — the CF TURN key uid (32-hex). Out of the public repo; persists across deploys.
	TURN_KEY_TOKEN?: string; // wrangler SECRET — the TURN key's api token. Never logged/returned; only ephemeral ICE creds are.
	// ── P5 CF-Calls SFU control plane ──
	ROOM?: RoomNamespace; // Durable Object binding (wrangler ROOM → RoomDO). Per-room state + signaling.
	// CF_CALLS_APP_ID / CF_CALLS_APP_SECRET / GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN are read INSIDE the
	// RoomDO (see RoomDOEnv in room.ts) — the worker forwards the env to the DO via the binding, so it does
	// not need to name them here.
}

/** CF-Calls SFU realtime intents the worker forwards to the Room DO (last path segment). */
const REALTIME_INTENTS = new Set(["join", "publish", "subscribe", "renegotiate", "leave"]);
/** POST /v1/realtime/rooms/:room/:intent */
const REALTIME_ROUTE = /^\/v1\/realtime\/rooms\/([^/]+)\/([^/]+)\/?$/;

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

		// ── P5 CF-Calls SFU control plane — POST /v1/realtime/rooms/:room/:intent ──
		// Routed through the Room DO (per-org isolation: the DO id is keyed `${org}:${room}`), which runs the
		// Signaling orchestration (room.ts RoomDO.fetch). Same gateway-trust chokepoint as /rtk/*: when
		// WAVE_INTERNAL_SECRET is set, only the gateway (x-wave-internal) may reach these paid endpoints. Org
		// comes from the gateway-stamped `x-wave-org` header (the gateway authenticates + scopes upstream).
		const rtMatch = request.method === "POST" ? url.pathname.match(REALTIME_ROUTE) : null;
		if (rtMatch && REALTIME_INTENTS.has(rtMatch[2])) {
			const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
			if (denied) return denied;

			const org = request.headers.get("x-wave-org") ?? "";
			if (!org) {
				return Response.json(
					{ error: "BAD_REQUEST", message: "missing org context (x-wave-org) — stamped by the gateway" },
					{ status: 400 },
				);
			}
			if (!env.ROOM) {
				// config-no-silent-noop: a missing DO binding must be loud, not a silent 501.
				return Response.json(
					{ error: "REALTIME_NOT_CONFIGURED", message: "ROOM durable object binding is not configured" },
					{ status: 503 },
				);
			}

			const room = decodeURIComponent(rtMatch[1]);
			const intent = rtMatch[2];

			let payload: Record<string, unknown> = {};
			try {
				payload = (await request.json()) as Record<string, unknown>;
			} catch {
				payload = {}; // empty/invalid JSON → validated inside the DO/signaling layer
			}
			const participantId = typeof payload.participantId === "string" ? payload.participantId : "";
			// Role is gateway-stamped via x-wave-role (set by the gateway after WRT verification).
			// Room type comes from x-wave-room-type header or the join body; both are optional.
			const role = request.headers.get("x-wave-role") ?? undefined;
			const type = request.headers.get("x-wave-room-type") ??
				(typeof payload.type === "string" ? payload.type : undefined);
			// Forward to the room's DO with the already-authenticated context bound in. Per-org isolation is
			// enforced by the DO id (org:room) AND re-checked inside the Room DO (org-mismatch → 403/409).
			const id = env.ROOM.idFromName(`${org}:${room}`);
			const stub = env.ROOM.get(id);
			const intentReq = new Request(`https://room/${intent}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...payload, ctx: { org, room, participantId, role, type } }),
			});
			return stub.fetch(intentReq);
		}

		return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
	},
};
