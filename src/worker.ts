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
import { DefaultManagedRecordingApi as ManagedApi } from "./encoders/managed";
import type { EncoderEnv } from "./encoders/encoder";
import { selectEncoder } from "./encoders/factory";
import { verifyRecorderToken } from "./encoders/recorder-auth";
import { pullRecordingConfigured, DefaultManagedRecordingApi } from "./encoders/managed";
import {
	handleRecordingWebhook,
	liveWebhookDeps,
	reconcilePending,
	PENDING_PREFIX,
	PENDING_TTL_SECONDS,
	type RecordingPullSink,
} from "./rtk-webhook";
// B3 (#98) — IETF WHIP v1 ingest surface (/v1/whip/*). INERT behind WHIP_INGEST_ENABLED ([vars], default off
// → the 501 catch-all is unchanged). See src/whip.ts + whip-v1-frozen-contract.md §3/§4/§6-B3.
import { handleWhip, whipIngestEnabled, type WhipEnv } from "./whip";
// B1 (#91-a) — CF Stream Live → SFU bridge CONTROL PLANE. INERT behind STREAM_BRIDGE_ENABLED. worker.ts only
// DELEGATES; all matching/auth/dispatch lives in src/stream-bridge.ts (+ cf-stream-bridge-frozen-contract).
import { maybeHandleStreamBridge, scheduledStreamReconcile } from "./stream-bridge";
// Task #81 (LK-rip Phase 6b) — voice-agent runtime. INERT behind VOICE_AGENT_PROVIDER==="wave": every new
// route/DO behavior is gated by voiceAgentEnabled(env); absent/anything-else → the 501 catch-all is unchanged.
import { voiceAgentEnabled, type AgentSessionConfig } from "./agent-session";

// Re-export the Room Durable Object so the wrangler `ROOM` binding + migration (v1, new_sqlite_classes)
// resolve from this main module. The class itself is defined in room.ts (P5 substrate); it is not yet
// wired into fetch() — that is the P5.2 signaling follow-up. Exporting it here lets the binding deploy.
export { RoomDO } from "./room";

// RT-R10 (#72) — the PORTABLE raw-SFU encode container Durable Object class (Path A). Mirrors bridge-edge's
// MoqContainer verbatim: a Container-DO the Worker reaches via getContainer(env.RECORDER, id).fetch('/encode')
// to transcode JPEG→VP8 / PCM→Opus (the Workers isolate can't host libvpx/libopus). INERT: the matching
// `[[containers]] RECORDER` block in wrangler.toml stays COMMENTED (Path A attach is a Jake-named ◆), so this
// export resolves the class without provisioning a live container or a `new_sqlite_classes` migration. It is
// exported here (the main module) so that, when the ◆ uncomments the binding, the class is already in scope.
export { RecorderContainer } from "./encoders/recorder-container";
export { StreamBridgeContainer } from "./stream-bridge-container"; // #91 B2 — inert (binding COMMENTED until ◆)

// Task #81 — the per-room voice-agent session Durable Object. Exported from the main module so the
// AGENT_SESSION binding + migration resolve on deploy. INERT: the dispatch/egress routes only reach it when
// VOICE_AGENT_PROVIDER==="wave"; this export merely resolves the class for the binding.
export { AgentSessionDO } from "./agent-session";

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
	// B3 (#98) WHIP v1 ingest flag ([vars], default off). Falsy/absent → the /v1/whip/* surface is inert and
	// the 501 catch-all is unchanged. Truthy ("1"/"true") → the WHIP listener (src/whip.ts) handles /v1/whip/*.
	WHIP_INGEST_ENABLED?: string | boolean;
	// B1 (#91-a) CF Stream bridge flag ([vars], default off). Falsy/absent → POST /v1/stream/bridge/webhook is
	// inert (501 fall-through). Truthy → the control-plane webhook (src/stream-bridge.ts) handles it.
	STREAM_BRIDGE_ENABLED?: string | boolean;
	WAVE_STREAM_WEBHOOK_SECRET?: string; // wrangler SECRET — CF Stream webhook signing secret (HMAC). Empty → every webhook 401s (fail-closed).
	STREAM_BRIDGE?: DurableObjectNamespace; // B2 republisher container (whep-to-whip). COMMENTED in wrangler until ◆ go-live → absent → dispatch fails CLOSED.
	TURN_KEY_ID?: string; // wrangler SECRET — the CF TURN key uid (32-hex). Out of the public repo; persists across deploys.
	TURN_KEY_TOKEN?: string; // wrangler SECRET — the TURN key's api token. Never logged/returned; only ephemeral ICE creds are.
	// ── P5 CF-Calls SFU control plane ──
	ROOM?: RoomNamespace; // Durable Object binding (wrangler ROOM → RoomDO). Per-room state + signaling.
	// GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN are read INSIDE the RoomDO (see RoomDOEnv in room.ts) — the worker
	// forwards the env to the DO via the binding, so it does not need to name them here.
	// ── RT-R10 (#72) portable recorder — ALL inert by default (RECORDER_TARGET 'none', RECORDER_SINK 'r2') ──
	RECORDER_TARGET?: "cf" | "selfhost" | "none"; // where video encodes; default 'none' (drop video; prod untouched)
	RECORDER?: DurableObjectNamespace; // Path A container binding — COMMENTED in wrangler.toml until the ◆ attach → absent
	RECORDER_SELFHOST_URL?: string; // Path B — base URL of the self-hosted rt-encoder service (e.g. https://studio:8080)
	RECORDER_SINK?: "r2" | "localfs" | "fanout"; // where the recording lands; default 'r2' (today's cloud behavior)
	RECORDER_LOCAL_DIR?: string; // on-prem local recording dir (self-host); used by localfs/fanout sinks
	// ── LK-rip #77 egress control plane (wraps the proven PULL-mode recorder) ──
	// Injectable seam so the egress/start path unit-tests with NO live RTK network. Absent in prod →
	// the live join() + DefaultManagedRecordingApi are used. Never a public/wire input.
	__egressDeps?: EgressDeps;
	// ── Task #81 voice-agent runtime — ALL inert unless VOICE_AGENT_PROVIDER==="wave" ──
	VOICE_AGENT_PROVIDER?: string; // "wave" arms the voice-agent dispatch + egress routes; else fully inert
	AGENT_SESSION?: RoomNamespace; // Durable Object binding (wrangler AGENT_SESSION → AgentSessionDO)
}

/** Injectable RTK primitives the egress/start path drives (live: realtimekit.join + ManagedApi.start). */
interface EgressDeps {
	join(env: Env, room: string): Promise<{ meetingId: string }>;
	startRecording(env: Env, meetingId: string): Promise<{ recordingId: string }>;
}

/** Live egress deps: create an RTK meeting for the room, then start its (pull-mode) recording. */
function liveEgressDeps(): EgressDeps {
	return {
		async join(env, room) {
			const result = await join(
				{ accountId: env.CF_ACCOUNT_ID ?? "", appId: env.RTK_APP_ID ?? "", token: env.CF_API_TOKEN ?? "" },
				{ title: room, name: room },
			);
			return { meetingId: result.meetingId };
		},
		async startRecording(env, meetingId) {
			return new ManagedApi(env).start(meetingId);
		},
	};
}

// Module-scoped so CF's webhook public key (fetched from the well-known doc) is cached for the isolate's
// lifetime instead of re-fetched per webhook. Verification deps are injectable in unit tests via the handler.
const recordingWebhookDeps = liveWebhookDeps();

/** CF-Calls SFU realtime intents the worker forwards to the Room DO (last path segment). */
const REALTIME_INTENTS = new Set(["join", "publish", "subscribe", "renegotiate", "leave"]);
/** POST /v1/realtime/rooms/:room/:intent */
const REALTIME_ROUTE = /^\/v1\/realtime\/rooms\/([^/]+)\/([^/]+)\/?$/;
/** RT-R9 hibernatable WS recorder route the SFU dials OUT to: /v1/realtime/recorder/:org/:room/:sessionId/:trackName.
 *  :room is REQUIRED so a frame addresses the SAME RoomDO (keyed `${org}:${room}`) that holds the tap created on the
 *  publish path — without it the frame lands on a DIFFERENT DO (keyed by sessionId) with no tap and is silently
 *  dropped. The capability token still binds ONLY (org, sessionId, trackName); room is a routing key, not part of the
 *  signed identity (a wrong room routes to a tap-less DO — a harmless no-op, never a forgery). */
const RECORDER_ROUTE = /^\/v1\/realtime\/recorder\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
/** LK-rip #77 egress control plane the gateway fronts (WSC WaveEgressProviderService #4984 drives these):
 * POST /rtk/egress/start|stop|info. Intent allowlist — anything else is not a recognized egress route. */
const EGRESS_INTENTS = new Set(["start", "stop", "info"]);
const EGRESS_ROUTE = /^\/rtk\/egress\/([^/]+)\/?$/;
/** Segment guards for the recorder route (SSRF-safe DO-key + frame-forward params). */
const SAFE_SEGMENT = /^[A-Za-z0-9_:.-]{1,128}$/;
/** Task #81 — voice-agent dispatch: POST /v1/realtime/agents/:intent (bind|info). Gated by the flag. */
const AGENT_DISPATCH_ROUTE = /^\/v1\/realtime\/agents\/([a-z]+)\/?$/;
const AGENT_DISPATCH_INTENTS = new Set(["bind", "info"]);
/** Task #81 — agent egress WS the SFU dials OUT to (PCM in): /v1/realtime/agents/egress/:org/:room/:sessionId/:trackName.
 *  Mirrors RECORDER_ROUTE; the DO key is `${org}:${room}`-derived so a frame reaches the SAME AgentSessionDO
 *  the dispatch bound. The capability token (?t=) authorizes the third-party SFU dial-in (it can't send x-wave-internal). */
const AGENT_EGRESS_ROUTE = /^\/v1\/realtime\/agents\/egress\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
/** Task #81 — agent INGEST WS the SFU dials IN to PULL the agent's published PCM (createIngestAdapter
 *  location:"local"): /v1/realtime/agents/ingest/:org/:room/:sessionId/:trackName. Symmetric to AGENT_EGRESS_ROUTE,
 *  but the upgrade is FORWARDED to the `${org}:${room}` AgentSessionDO so the DO owns the live socket it sends on
 *  (egress forwards per-frame over HTTP; ingest must hold a durable socket the agent pushes to over time). */
const AGENT_INGEST_ROUTE = /^\/v1\/realtime\/agents\/ingest\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;

// ── WAVE-native ingress listeners (LK-rip #42) — POST /v1/realtime/ingress/:protocol/:intent ──
// Server-side counterpart to wave-gateway PR #204 (which forwards this exact path shape as the identity  # guard:allow cross-repo PR reference in a design comment, not a leak
// edge path) and wave-surfer-connect PR #4982's WaveIngressProviderService contract. The protocol + intent  # guard:allow cross-repo PR reference in a design comment, not a leak
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

		// ── RT-R9 raw-SFU recorder WS route — /v1/realtime/recorder/:org/:room/:sessionId/:trackName ──
		// The CF Realtime SFU dials OUT to this hibernatable WS endpoint (per the container-encoder adapter) and
		// pushes ONE track's media as binary frames; each frame is forwarded to the room's DO tap. INERT: gated
		// behind the SAME internal-secret chokepoint AND RT_RECORD==="1" — unarmed (live default) it 404s, so
		// nothing can dial it. A non-Upgrade request → 426. The DO feed is fail-open (ctx.waitUntil), never blocks.
		const recMatch = url.pathname.match(RECORDER_ROUTE);
		if (recMatch) {
			const [, rorg, rroom, rsession, rtrack] = recMatch;
			if (![rorg, rroom, rsession, rtrack].every((s) => SAFE_SEGMENT.test(s)) || !env.ROOM) {
				return Response.json({ error: "BAD_REQUEST", message: "invalid recorder path or no ROOM binding" }, { status: 400 });
			}
			// AUTH — accept EITHER a valid scoped capability token (?t=, how the third-party SFU dials in; it
			// cannot send our internal header) OR the `x-wave-internal` header (the path for internal callers).
			// When WAVE_INTERNAL_SECRET is unset (local/test) the token check is false AND gatewayGate enforces
			// nothing → no enforcement, mirroring every other gated route.
			const tok = url.searchParams.get("t");
			const tokenOk =
				!!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, rorg, rsession, rtrack, tok));
			if (!tokenOk) {
				const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
				if (denied) return denied;
			}
			// Disarmed (RT_RECORD!=="1", the live default) → the route does not exist (config-no-silent-noop:
			// nothing dials it, so a 501 is the honest "no recorder here", not a silent accept).
			if (env.RT_RECORD !== "1") {
				return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
			}
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
				return Response.json(
					{ error: "UPGRADE_REQUIRED", message: "recorder route requires a WebSocket upgrade" },
					{ status: 426 },
				);
			}
			// Open a server WebSocket and forward every BINARY frame to the room's DO tap (keyed `${org}:${room}` —
			// the SAME DO the publish path created the tap in). The DO feed is fully fail-open — a recording error
			// never affects the live media the SFU is also pushing.
			// WebSocketPair is a Workers-runtime global; referenced off globalThis so unit tests can stub it.
			const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
			if (!WSP) {
				return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
			}
			const pair = new WSP();
			const client = (pair as unknown as Record<string, WebSocket>)[0];
			const server = (pair as unknown as Record<string, WebSocket>)[1];
			server.accept();
			// CF Workers' default WebSocket binaryType is "blob", so the SFU's binary Packet frames arrive as Blob,
			// NOT ArrayBuffer (proven live: 1221 frames over a 30s session were silently dropped). Ask for ArrayBuffer
			// delivery AND accept Blob too — either is a valid Request body the DO normalizes via request.arrayBuffer().
			try {
				(server as unknown as { binaryType?: string }).binaryType = "arraybuffer";
			} catch {
				/* binaryType not settable on some runtimes — the Blob branch below still catches it */
			}
			const id = env.ROOM.idFromName(`${rorg}:${rroom}`); // SAME DO as publish (org:room) → the tap lives here
			const stub = env.ROOM.get(id);
			server.addEventListener("message", (ev: MessageEvent) => {
				const data = ev.data;
				// Only binary media frames (ArrayBuffer or Blob); ignore text/keepalive (string).
				if (!(data instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && data instanceof Blob)) return;
				const fwd = stub
					.fetch(
						new Request(`https://room/recorder-frame?sessionId=${encodeURIComponent(rsession)}&trackName=${encodeURIComponent(rtrack)}`, {
							method: "POST",
							body: data as BodyInit,
						}),
					)
					.catch(() => {});
				if (ctx) ctx.waitUntil(fwd);
			});
			// Workers accepts a 101 + webSocket ResponseInit (the WS-upgrade idiom). Some non-Workers runtimes
			// (e.g. the Node test env) reject status 101 in the Response ctor — guard so the handler never throws.
			try {
				return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
			} catch {
				return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
			}
		}

		// ── P5 CF-Calls SFU control plane — POST /v1/realtime/rooms/:room/:intent ──
		// Routed through the Room DO (per-org isolation: the DO id is keyed `${org}:${room}`), which runs the
		// Signaling orchestration (room.ts RoomDO.fetch). Same gateway-trust chokepoint as /rtk/*: when
		// WAVE_INTERNAL_SECRET is set, only the gateway (x-wave-internal) may reach these paid endpoints. Org
		// comes from the gateway-stamped `x-wave-org` header (the gateway authenticates + scopes upstream).
		// ── LK-rip #77 egress control plane — POST /rtk/egress/start|stop|info ──
		// The gateway-fronted WAVE-native recording-egress surface the WSC WaveEgressProviderService (#4984)
		// drives. WRAPS the proven PULL-mode recorder (rtk-webhook pulls the finished file into our R2) — it does
		// NOT build a raw-SFU tap (that stays NOT_SPIKED/dormant). Behind the SAME internal-secret chokepoint as
		// the other /rtk/* routes. DORMANT by default: when pull mode is not configured (the live default —
		// RT_RECORD!=="1" or creds/bindings absent) every intent 501s, which the #4984 client maps to
		// RECORDER_BYTESOURCE_UNAVAILABLE (fail loud until the recorder is armed; never a faked file/silent ok).
		{
			const egMatch = request.method === "POST" ? url.pathname.match(EGRESS_ROUTE) : null;
			if (egMatch && EGRESS_INTENTS.has(egMatch[1])) {
				const deniedEg = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
				if (deniedEg) return deniedEg;
				const intent = egMatch[1];
				if (!pullRecordingConfigured(env)) {
					return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
				}
				let body: Record<string, unknown> = {};
				try {
					body = (await request.json()) as Record<string, unknown>;
				} catch {
					body = {};
				}
				const deps = env.__egressDeps ?? liveEgressDeps();

				if (intent === "start") {
					const org = request.headers.get("x-wave-org") ?? "";
					if (!SAFE_ORG.test(org)) {
						return Response.json(
							{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org)" },
							{ status: 400 },
						);
					}
					const room = typeof body.room === "string" ? body.room : "";
					try {
						// egressId == the RTK meetingId == the recording sessionId, so the webhook pull lands ONE
						// canonical object at the LIVE recordingKey() scheme
						// `${org}/realtime-recordings/${meetingId}/recording.<ext>` (tier SKIP, lifecycle-applied).
						const { meetingId } = await deps.join(env, room);
						// Persist meetingId→org FIRST so the recording.statusUpdate webhook attributes the pull to this org.
						await env.RT_MEETING_ORG?.put(meetingId, org, { expirationTtl: 60 * 60 * 24 * 14 });
						const { recordingId } = await deps.startRecording(env, meetingId);
						console.log(JSON.stringify({ msg: "rt-egress-started", egressId: meetingId, recordingId, org, room }));
						return Response.json(
							{ egressId: meetingId, sessionId: meetingId, recordingId, room, status: "starting" },
							{ status: 200 },
						);
					} catch (e) {
						const err = e instanceof RtkError ? e : new RtkError("REALTIME_ERROR", "egress start failed", 500);
						return Response.json({ error: err.code, message: err.message }, { status: err.status });
					}
				}

				// stop / info: egressId is the RTK meetingId. The RTK recording auto-stops at meeting end and the
				// webhook pulls the finished file into R2, so STOP is a best-effort ack (we never tear down a live
				// meeting from here) and INFO reports the correlation; full status detail is webhook-driven.
				const egressId = typeof body.egressId === "string" ? body.egressId : "";
				if (!egressId) {
					return Response.json({ error: "BAD_REQUEST", message: "egressId is required" }, { status: 400 });
				}
				const org = (await env.RT_MEETING_ORG?.get(egressId)) ?? null;
				if (intent === "stop") {
					console.log(JSON.stringify({ msg: "rt-egress-stop", egressId, org }));
					return Response.json({ egressId, sessionId: egressId, status: "stopping" }, { status: 200 });
				}
				return Response.json(
					{ egressId, sessionId: egressId, org, status: org ? "active" : "unknown" },
					{ status: 200 },
				);
			}
		}

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

		// ── B3 (#98) IETF WHIP v1 ingest — /v1/whip/publish + /v1/whip/resource/{id} ──
		// INERT behind WHIP_INGEST_ENABLED ([vars], default off): when the flag is falsy/absent, this block is
		// skipped entirely and a /v1/whip/* request falls through to the 501 catch-all below — UNCHANGED. When
		// ON, the SAME gateway-trust chokepoint as every other paid route gates it (WAVE_INTERNAL_SECRET /
		// x-wave-internal); org is the gateway-stamped x-wave-org. The handler (src/whip.ts) talks to the CF
		// Realtime SFU directly (signaling-only glue; media terminates at the SFU, never on this Worker).
		if (url.pathname.startsWith("/v1/whip/") && whipIngestEnabled(env as WhipEnv)) {
			const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
			if (denied) return denied;
			const org = request.headers.get("x-wave-org") ?? "";
			if (!SAFE_ORG.test(org)) {
				return Response.json(
					{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
					{ status: 400 },
				);
			}
			const whipRes = await handleWhip(request, env as WhipEnv, org);
			if (whipRes) return whipRes; // null → unrecognized /v1/whip/* sub-path → 501 fall-through below
		}

		// ── B1 (#91-a) CF Stream Live → SFU bridge — POST /v1/stream/bridge/webhook. INERT behind
		// STREAM_BRIDGE_ENABLED (null → falls through to the 501 catch-all). Self-auth (CF HMAC), control-only. ──
		const sbRes = await maybeHandleStreamBridge(request, env, ctx);
		if (sbRes) return sbRes;

		// ── Task #81 voice-agent runtime (LK-rip Phase 6b) — INERT unless VOICE_AGENT_PROVIDER==="wave" ──
		// When the flag is off, BOTH blocks below are skipped and the request falls through to the 501 catch-all,
		// UNCHANGED. When on, the SAME gateway-trust chokepoint as every paid route gates dispatch; the egress WS
		// route additionally accepts the per-(org,session,track) capability token the SFU appends (it can't send
		// x-wave-internal). The AgentSessionDO is keyed `${org}:${room}` so dispatch + egress address one DO.
		if (voiceAgentEnabled(env)) {
			// 1) Dispatch: POST /v1/realtime/agents/:intent (bind|info) → bind/inspect an AgentSessionDO for a room.
			const adMatch = request.method === "POST" ? url.pathname.match(AGENT_DISPATCH_ROUTE) : null;
			if (adMatch && AGENT_DISPATCH_INTENTS.has(adMatch[1])) {
				const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
				if (denied) return denied;
				const org = request.headers.get("x-wave-org") ?? "";
				if (!SAFE_ORG.test(org)) {
					return Response.json({ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org)" }, { status: 400 });
				}
				if (!env.AGENT_SESSION) {
					// config-no-silent-noop: a missing DO binding must be loud, not a silent 501.
					return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "AGENT_SESSION durable object binding is not configured" }, { status: 503 });
				}
				let body: Record<string, unknown> = {};
				try {
					body = (await request.json()) as Record<string, unknown>;
				} catch {
					body = {};
				}
				const cfg = (body.config ?? {}) as Partial<AgentSessionConfig>;
				const room = typeof cfg.roomId === "string" ? cfg.roomId : "";
				const agentId = typeof cfg.agentId === "string" ? cfg.agentId : "";
				if (adMatch[1] === "bind" && (!SAFE_SEGMENT.test(room) || !SAFE_SEGMENT.test(agentId))) {
					return Response.json({ error: "BAD_REQUEST", message: "bind requires config.roomId and config.agentId" }, { status: 400 });
				}
				// One agent-session DO per room (design §L1), so the DO id is room-scoped — dispatch and egress
				// derive the SAME id from `${org}:${room}` and always resolve one stub.
				// TODO(#81): thread agentId through the egress URL if we ever need >1 agent per room.
				const doKey = `${org}:${room}`;
				const id = env.AGENT_SESSION.idFromName(doKey);
				const stub = env.AGENT_SESSION.get(id);
				const method = adMatch[1] === "info" ? "GET" : "POST";
				return stub.fetch(new Request(`https://agent/${adMatch[1]}`, {
					method,
					headers: { "content-type": "application/json" },
					body: method === "POST" ? JSON.stringify({ config: { ...cfg, org } }) : undefined,
				}));
			}

			// 2) Egress WS: the SFU dials OUT to push the participant's PCM. Forward each binary frame to the DO's echo.
			const aeMatch = url.pathname.match(AGENT_EGRESS_ROUTE);
			if (aeMatch) {
				const [, aorg, aroom, asession, atrack] = aeMatch;
				if (![aorg, aroom, asession, atrack].every((s) => SAFE_SEGMENT.test(s)) || !env.AGENT_SESSION) {
					return Response.json({ error: "BAD_REQUEST", message: "invalid agent egress path or no AGENT_SESSION binding" }, { status: 400 });
				}
				const tok = url.searchParams.get("t");
				const tokenOk = !!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, aorg, asession, atrack, tok));
				if (!tokenOk) {
					const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
					if (denied) return denied;
				}
				if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
					return Response.json({ error: "UPGRADE_REQUIRED", message: "agent egress route requires a WebSocket upgrade" }, { status: 426 });
				}
				const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
				if (!WSP) {
					return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
				}
				const pair = new WSP();
				const client = (pair as unknown as Record<string, WebSocket>)[0];
				const server = (pair as unknown as Record<string, WebSocket>)[1];
				server.accept();
				try {
					(server as unknown as { binaryType?: string }).binaryType = "arraybuffer";
				} catch {
					/* binaryType not settable on some runtimes — the Blob branch below still catches it */
				}
				// Room-scoped DO key `${org}:${room}` — identical to the dispatch /bind key, so echo frames forward to
				// the SAME AgentSessionDO that /bind initialized (one agent-session DO per room, design §L1).
				// TODO(#81): thread agentId through the egress URL if we ever need >1 agent per room.
				const id = env.AGENT_SESSION.idFromName(`${aorg}:${aroom}`);
				const stub = env.AGENT_SESSION.get(id);
				server.addEventListener("message", (ev: MessageEvent) => {
					const data = ev.data;
					if (!(data instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && data instanceof Blob)) return;
					const fwd = stub.fetch(new Request(`https://agent/echo-frame?sessionId=${encodeURIComponent(asession)}&trackName=${encodeURIComponent(atrack)}`, {
						method: "POST",
						body: data as BodyInit,
					})).catch(() => {});
					if (ctx) ctx.waitUntil(fwd);
				});
				try {
					return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
				} catch {
					return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
				}
			}

			// 3) Ingest WS: the SFU dials IN to PULL the agent's published PCM. Forward the upgrade to the SAME
			// room-scoped AgentSessionDO (the one /bind armed + egress feeds) so the DO owns the live socket it
			// SENDS frames on. Symmetric auth to egress: the capability token (?t=) the SFU carries, OR the
			// gateway-trust seal. The DO performs the WebSocketPair upgrade; we relay its 101 (with the client
			// socket) back to the SFU verbatim.
			const aiMatch = url.pathname.match(AGENT_INGEST_ROUTE);
			if (aiMatch) {
				const [, aorg, aroom, asession, atrack] = aiMatch;
				if (![aorg, aroom, asession, atrack].every((s) => SAFE_SEGMENT.test(s)) || !env.AGENT_SESSION) {
					return Response.json({ error: "BAD_REQUEST", message: "invalid agent ingest path or no AGENT_SESSION binding" }, { status: 400 });
				}
				const tok = url.searchParams.get("t");
				const tokenOk = !!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, aorg, asession, atrack, tok));
				if (!tokenOk) {
					const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
					if (denied) return denied;
				}
				if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
					return Response.json({ error: "UPGRADE_REQUIRED", message: "agent ingest route requires a WebSocket upgrade" }, { status: 426 });
				}
				const id = env.AGENT_SESSION.idFromName(`${aorg}:${aroom}`);
				const stub = env.AGENT_SESSION.get(id);
				// Pass the original request as init so the Upgrade header + the WS-upgrade intent are preserved
				// across the stub boundary (the DO returns the 101 + webSocket client we relay back).
				return stub.fetch(new Request(`https://agent/ingest?sessionId=${encodeURIComponent(asession)}&trackName=${encodeURIComponent(atrack)}`, request));
			}
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
		// B1 (#91-a) — CF Stream bridge lifecycle-poll backstop (INERT unless enabled + KV bound). Best-effort.
		scheduledStreamReconcile(env, ctx);
	},
};
