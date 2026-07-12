// route-dispatch.ts — extracted fetch() router for wave-realtime-edge.
// worker.ts re-exports all DO/container classes (wrangler binding resolution) and delegates
// here for every request. Split from worker.ts (task #56) to keep the entry module under 800 lines;
// behavior is byte-identical to the original monolithic fetch() body.
import { join, turn, RtkError } from "./realtimekit";
import { selectEncoder } from "./encoders/factory";
import { verifyRecorderToken } from "./encoders/recorder-auth";
import { pullRecordingConfigured } from "./encoders/managed";
import { handleRecordingWebhook, reconcilePending } from "./rtk-webhook";
// B3 (#98) — IETF WHIP v1 ingest surface (/v1/whip/*). INERT behind WHIP_INGEST_ENABLED ([vars], default off
// → the 501 catch-all is unchanged). See src/whip.ts + whip-v1-frozen-contract.md §3/§4/§6-B3.
import { handleWhip, whipIngestEnabled, type WhipEnv } from "./whip";
// #53 — IETF WHEP v1 egress surface (/v1/whep/*), the egress SIBLING of WHIP. INERT behind WHEP_EGRESS_ENABLED
// ([vars], default off → the 501 catch-all is unchanged). See src/whep.ts + docs/whep-v1-frozen-contract.md.
import { handleWhep, whepEgressEnabled, type WhepEnv } from "./whep";
// B1 (#91-a) — CF Stream Live → SFU bridge CONTROL PLANE. INERT behind STREAM_BRIDGE_ENABLED. worker.ts only
// DELEGATES; all matching/auth/dispatch lives in src/stream-bridge.ts (+ cf-stream-bridge-frozen-contract).
import { maybeHandleStreamBridge, scheduledStreamReconcile } from "./stream-bridge";
// #88 M2 — Zoom RTMS webhook receiver (control-only). INERT behind WAVE_ZOOM_RTMS ([vars], default off →
// the 501 catch-all is unchanged). Self-verifies x-zm-signature; the outbound media WS dial-out is a ◆ follow-up.
import { maybeHandleZoomRtms } from "./zoom-rtms-bridge";
// #88 M2 — the outbound media DO seams + the SFU ingest-WS forward live in the DO module; route-dispatch only
// delegates (keeps this file under the 800-line gate). INERT unless WAVE_ZOOM_RTMS is armed.
import { zoomRtmsSeams, maybeHandleZoomRtmsIngest } from "./zoom-rtms-bridge-do";
// F (#55) — Direct (Plane-2) any-protocol ingest → SFU bridge CONTROL PLANE. INERT behind INGEST_BRIDGE_ENABLED
// + per-protocol container binding. worker.ts only DELEGATES; matching/auth/dispatch lives in src/ingest-bridge.ts
// (+ any-protocol-ingest-frozen-contract). Sibling of the Plane-1 cf-stream bridge; gateway-forwarded start trigger.
import { maybeHandleIngestBridge, scheduledIngestReconcile } from "./ingest-bridge";
// Task #81 (LK-rip Phase 6b) — voice-agent runtime. INERT behind VOICE_AGENT_PROVIDER==="wave": every new
// route/DO behavior is gated by voiceAgentEnabled(env); absent/anything-else → the 501 catch-all is unchanged.
import { voiceAgentEnabled, type AgentSessionConfig } from "./agent-session";
import { mediaTapEnabled } from "./media-tap";
// E3.P2/P4 (#127) — data-residency sink wiring (used only when RT_RESIDENCY is on). residency-rt.ts stays PURE.
import { captureSessionZone } from "./residency-sink";
// #82/#114 EX P2/P3 — cascade relay wiring (used only when RT_CASCADE is on). cascade.ts stays PURE; the
// env/cf glue lives in src/cascade-sink.ts. OFF/absent → the primary `idFromName(org:room)` path is unchanged.
import { resolveRelay } from "./cascade-sink";
// #138 Canary C3 — CF-runtime recorder proof. `fetchContainerEncode` is the SAME getContainer().fetch('/encode')
// call the live recorder makes; `defaultGetContainer` is the live DO-stub resolver. Used ONLY by the canary-gated
// /__canary/encode-proof route below (inert on prod: RECORDER_TARGET is unset there → the gate 404s).
import { fetchContainerEncode, defaultGetContainer } from "./encoders/recorder-target";
// Env shape, route-match constants, and the auth/deps/sink plumbing — extracted to a leaf module (task #56) so
// neither file exceeds 800 lines. dispatch-helpers.ts imports nothing from here (no cycle).
import {
	type Env,
	gatewayGate,
	liveEgressDeps,
	recordingWebhookDeps,
	buildPullSink,
	REALTIME_INTENTS,
	REALTIME_ROUTE,
	RECORDER_ROUTE,
	EGRESS_INTENTS,
	EGRESS_ROUTE,
	SAFE_SEGMENT,
	AGENT_DISPATCH_ROUTE,
	AGENT_DISPATCH_INTENTS,
	AGENT_EGRESS_ROUTE,
	AGENT_INGEST_ROUTE,
	PRESENCE_ROUTE,
	presenceEnabled,
	INGRESS_ROUTE,
	INGRESS_LIVE_PROTOCOLS,
	INGRESS_VM_PROTOCOLS,
	INGRESS_PROTOCOL_INTENTS,
	ROLES,
	ROOM_TYPE_VALUES,
	SAFE_ORG,
} from "./dispatch-helpers";

// Re-export Env so worker.ts (the only external consumer of this module) keeps importing it from here unchanged.
export type { Env } from "./dispatch-helpers";

/**
 * Main request dispatcher — the body of the worker fetch() handler. Extracted here so worker.ts stays under
 * 800 lines while keeping all DO/container re-exports (wrangler binding resolution) in the entry module.
 */
export async function dispatch(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
): Promise<Response> {
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

	// #138 Canary C3 — CF-runtime recorder proof (CANARY-ONLY; INERT on prod). Gated on RECORDER_TARGET==="cf",
	// which ONLY the canary worker sets (prod leaves it unset → default 'none' → this 404s and the byte-identical
	// 501/route behaviour is unchanged). Forwards a POSTed JPEG frame through the EXACT getContainer().fetch(
	// '/encode') path the live recorder uses, with negotiation armed (consumer descriptor = av1 decode + moq
	// transport), and returns the container's negotiated response headers. This proves CF's runtime wiring end to
	// end — getContainer resolution + the forwarded AV1_DEFAULT/NEGOTIATION_ENABLED envVars actually reach a live
	// RecorderContainer and drive negotiated output — which the 06-28 docker proof (container contract) did not cover.
	if (request.method === "POST" && url.pathname === "/__canary/encode-proof") {
		if (env.RECORDER_TARGET !== "cf" || !env.RECORDER) {
			return Response.json(
				{ error: "CANARY_PROOF_UNAVAILABLE", note: "RECORDER_TARGET!==cf or RECORDER unbound (prod-inert)" },
				{ status: 404 },
			);
		}
		const frame = new Uint8Array(await request.arrayBuffer());
		if (frame.byteLength === 0) return Response.json({ error: "EMPTY_FRAME", note: "POST a JPEG body" }, { status: 400 });
		const recorderNs = (env as unknown as { RECORDER: Parameters<typeof fetchContainerEncode>[0] }).RECORDER;
		const res = await fetchContainerEncode(recorderNs, defaultGetContainer, frame, {
			kind: "video",
			ts: 0,
			codec: "jpeg",
			negotiate: true,
			dst: { decode: [{ name: "av1", available: true }], transports: [{ protocol: "moq", activated: true }] },
		});
		const out = await res.arrayBuffer();
		return Response.json({
			ok: res.ok,
			status: res.status,
			framedBytesIn: frame.byteLength,
			bytesOut: out.byteLength,
			xOutputCodec: res.headers.get("x-output-codec"),
			xNegotiatedTransport: res.headers.get("x-negotiated-transport"),
			xEncoder: res.headers.get("x-encoder"),
			xOutputContainer: res.headers.get("x-output-container"),
			xAv1FallbackReason: res.headers.get("x-av1-fallback-reason"),
			xNegotiationReason: res.headers.get("x-negotiation-reason"),
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
							// E3.P2/P4 (#127): when residency is on, capture the session's zone from request.cf.continent
							// (one-line delegate to residency-sink; INERT when RT_RESIDENCY is off → byte-identical join).
							await captureSessionZone(env, request, result.meetingId);
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
	// The gateway-fronted WAVE-native recording-egress surface. WRAPS the proven PULL-mode recorder
	// (rtk-webhook pulls the finished file into our R2) — it does NOT build a raw-SFU tap (that stays
	// NOT_SPIKED/dormant). Behind the SAME internal-secret chokepoint as the other /rtk/* routes. DORMANT by
	// default: when pull mode is not configured (the live default — RT_RECORD!=="1" or creds/bindings absent)
	// every intent 501s (fail loud until the recorder is armed; never a faked file/silent ok).
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

	// ── E-ROOMS P4 (#73) client presence/state-sync + data channel — GET(upgrade) /v1/realtime/rooms/:room/presence.
	// INERT behind PRESENCE_ENABLED ([vars], default off → falls through to the generic route below, then the 501
	// catch-all — UNCHANGED). When ON, the SAME gateway-trust chokepoint as every paid route gates it; org is the
	// gateway-stamped x-wave-org, participant identity/role are gateway-stamped (query + x-wave-role, whitelisted).
	// The WS upgrade is FORWARDED to the room's DO (keyed org:room) which OWNS the hibernatable socket + broadcasts.
	const presMatch = url.pathname.match(PRESENCE_ROUTE);
	if (presMatch && presenceEnabled(env)) {
		const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
		if (denied) return denied;
		const org = request.headers.get("x-wave-org") ?? "";
		if (!SAFE_ORG.test(org)) {
			return Response.json(
				{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
				{ status: 400 },
			);
		}
		if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
			return Response.json(
				{ error: "UPGRADE_REQUIRED", message: "presence route requires a WebSocket upgrade" },
				{ status: 426 },
			);
		}
		if (!env.ROOM) {
			return Response.json(
				{ error: "REALTIME_NOT_CONFIGURED", message: "ROOM durable object binding is not configured" },
				{ status: 503 },
			);
		}
		const participantId = url.searchParams.get("participantId") ?? "";
		if (!SAFE_SEGMENT.test(participantId)) {
			return Response.json(
				{ error: "BAD_REQUEST", message: "presence requires a valid participantId query param" },
				{ status: 400 },
			);
		}
		const role = ROLES.has(request.headers.get("x-wave-role") ?? "")
			? (request.headers.get("x-wave-role") as string)
			: "viewer";
		const room = decodeURIComponent(presMatch[1]);
		const id = env.ROOM.idFromName(`${org}:${room}`);
		const stub = env.ROOM.get(id);
		// Forward the upgrade to the DO with identity in the query; the DO owns the socket (hibernation) so a
		// broadcast reaches every subscriber. Passing `request` as init preserves the Upgrade header + method.
		const fwd = new URL("https://room/presence");
		fwd.searchParams.set("participantId", participantId);
		fwd.searchParams.set("role", role);
		return stub.fetch(new Request(fwd.toString(), request));
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
		//
		// #82/#114 CASCADE (RT_CASCADE, default-off): on a regional JOIN, resolve the nearest-healthy region's
		// relay DO (a strict-suffix `org:room:region` key) and place it IN that region via get(id,{locationHint}).
		// resolveRelay returns null when RT_CASCADE is off, the continent is unknown, no relay is healthy, or the
		// ROOM binding is absent → the UNCHANGED primary `idFromName(org:room)` path. The ctx (org,room) is the
		// logical room — unchanged — so the relay (shared Room DO code) peers back to the primary and the
		// org-mismatch re-check still holds. Cascade applies to join only; other intents keep the primary path.
		const relay = intent === "join" ? resolveRelay(env, request, org, room) : null;
		const id = relay ? relay.id : env.ROOM.idFromName(`${org}:${room}`);
		const stub = relay ? env.ROOM.get(id, { locationHint: relay.locationHint }) : env.ROOM.get(id);
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

	// ── #53 IETF WHEP v1 egress — /v1/whep/subscribe + /v1/whep/resource/{id} ──
	// The egress SIBLING of the WHIP block above. INERT behind WHEP_EGRESS_ENABLED ([vars], default off): when
	// the flag is falsy/absent, this block is skipped entirely and a /v1/whep/* request falls through to the
	// 501 catch-all below — UNCHANGED. When ON, the SAME gateway-trust chokepoint as every other paid route
	// gates it (WAVE_INTERNAL_SECRET / x-wave-internal); org is the gateway-stamped x-wave-org. The handler
	// (src/whep.ts) resolves the source publisher session from the WHIP resource record (same-org only) and
	// talks to the CF Realtime SFU directly (signaling-only glue; media terminates at the SFU, never here).
	if (url.pathname.startsWith("/v1/whep/") && whepEgressEnabled(env as WhepEnv)) {
		const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
		if (denied) return denied;
		const org = request.headers.get("x-wave-org") ?? "";
		if (!SAFE_ORG.test(org)) {
			return Response.json(
				{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
				{ status: 400 },
			);
		}
		const whepRes = await handleWhep(request, env as WhepEnv, org);
		if (whepRes) return whepRes; // null → unrecognized /v1/whep/* sub-path → 501 fall-through below
	}

	// ── B1 (#91-a) CF Stream Live → SFU bridge — POST /v1/stream/bridge/webhook. INERT behind
	// STREAM_BRIDGE_ENABLED (null → falls through to the 501 catch-all). Self-auth (CF HMAC), control-only. ──
	const sbRes = await maybeHandleStreamBridge(request, env, ctx);
	if (sbRes) return sbRes;

	// ── #88 M2 Zoom RTMS → WAVE bridge — POST /zoom/rtms (control) + /zoom/rtms/ingest (SFU pull). INERT behind
	// WAVE_ZOOM_RTMS (null → 501 catch-all unchanged). Self-auth (x-zm-signature HMAC); a verified rtms_started/
	// stopped is routed to the meeting-keyed ZoomRtmsBridgeDO via zoomRtmsSeams (start dials Zoom + publishes into
	// the mapped room; stop tears it down). Unbound DO → no-op seams (still INERT). The dial-out arm is a ◆. ──
	const { onRtmsStarted: onZoomStarted, onRtmsStopped: onZoomStopped } = zoomRtmsSeams(env);
	const zoomRtmsRes = await maybeHandleZoomRtms(request, env, ctx, onZoomStarted, onZoomStopped);
	if (zoomRtmsRes) return zoomRtmsRes;
	const zoomIngestRes = await maybeHandleZoomRtmsIngest(request, env, gatewayGate);
	if (zoomIngestRes) return zoomIngestRes;

	// ── F (#55) Plane-2 direct any-protocol ingest → SFU bridge — POST /v1/ingest/{proto}/session +
	// DELETE /v1/ingest/{proto}/session/{room}. INERT behind INGEST_BRIDGE_ENABLED (null → 501 catch-all).
	// Gateway-forwarded (gatewayGate + x-wave-org server-side); binding-absent → typed *_BRIDGE_NOT_ACTIVATED 501. ──
	const ibRes = await maybeHandleIngestBridge(request, env, gatewayGate, SAFE_ORG);
	if (ibRes) return ibRes;

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
			// #76 P2 (arch A): additionally fold the agent's media-READ onto the room's single MediaTap. When
			// MEDIA_TAP_ENABLED is armed, tell the SAME-keyed ROOM DO to register an in-process MediaConsumer
			// for the agent's target track — no 2nd SFU subscription, no cross-DO frame transport. Fire-and-
			// forget + fail-open: NEVER affects the /bind response or the live AgentSessionDO echo path. INERT
			// when the flag is off (mediaTapEnabled false → no call at all).
			const agentTrack = typeof cfg.participantTrackName === "string" ? cfg.participantTrackName : "";
			if (adMatch[1] === "bind" && mediaTapEnabled(env) && env.ROOM && SAFE_SEGMENT.test(agentId) && SAFE_SEGMENT.test(agentTrack)) {
				const roomId = env.ROOM.idFromName(doKey);
				const roomStub = env.ROOM.get(roomId);
				const fold = roomStub
					.fetch(new Request(`https://room/agent-bind?agentId=${encodeURIComponent(agentId)}&participantTrackName=${encodeURIComponent(agentTrack)}`, { method: "POST" }))
					.catch(() => {});
				if (ctx) ctx.waitUntil(fold);
			}
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
}

/**
 * Cron handler body. Extracted alongside dispatch() so worker.ts stays under 800 lines.
 * Cron (wrangler.toml [triggers]) — durable recovery for PULL-mode recordings. RTK fires the UPLOADED
 * webhook once and never re-delivers after our 200, so a POST-ack pull failure would silently lose the
 * recording. handleRecordingWebhook enqueues a pending-pull record on failure; this reconcile re-pulls each
 * with a freshly resolved download URL (idempotent key) and clears it on success. Best-effort; never throws.
 */
export async function scheduledHandler(
	_event: ScheduledEvent,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	const sink = buildPullSink(env);
	if (sink && env.RT_MEETING_ORG) {
		ctx.waitUntil(
			reconcilePending(env.RT_MEETING_ORG, sink, (msg, fields) => console.log(JSON.stringify({ msg, ...fields }))),
		);
	}
	// B1 (#91-a) — CF Stream bridge lifecycle-poll backstop (INERT unless enabled + KV bound). Best-effort.
	scheduledStreamReconcile(env, ctx);
	// F (#55) — Plane-2 ingest-bridge pending-start reconcile backstop (INERT unless enabled + KV bound). Best-effort.
	scheduledIngestReconcile(env, ctx);
}
