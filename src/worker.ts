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
import type { EncoderEnv } from "./encoders/encoder";
import { selectEncoder } from "./encoders/factory";
import { pullRecordingConfigured, DefaultManagedRecordingApi } from "./encoders/managed";
import {
	handleRecordingWebhook,
	liveWebhookDeps,
	reconcilePending,
	PENDING_PREFIX,
	PENDING_TTL_SECONDS,
	type RecordingPullSink,
} from "./rtk-webhook";

// Re-export the Room Durable Object so the wrangler `ROOM` binding + migration (v1, new_sqlite_classes)
// resolve from this main module. The class itself is defined in room.ts (P5 substrate); it is not yet
// wired into fetch() — that is the P5.2 signaling follow-up. Exporting it here lets the binding deploy.
export { RoomDO } from "./room";

/** Minimal Durable Object namespace shape (avoids a hard dependency on cloudflare:workers types). */
interface RoomNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
}

// Env extends EncoderEnv so the recording adapter's config (CF_ACCOUNT_ID/CF_API_TOKEN/RTK_APP_ID +
// RT_RECORD/RT_ENCODER/RT_RECORDINGS + the pull-mode RT_MEETING_ORG meetingId→org KV) flows straight from the
// worker env into selectEncoder()/pullRecordingConfigured()/the webhook pull sink with no re-mapping.
interface Env extends EncoderEnv {
	WAVE_INTERNAL_SECRET?: string; // wrangler SECRET — when set, ONLY the gateway (x-wave-internal) may /rtk/* AND /v1/realtime/*
	TURN_KEY_ID?: string; // wrangler SECRET — the CF TURN key uid (32-hex). Out of the public repo; persists across deploys.
	TURN_KEY_TOKEN?: string; // wrangler SECRET — the TURN key's api token. Never logged/returned; only ephemeral ICE creds are.
	// ── P5 CF-Calls SFU control plane ──
	ROOM?: RoomNamespace; // Durable Object binding (wrangler ROOM → RoomDO). Per-room state + signaling.
	// GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN are read INSIDE the RoomDO (see RoomDOEnv in room.ts) — the worker
	// forwards the env to the DO via the binding, so it does not need to name them here.
}

// Module-scoped so CF's webhook public key (fetched from the well-known doc) is cached for the isolate's
// lifetime instead of re-fetched per webhook. Verification deps are injectable in unit tests via the handler.
const recordingWebhookDeps = liveWebhookDeps();

/** CF-Calls SFU realtime intents the worker forwards to the Room DO (last path segment). */
const REALTIME_INTENTS = new Set(["join", "publish", "subscribe", "renegotiate", "leave"]);
/** POST /v1/realtime/rooms/:room/:intent */
const REALTIME_ROUTE = /^\/v1\/realtime\/rooms\/([^/]+)\/([^/]+)\/?$/;

// ── WAVE-native ingress listeners (LK-rip #42) — POST /v1/realtime/ingress/:protocol/:intent ──
// Server-side counterpart to wave-gateway PR #204 (which forwards this exact path shape as the identity
// edge path) and wave-surfer-connect PR #4982's WaveIngressProviderService contract. The protocol + intent
// allowlist MUST match #204 (rtmp/whip/srt/url + create/delete; plus protocol-less management). The
// gateway already validates the shape; we re-validate here (defense in depth, never trust transport).
//
// FEASIBILITY (correctness-by-design, no fabrication): a Cloudflare Worker cannot accept raw inbound TCP
// (RTMP) or UDP (SRT) sockets, and has no media pipeline to decode an arbitrary pulled URL into SFU tracks.
//   • WHIP  → LIVE: WHIP is WebRTC-over-HTTP (POST an SDP offer, return an SDP answer) — exactly the SFU
//     newSession(offer)→answer the room/join path already performs. We forward WHIP create to the Room DO
//     `join` intent (reusing org:room isolation + admission), returning the SFU answer as the WHIP 201 body.
//   • rtmp / srt / url → honest 501 (ingress_protocol_requires_vm_listener): these REQUIRE an out-of-Worker
//     VM listener (raw socket / media decode) that bridges into the room — a separate follow-up slice. We do
//     NOT fake a Worker listener for them.
const INGRESS_ROUTE = /^\/v1\/realtime\/ingress\/([a-z]+)\/([a-z]+)\/?$/;
/** Worker-feasible ingress protocols served LIVE here. WHIP only (WebRTC-over-HTTP). */
const INGRESS_LIVE_PROTOCOLS = new Set(["whip"]);
/** Protocols that need an out-of-Worker VM listener → honest 501 with a machine-readable marker. */
const INGRESS_VM_PROTOCOLS = new Set(["rtmp", "srt", "url"]);
/** Per-protocol intents (must match gateway #204's INGRESS_PROTOCOL_INTENTS). */
const INGRESS_PROTOCOL_INTENTS = new Set(["create", "delete"]);
/** Whitelists for the UNTRUSTED gateway-stamped role/type values (reject anything off-list). */
const ROLES = new Set(["host", "speaker", "viewer"]);
const ROOM_TYPE_VALUES = new Set(["meeting", "webinar", "event", "breakout"]);

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

/**
 * Build the PULL-mode sink the recording webhook uses to fetch a finished recording into our R2. Null when the
 * SKIP sink bucket (RT_RECORDINGS) or the meetingId→org map (RT_MEETING_ORG) is absent → the webhook degrades
 * to observe-only (still acks the signed event), never a silent broken write. The RTK REST primitives
 * (download-url resolve + fetch) come from the same DefaultManagedRecordingApi the join path starts with.
 */
function buildPullSink(env: Env): RecordingPullSink | null {
	if (!env.RT_RECORDINGS || !env.RT_MEETING_ORG) return null;
	const api = new DefaultManagedRecordingApi(env);
	const kv = env.RT_MEETING_ORG;
	const bucket = env.RT_RECORDINGS;
	return {
		lookupOrg: (meetingId) => kv.get(meetingId),
		resolveDownloadUrl: (recordingId) => api.getDownloadUrl(recordingId),
		fetchRecording: (url) => api.fetchRecording(url),
		bucket,
		markPending: async (recordingId, meetingId) => {
			// Durable retry seed: store only the stable ids (the event's download_url is perishable; the cron
			// re-resolves it). The scheduled() reconcile re-pulls + clears this. TTL bounds the recovery window.
			await kv.put(`${PENDING_PREFIX}${recordingId}`, JSON.stringify({ meetingId, attempts: 0 }), {
				expirationTtl: PENDING_TTL_SECONDS,
			});
		},
	};
}

/** A WAVE org id is the FIRST path segment of every recording R2 key (the daily sweep bills by it), so it must
 * be a safe single path segment. The gateway stamps x-wave-org, but we still validate before minting a key/
 * billing prefix: alphanumerics + `_ : -` only (uuid-ish / pool-ish), no `/`, dot, or whitespace, ≤128 chars. */
const SAFE_ORG = /^[A-Za-z0-9_:-]{1,128}$/;

export default {
	async fetch(request: Request, env: Env = {} as Env, ctx?: ExecutionContext): Promise<Response> {
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

		// RealtimeKit recording.statusUpdate webhook (RT-R-WH). PUBLIC by design — RTK calls it directly, so it
		// is intentionally NOT behind gatewayGate; it authenticates itself via the `rtk-signature` header
		// (RSA-SHA256 over the raw body, verified against CF's published key) before acting on anything.
		if (request.method === "POST" && url.pathname === "/rtk/recording-webhook") {
			// PULL mode: when the SKIP sink + meetingId→org map are bound, an UPLOADED event pulls the finished
			// recording into our R2 (backgrounded via ctx.waitUntil so a large transfer can't hold the request past
			// RTK's webhook timeout). Absent bindings → observe-only deps (the event is still acked).
			const sink = buildPullSink(env);
			const webhookDeps =
				sink && ctx
					? { ...recordingWebhookDeps, sink, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p) }
					: sink
						? { ...recordingWebhookDeps, sink }
						: recordingWebhookDeps;
			return handleRecordingWebhook(request, webhookDeps);
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
				// Best-effort: arm managed recording for this meeting. PULL mode (RTK records to its own storage;
				// the recording.statusUpdate UPLOADED webhook pulls the finished file into our R2 at an org-rooted
				// path). On this stateless path we (1) persist meetingId→org so the later webhook can attribute the
				// pull, then (2) start the RTK recording. Never on the response critical path (waitUntil), never
				// throws the join. Opt out per call with {"record": false}.
				if (ctx && body.record !== false && pullRecordingConfigured(env)) {
					const org = request.headers.get("x-wave-org") ?? "";
					if (SAFE_ORG.test(org)) {
						const session = { org, room: "", sessionId: result.meetingId };
						ctx.waitUntil(
							(async () => {
								// Persist meetingId→org FIRST so the recording webhook can attribute the pull to this org. A
								// 14-day TTL comfortably outlives any meeting + RTK's upload/webhook latency.
								await env.RT_MEETING_ORG?.put(result.meetingId, org, { expirationTtl: 60 * 60 * 24 * 14 });
								const h = await selectEncoder(env).begin(session);
								if (h) console.log(JSON.stringify({ msg: "rt-recording-armed", meetingId: result.meetingId, org }));
							})().catch(() => {}),
						);
					} else {
						// No (or malformed) gateway-stamped org → we do NOT start or attribute a recording on this path
						// (no KV put, no begin()). Loud, not silent (config-no-silent-noop). We are not "dropping" a
						// recording: nothing was started here. (A malformed org would otherwise mint a bad billing prefix.)
						const reason = org ? "rt-recording-skipped-bad-org" : "rt-recording-skipped-no-org";
						console.warn(JSON.stringify({ msg: reason, meetingId: result.meetingId }));
					}
				}
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
			// Role is gateway-stamped via x-wave-role (set by the gateway after WRT verification) and room
			// type via x-wave-room-type header or the join body. Both are UNTRUSTED transport values:
			// whitelist them before forwarding so a junk header can't corrupt permissions/policy.
			const role = ROLES.has(request.headers.get("x-wave-role") ?? "")
				? (request.headers.get("x-wave-role") as string)
				: undefined;
			const rawType = request.headers.get("x-wave-room-type") ??
				(typeof payload.type === "string" ? payload.type : undefined);
			const type = rawType !== undefined && ROOM_TYPE_VALUES.has(rawType) ? rawType : undefined;
			// Anonymity marker stamped by the gateway from the WRT/auth context. Absent → identified.
			const anon = (request.headers.get("x-wave-anon") ?? "") !== "";
			// Forward to the room's DO with the already-authenticated context bound in. Per-org isolation is
			// enforced by the DO id (org:room) AND re-checked inside the Room DO (org-mismatch → 403/409).
			const id = env.ROOM.idFromName(`${org}:${room}`);
			const stub = env.ROOM.get(id);
			const intentReq = new Request(`https://room/${intent}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...payload, ctx: { org, room, participantId, role, type, anon } }),
			});
			return stub.fetch(intentReq);
		}

		// ── WAVE-native ingress listeners — POST /v1/realtime/ingress/:protocol/:intent (LK-rip #42) ──
		// Same gateway-trust chokepoint + org/room/DO wiring as the rooms block above. WHIP is LIVE
		// (WebRTC-over-HTTP → SFU); rtmp/srt/url are honest 501 (need an out-of-Worker VM listener).
		const ingMatch = request.method === "POST" ? url.pathname.match(INGRESS_ROUTE) : null;
		if (ingMatch) {
			const protocol = ingMatch[1];
			const intent = ingMatch[2];
			// Defense in depth: reject anything off the allowlist (the gateway already validated, but never trust transport).
			if (!INGRESS_PROTOCOL_INTENTS.has(intent)) {
				return Response.json({ error: "INGRESS_BAD_INTENT", message: `unknown ingress intent: ${intent}` }, { status: 404 });
			}
			if (!INGRESS_LIVE_PROTOCOLS.has(protocol) && !INGRESS_VM_PROTOCOLS.has(protocol)) {
				// e.g. whep (egress, not ingress) or any unknown protocol.
				return Response.json({ error: "INGRESS_UNSUPPORTED_PROTOCOL", protocol }, { status: 404 });
			}

			const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
			if (denied) return denied;

			const org = request.headers.get("x-wave-org") ?? "";
			if (!org) {
				return Response.json(
					{ error: "BAD_REQUEST", message: "missing org context (x-wave-org) — stamped by the gateway" },
					{ status: 400 },
				);
			}

			// rtmp/srt/url: a raw TCP/UDP listener or media-decode pipeline cannot run on a Worker. Honest 501
			// with a machine-readable marker so the gateway/WSC can branch — NOT a fabricated Worker listener.
			if (INGRESS_VM_PROTOCOLS.has(protocol)) {
				return Response.json(
					{ error: "ingress_protocol_requires_vm_listener", protocol, intent },
					{ status: 501 },
				);
			}

			// WHIP (LIVE). delete has no SFU teardown primitive of its own yet (sessions GC on idle / leave),
			// so a WHIP delete is acknowledged idempotently without touching the room.
			if (intent === "delete") {
				return Response.json({ ok: true, protocol, intent }, { status: 200 });
			}
			if (!env.ROOM) {
				// config-no-silent-noop: a missing DO binding must be loud, not a silent 501.
				return Response.json(
					{ error: "REALTIME_NOT_CONFIGURED", message: "ROOM durable object binding is not configured" },
					{ status: 503 },
				);
			}

			// WHIP create: the body is the WebRTC SDP offer (+ a room/stream id + participant). We forward to the
			// Room DO `join` intent — which mints the SFU session from the offer and returns the SFU answer — and
			// surface that as the WHIP 201 (the publisher is now in the room, exactly like a browser join). Room
			// isolation is the DO id (org:room); role is gateway-stamped (x-wave-role), validated as in rooms.
			let payload: Record<string, unknown> = {};
			try {
				payload = (await request.json()) as Record<string, unknown>;
			} catch {
				payload = {}; // empty/invalid JSON → validated inside the DO/signaling layer
			}
			// The room/stream the source publishes into: explicit body.room/streamKey, else the participant id.
			const room =
				typeof payload.room === "string" ? payload.room :
				typeof payload.streamKey === "string" ? payload.streamKey : "";
			if (!room) {
				return Response.json(
					{ error: "BAD_REQUEST", message: "WHIP ingress requires a room or streamKey in the body" },
					{ status: 400 },
				);
			}
			const participantId = typeof payload.participantId === "string" ? payload.participantId : `whip-${room}`;
			const role = ROLES.has(request.headers.get("x-wave-role") ?? "")
				? (request.headers.get("x-wave-role") as string)
				: "speaker"; // an ingress source publishes → default speaker (can be narrowed by the gateway)
			const rawType = request.headers.get("x-wave-room-type") ??
				(typeof payload.type === "string" ? payload.type : undefined);
			const type = rawType !== undefined && ROOM_TYPE_VALUES.has(rawType) ? rawType : undefined;
			const anon = (request.headers.get("x-wave-anon") ?? "") !== "";

			const id = env.ROOM.idFromName(`${org}:${room}`);
			const stub = env.ROOM.get(id);
			const intentReq = new Request("https://room/join", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...payload, ctx: { org, room, participantId, role, type, anon } }),
			});
			return stub.fetch(intentReq);
		}

		return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
	},

	// Cron (wrangler.toml [triggers]) — durable recovery for PULL-mode recordings. RTK fires the UPLOADED
	// webhook once and never re-delivers after our 200, so a POST-ack pull failure would silently lose the
	// recording. handleRecordingWebhook enqueues a pending-pull record on failure; this reconcile re-pulls each
	// with a freshly resolved download URL (idempotent key) and clears it on success. Best-effort; never throws.
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const sink = buildPullSink(env);
		if (sink && env.RT_MEETING_ORG) {
			ctx.waitUntil(
				reconcilePending(env.RT_MEETING_ORG, sink, (msg, fields) => console.log(JSON.stringify({ msg, ...fields }))),
			);
		}
	},
};
