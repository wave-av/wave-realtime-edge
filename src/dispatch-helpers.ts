// dispatch-helpers.ts — env shape, route-match constants, and the auth/deps/sink plumbing for the
// fetch() router. Extracted from route-dispatch.ts (task #56) so neither module exceeds 800 lines.
// This is a LEAF module (route-dispatch imports from here, never the reverse) → no import cycle.
// Behavior is byte-identical to the original monolithic body.
import { join } from "./realtimekit";
import { DefaultManagedRecordingApi, DefaultManagedRecordingApi as ManagedApi } from "./encoders/managed";
import type { EncoderEnv } from "./encoders/encoder";
import {
	liveWebhookDeps,
	PENDING_PREFIX,
	PENDING_TTL_SECONDS,
	type RecordingPullSink,
} from "./rtk-webhook";
import { type IngestBridgeRuntimeEnv } from "./ingest-bridge";
import { buildResidencyDeps, residencyEnabled, type ResidencySinkEnv } from "./residency-sink";
import { type CascadeSinkEnv } from "./cascade-sink";

/** Minimal Durable Object namespace shape (avoids a hard dependency on cloudflare:workers types).
 *  `get` accepts the optional `{ locationHint }` CF supports so the cascade path (#82, RT_CASCADE) can place
 *  a regional relay DO in its region; the option is ignored on the primary path (today's behavior unchanged). */
interface RoomNamespace {
	idFromName(name: string): unknown;
	get(id: unknown, options?: { locationHint?: DurableObjectLocationHint }): { fetch(request: Request): Promise<Response> };
}

// Env extends EncoderEnv so the recording adapter's config (CF_ACCOUNT_ID/CF_API_TOKEN/RTK_APP_ID +
// RT_RECORD/RT_ENCODER/RT_RECORDINGS + the pull-mode RT_MEETING_ORG meetingId→org KV) flows straight from the
// worker env into selectEncoder()/pullRecordingConfigured()/the webhook pull sink with no re-mapping.
export interface Env extends EncoderEnv, ResidencySinkEnv, IngestBridgeRuntimeEnv, CascadeSinkEnv {
	// F (#55) Plane-2 direct-ingest control plane — INERT behind INGEST_BRIDGE_ENABLED ([vars], default off) +
	// per-protocol container bindings (SRT_BRIDGE/RIST_BRIDGE/RTMPS_BRIDGE/MOQ_BRIDGE, all COMMENTED until each
	// leg's ◆). Off/absent → /v1/ingest/{proto}/session falls through to the 501 catch-all, UNCHANGED. The flag,
	// bindings, WHIP endpoint, and bridge key REF fields all come from IngestBridgeRuntimeEnv (src/ingest-bridge.ts).
	WAVE_INTERNAL_SECRET?: string; // wrangler SECRET — when set, ONLY the gateway (x-wave-internal) may /rtk/* AND /v1/realtime/*
	// E-ROOMS P4 (#73) client presence/state-sync + data channel flag ([vars], default off). Falsy/absent →
	// GET /v1/realtime/rooms/:room/presence is inert (falls through to the 501 catch-all, UNCHANGED). Truthy
	// ("1"/"true") → the WS-upgrade presence surface is served (the DO owns the hibernatable socket).
	PRESENCE_ENABLED?: string | boolean;
	// E-MEDIA-TAP (#74) one room-subscribe surface flag ([vars], default off). Falsy/absent → the RoomDO builds
	// the MediaTap but publishes NO frames into it (prod byte-identical). Truthy ("1"/"true") → each decoded
	// frame the DO sinks also fans out to authorized tap consumers (egress #75 + #85 perception #76).
	MEDIA_TAP_ENABLED?: string | boolean;
	// B3 (#98) WHIP v1 ingest flag ([vars], default off). Falsy/absent → the /v1/whip/* surface is inert and
	// the 501 catch-all is unchanged. Truthy ("1"/"true") → the WHIP listener (src/whip.ts) handles /v1/whip/*.
	WHIP_INGEST_ENABLED?: string | boolean;
	// #151 hosted self-host recorder-ingest flag ([vars], default off). Falsy/absent → PUT /v1/realtime/
	// recording-ingest/* 501s (inert). Truthy → the RoomDO streams the werift-muxed container to R2.
	RECORDER_INGEST_ENABLED?: string | boolean;
	// B1 (#91-a) CF Stream bridge flag ([vars], default off). Falsy/absent → POST /v1/stream/bridge/webhook is
	// inert (501 fall-through). Truthy → the control-plane webhook (src/stream-bridge.ts) handles it.
	STREAM_BRIDGE_ENABLED?: string | boolean;
	WAVE_STREAM_WEBHOOK_SECRET?: string; // wrangler SECRET — CF Stream webhook signing secret (HMAC). Empty → every webhook 401s (fail-closed).
	STREAM_BRIDGE?: DurableObjectNamespace; // B2 republisher container (whep-to-whip). COMMENTED in wrangler until ◆ go-live → absent → dispatch fails CLOSED.
	// #88 M2 Zoom RTMS bridge flag ([vars], default off). Falsy/absent → POST /zoom/rtms is inert (501 fall-through).
	// Truthy → the control-plane webhook (src/zoom-rtms-bridge.ts) verifies + acks; the media WS dial-out is a ◆ follow-up.
	WAVE_ZOOM_RTMS?: string | boolean;
	ZOOM_RTMS_WEBHOOK_SECRET_TOKEN?: string; // wrangler SECRET — Zoom Event-notification Secret Token (signs webhooks + url_validation). Empty → every webhook 401s (fail-closed).
	ZOOM_RTMS_BRIDGE?: DurableObjectNamespace; // #88 M2 outbound media DO (ZoomRtmsBridgeDO), keyed idFromName(meetingUuid). Absent → the webhook seam is a no-op (INERT); dial-out fails closed.
	ZOOM_APPS_CLIENT_ID?: string; // wrangler SECRET — WAVE General-app Client ID; the RTMS handshake clientId (read by ZoomRtmsBridgeDO). Unset → dial-out fails closed.
	ZOOM_APPS_CLIENT_SECRET?: string; // wrangler SECRET — signs the RTMS handshake. Never logged/returned.
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
	// ── E3.P2/P4 (#127) DATA-RESIDENCY fields come from ResidencySinkEnv (src/residency-sink.ts); inert unless RT_RESIDENCY. ──
}

/** Injectable RTK primitives the egress/start path drives (live: realtimekit.join + ManagedApi.start). */
export interface EgressDeps {
	join(env: Env, room: string): Promise<{ meetingId: string }>;
	startRecording(env: Env, meetingId: string): Promise<{ recordingId: string }>;
}

/** Live egress deps: create an RTK meeting for the room, then start its (pull-mode) recording. */
export function liveEgressDeps(): EgressDeps {
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
export const recordingWebhookDeps = liveWebhookDeps();

/** CF-Calls SFU realtime intents the worker forwards to the Room DO (last path segment). */
export const REALTIME_INTENTS = new Set(["join", "publish", "subscribe", "renegotiate", "leave"]);
/** POST /v1/realtime/rooms/:room/:intent */
export const REALTIME_ROUTE = /^\/v1\/realtime\/rooms\/([^/]+)\/([^/]+)\/?$/;
/** E-ROOMS P4 (#73) client presence/state-sync + data channel — GET(upgrade) /v1/realtime/rooms/:room/presence.
 *  Matched BEFORE the generic :intent route (presence is not a signaling intent) and gated by presenceEnabled. */
export const PRESENCE_ROUTE = /^\/v1\/realtime\/rooms\/([^/]+)\/presence\/?$/;
/** Presence surface flag ([vars], default off → inert). Truthy "1"/"true"/boolean-true arms it. */
export function presenceEnabled(env: Env): boolean {
	const v = env.PRESENCE_ENABLED;
	return v === true || v === "1" || v === "true";
}
/** RT-R9 hibernatable WS recorder route the SFU dials OUT to: /v1/realtime/recorder/:org/:room/:sessionId/:trackName.
 *  :room is REQUIRED so a frame addresses the SAME RoomDO (keyed `${org}:${room}`) holding the publish-path tap;
 *  the capability token binds ONLY (org, sessionId, trackName) — room is a routing key, not signed identity. */
export const RECORDER_ROUTE = /^\/v1\/realtime\/recorder\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
/** #151 hosted self-host recorder INGEST: PUT /v1/realtime/recording-ingest/:org/:room/:sessionId/:trackName.
 *  The self-host werift recorder (containers/rt-recorder) PULLs the SFU track, muxes a WebM/Matroska container,
 *  and STREAMS the finalized bytes here (one PUT, streamed body). The RoomDO (keyed `${org}:${room}`) appends
 *  them to its single-writer RealtimeRecorder → the ONE canonical R2 object. Same dual-auth + segment-scope as
 *  RECORDER_ROUTE (pre-signed capability token OR x-wave-internal). Distinct from the WS frame route: this
 *  ingests a whole muxed container, not per-frame media. Gated by RECORDER_INGEST_ENABLED (default off → 501). */
export const RECORDER_INGEST_ROUTE = /^\/v1\/realtime\/recording-ingest\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
/** #151 recorder-DISPATCH: POST /v1/realtime/recorder-dispatch/:org/:room. An INTERNAL orchestrator (the
 *  container spawner in prod, or the self-host recorder driver) asks the RoomDO "what should I record here,
 *  and with what pre-signed ingest URL?". The DO answers with one descriptor per registered track, each
 *  carrying a freshly-minted, track-scoped ingest capability token (minted with WAVE_INTERNAL_SECRET, which
 *  lives IN the DO — so mint here and verify at the ingest route ALWAYS agree, regardless of the secret's
 *  value). Internal-ONLY (no token alternative — this MINTS tokens): gateway-trust (x-wave-internal) required.
 *  Shares the RECORDER_INGEST_ENABLED flag (default off → 501 inert). Never returns any secret. */
export const RECORDER_DISPATCH_ROUTE = /^\/v1\/realtime\/recorder-dispatch\/([^/]+)\/([^/]+)\/?$/;
/** #151 recorder-ingest surface flag ([vars], default off → 501 inert). Truthy "1"/"true"/boolean-true arms it. */
export function recorderIngestEnabled(env: Env): boolean {
	const v = env.RECORDER_INGEST_ENABLED;
	return v === true || v === "1" || v === "true";
}
/** LK-rip #77 egress control plane the gateway fronts:
 * POST /rtk/egress/start|stop|info. Intent allowlist — anything else is not a recognized egress route. */
export const EGRESS_INTENTS = new Set(["start", "stop", "info"]);
export const EGRESS_ROUTE = /^\/rtk\/egress\/([^/]+)\/?$/;
/** Segment guards for the recorder route (SSRF-safe DO-key + frame-forward params). */
export const SAFE_SEGMENT = /^[A-Za-z0-9_:.-]{1,128}$/;
/** Task #81 — voice-agent dispatch: POST /v1/realtime/agents/:intent (bind|info). Gated by the flag. */
export const AGENT_DISPATCH_ROUTE = /^\/v1\/realtime\/agents\/([a-z]+)\/?$/;
export const AGENT_DISPATCH_INTENTS = new Set(["bind", "info"]);
/** Task #81 — agent egress WS the SFU dials OUT to (PCM in): /v1/realtime/agents/egress/:org/:room/:sessionId/:trackName.
 *  Mirrors RECORDER_ROUTE; the DO key is `${org}:${room}`-derived so a frame reaches the SAME AgentSessionDO
 *  the dispatch bound. The capability token (?t=) authorizes the third-party SFU dial-in (it can't send x-wave-internal). */
export const AGENT_EGRESS_ROUTE = /^\/v1\/realtime\/agents\/egress\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
/** Task #81 — agent INGEST WS (SFU dials IN to PULL the agent's PCM): /v1/realtime/agents/ingest/:org/:room/:sessionId/:trackName.
 *  Symmetric to AGENT_EGRESS_ROUTE, but the upgrade is FORWARDED to the `${org}:${room}` AgentSessionDO so the DO owns the durable socket. */
export const AGENT_INGEST_ROUTE = /^\/v1\/realtime\/agents\/ingest\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
/** #88 M2 — Zoom RTMS ingest WS (the SFU dials IN to PULL the bridged Zoom audio):
 *  /zoom/rtms/ingest/:meetingUuid/:org/:sessionId/:trackName. The upgrade is FORWARDED to the
 *  idFromName(meetingUuid) ZoomRtmsBridgeDO (the same DO the verified rtms_started started), which owns the
 *  durable sink socket. The capability token (?t=) authorizes the third-party SFU dial-in (org/session/track). */
export const ZOOM_RTMS_INGEST_ROUTE = /^\/zoom\/rtms\/ingest\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;

// ── WAVE-native ingress listeners (LK-rip #42) — POST /v1/realtime/ingress/:protocol/:intent ──
// The protocol + intent allowlist MUST match the gateway ingress forwarding contract (rtmp/whip/srt/url +
// create/delete; plus protocol-less management). The gateway already validates the shape; we re-validate
// here (defense in depth, never trust transport).
//
// FEASIBILITY (correctness-by-design): a Worker cannot accept raw inbound TCP (RTMP) / UDP (SRT) sockets, nor
// decode an arbitrary pulled URL into SFU tracks. WHIP → LIVE (WebRTC-over-HTTP: the SFU newSession(offer)→
// answer the room/join path already performs; forwarded to the Room DO `join`, SFU answer = the WHIP 201).
// rtmp/srt/url → honest 501 (ingress_protocol_requires_vm_listener): need an out-of-Worker VM listener.
export const INGRESS_ROUTE = /^\/v1\/realtime\/ingress\/([a-z]+)\/([a-z]+)\/?$/;
/** Worker-feasible ingress protocols served LIVE here. WHIP only (WebRTC-over-HTTP). */
export const INGRESS_LIVE_PROTOCOLS = new Set(["whip"]);
/** Protocols that need an out-of-Worker VM listener → honest 501 with a machine-readable marker. */
export const INGRESS_VM_PROTOCOLS = new Set(["rtmp", "srt", "url"]);
/** Per-protocol intents (must match the gateway's INGRESS_PROTOCOL_INTENTS). */
export const INGRESS_PROTOCOL_INTENTS = new Set(["create", "delete"]);
/** Whitelists for the UNTRUSTED gateway-stamped role/type values (reject anything off-list). */
export const ROLES = new Set(["host", "speaker", "viewer"]);
export const ROOM_TYPE_VALUES = new Set(["meeting", "webinar", "event", "breakout"]);

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
export function gatewayGate(request: Request, secret: string | undefined): Response | null {
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
export function buildPullSink(env: Env): RecordingPullSink | null {
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
		// E3.P2/P4 (#127): attach residency deps ONLY when RT_RESIDENCY is on. Absent → byte-identical to today
		// (default bucket, no region key, no register). See residency-sink.ts for the gating + arm contract.
		residency: residencyEnabled(env) ? buildResidencyDeps(env, kv) : undefined,
	};
}

/** A WAVE org id is the FIRST path segment of every recording R2 key (the daily sweep bills by it), so it must
 * be a safe single path segment. The gateway stamps x-wave-org, but we still validate before minting a key/
 * billing prefix: alphanumerics + `_ : -` only (uuid-ish / pool-ish), no `/`, dot, or whitespace, ≤128 chars. */
export const SAFE_ORG = /^[A-Za-z0-9_:-]{1,128}$/;
