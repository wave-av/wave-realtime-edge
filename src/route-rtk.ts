// route-rtk — the /rtk/* and Room-intent route handlers, extracted from route-dispatch.ts
// (token-budget decompose, 2026-08-30) when that dispatcher crossed the ~6000-token gate and the law
// said DECOMPOSE, never trim. The seam is by ROUTE FAMILY: every RealtimeKit-admin route
// (recording-webhook, join, turn) and the Room-DO intent dispatch lives here; route-dispatch keeps the
// entry choreography (health, landing, canary) and every other protocol family.
import { join, turn, RtkError } from "./realtimekit";
import { pullRecordingConfigured } from "./encoders/managed";
import { handleRecordingWebhook } from "./rtk-webhook";
import { maybeHandleRecorderWs } from "./recorder-ws-route";
import { maybeHandleRtkEgress } from "./rtk-egress-route";
import { maybeHandleRecorderDispatch } from "./recorder-dispatch-route";
import { maybeHandleTranscriptRead } from "./transcript-route";
import { maybeHandleRecordingIngest } from "./recording-ingest-route";
import { selectEncoder } from "./encoders/factory";
import { resolveRelay } from "./cascade-sink";
import { captureSessionZone } from "./residency-sink";
import type { Env } from "./dispatch-helpers";
import {
	recordingWebhookDeps,
	buildPullSink,
	REALTIME_ROUTE,
	REALTIME_INTENTS,
	gatewayGate,
	SAFE_SEGMENT,
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

export async function maybeHandleRtkRoutes(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
): Promise<Response | undefined> {
	const url = new URL(request.url);

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
	// Delegated to a leaf module (recorder-ws-route.ts) so this router stays under the file-size gate.
	const recWs = await maybeHandleRecorderWs(request, url, env, ctx);
	if (recWs) return recWs;

	// ── #151 hosted recorder INGEST — PUT /v1/realtime/recording-ingest/:org/:room/:sessionId/:trackName ──
	// Delegated to a leaf module (recording-ingest-route.ts) so this router stays under the file-size gate.
	const recIngest = await maybeHandleRecordingIngest(request, url, env);
	if (recIngest) return recIngest;

	// ── #151 recorder-DISPATCH — POST /v1/realtime/recorder-dispatch/:org/:room ──
	// Internal orchestrator asks the RoomDO what to record + gets pre-signed ingest tokens. Leaf module keeps
	// this router under the file-size gate. Gateway-trust ONLY (it mints tokens); shares RECORDER_INGEST_ENABLED.
	const recDispatch = await maybeHandleRecorderDispatch(request, url, env);
	if (recDispatch) return recDispatch;

	// ── Voice-agent transcript retrieval — GET /v1/realtime/agents/transcripts/:org[/:room/:session] ──
	// Read + list the transcript JSON the AgentSessionDO persists to RT_RECORDINGS (history/finalize intents).
	// Same gateway-trust chokepoint as the recorder routes. Leaf module keeps this router under the file-size gate.
	const transcriptRead = await maybeHandleTranscriptRead(request, url, env);
	if (transcriptRead) return transcriptRead;

	// ── P5 CF-Calls SFU control plane — POST /v1/realtime/rooms/:room/:intent ──
	// Routed through the Room DO (per-org isolation: the DO id is keyed `${org}:${room}`), which runs the
	// Signaling orchestration (room.ts RoomDO.fetch). Same gateway-trust chokepoint as /rtk/*: when
	// WAVE_INTERNAL_SECRET is set, only the gateway (x-wave-internal) may reach these paid endpoints. Org
	// comes from the gateway-stamped `x-wave-org` header (the gateway authenticates + scopes upstream).
	const egRes = await maybeHandleRtkEgress(request, env);
	if (egRes) return egRes;

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

	return undefined;
}
