// route-dispatch.ts — extracted fetch() router for wave-realtime-edge.
// worker.ts re-exports all DO/container classes (wrangler binding resolution) and delegates
// here for every request. Split from worker.ts (task #56) to keep the entry module under 800 lines;
// behavior is byte-identical to the original monolithic fetch() body.
import { join, turn, RtkError } from "./realtimekit";
import { selectEncoder } from "./encoders/factory";
import { verifyRecorderToken } from "./encoders/recorder-auth";
// B3 (#98) — IETF WHIP v1 ingest surface (/v1/whip/*). INERT behind WHIP_INGEST_ENABLED ([vars], default off
// → the 501 catch-all is unchanged). See src/whip.ts + whip-v1-frozen-contract.md §3/§4/§6-B3.
import { handleWhip, whipIngestEnabled, type WhipEnv } from "./whip";
// #53 — IETF WHEP v1 egress surface (/v1/whep/*), the egress SIBLING of WHIP. INERT behind WHEP_EGRESS_ENABLED
// ([vars], default off → the 501 catch-all is unchanged). See src/whep.ts + docs/whep-v1-frozen-contract.md.
import { handleWhep, whepEgressEnabled, type WhepEnv } from "./whep";
import { maybeHandleWhepSources, type WhepSourcesEnv } from "./whep-sources";
// W1 O3 (wre#289) egress destinations (#17 SSRF + #18 encrypt-at-rest). INERT: EGRESS_DEST_MGMT_ENABLED.
import { maybeHandleEgressDestinations, type EgressDestinationsEnv } from "./egress-destinations";
// W1 HUB egress arm/teardown (wave-zoom#46) — /v1/egress/arm + /v1/egress/teardown, the spoke-facing thin HTTP
// wrap of armExternalRtmpRestream (egress-arm.ts). INERT: EGRESS_ROUTER_ENABLED AND EGRESS_DEST_MGMT_ENABLED.
import { maybeHandleEgressArmRoute, type EgressArmRouteEnv } from "./egress-arm-route";
// B1 (#91-a) — CF Stream Live → SFU bridge CONTROL PLANE. INERT behind STREAM_BRIDGE_ENABLED. worker.ts only
// DELEGATES; all matching/auth/dispatch lives in src/stream-bridge.ts (+ cf-stream-bridge-frozen-contract).
import { maybeHandleStreamBridge } from "./stream-bridge";
// #88 M2 — Zoom RTMS webhook receiver (control-only). INERT behind WAVE_ZOOM_RTMS ([vars], default off →
// the 501 catch-all is unchanged). Self-verifies x-zm-signature; the outbound media WS dial-out is a ◆ follow-up.
import { maybeHandleZoomRtms } from "./zoom-rtms-bridge";
// #88 M2 — the outbound media DO seams + the SFU ingest-WS forward live in the DO module; route-dispatch only
// delegates (keeps this file under the 800-line gate). INERT unless WAVE_ZOOM_RTMS is armed.
import { zoomRtmsSeams, maybeHandleZoomRtmsIngest } from "./zoom-rtms-bridge-do";
// F (#55) — Direct (Plane-2) any-protocol ingest → SFU bridge CONTROL PLANE. INERT behind INGEST_BRIDGE_ENABLED
// + per-protocol container binding. worker.ts only DELEGATES; matching/auth/dispatch lives in src/ingest-bridge.ts
// (+ any-protocol-ingest-frozen-contract). Sibling of the Plane-1 cf-stream bridge; gateway-forwarded start trigger.
import { maybeHandleIngestBridge } from "./ingest-bridge";
// Task #81 (LK-rip Phase 6b) — voice-agent runtime. INERT behind VOICE_AGENT_PROVIDER==="wave": every new
// route/DO behavior is gated by voiceAgentEnabled(env); absent/anything-else → the 501 catch-all is unchanged.
import { voiceAgentEnabled, type AgentSessionConfig } from "./agent-session";
import { mediaTapEnabled } from "./media-tap";
// E3.P2/P4 (#127) — data-residency sink wiring (used only when RT_RESIDENCY is on). residency-rt.ts stays PURE.
// #82/#114 EX P2/P3 — cascade relay wiring (used only when RT_CASCADE is on). cascade.ts stays PURE; the
// env/cf glue lives in src/cascade-sink.ts. OFF/absent → the primary `idFromName(org:room)` path is unchanged.
import { resolveRelay } from "./cascade-sink";
// #138 Canary C3 — CF-runtime recorder proof (CANARY-ONLY, INERT on prod). Handler extracted to a leaf module so
// this router stays under the file-size gate; it 404s unless RECORDER_TARGET==="cf" (only the canary sets it).
import { maybeHandleCanaryProof } from "./canary-proof";
// #151 hosted recorder INGEST (PUT /v1/realtime/recording-ingest/*) — leaf module keeps this router under the
// file-size gate. INERT behind RECORDER_INGEST_ENABLED (default off → 501).
// Chassis passthrough (#473) — /_wave/* assets the landing shell references, plus the funnel beacon.
// The branded front door at GET "/" and the crawler/commerce surfaces moved to discovery-routes.ts
// (below), so `landingPage`/`DEFAULT_CSP` are no longer imported directly here.
import { chassisFetch, isChassisPath } from "./chassis-passthrough";
// Agent-discovery well-knowns (GET /llms.txt, /.well-known/agent-card.json, /skill.md) — see
// agent-discovery.ts for why these needed their own leaf module (they previously 501'd).
import { maybeHandleAgentDiscovery } from "./agent-discovery";
// Front-door + crawler/commerce surfaces: GET|HEAD "/" (the WOW landing, moved here 2026-09-03),
// /robots.txt, /sitemap.xml, /favicon.{ico,svg}, /.well-known/x402 — all on the chassis header floor.
import { maybeHandleDiscoveryRoutes } from "./discovery-routes";
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
	SAFE_SEGMENT,
	AGENT_DISPATCH_ROUTE,
	AGENT_DISPATCH_INTENTS,
	AGENT_EGRESS_ROUTE,
	AGENT_INGEST_ROUTE,
	AGENT_TTS_ROUTE,
	AGENT_AUDIO_IN_ROUTE,
	SAFE_ORG,
} from "./dispatch-helpers";
import { maybeHandleV1MediaRoutes } from "./route-v1-media";
import { maybeHandleRtkRoutes } from "./route-rtk";
// Item #5 — the channel pub/sub plane (spec/realtime.yaml). Route matching + dispatch live in their own
// leaf module (route-channel.ts, same seam route-rtk.ts/route-v1-media.ts already use) so this file stays
// under the size gate.
import { maybeHandleChannelRoutes } from "./route-channel";

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

	// Agent-discovery well-knowns — GET /llms.txt, /.well-known/agent-card.json, /skill.md. Checked
	// early (same tier as /health and "/") so they never fall through to the 501 catch-all below.
	const discovery = maybeHandleAgentDiscovery(request, url.pathname);
	if (discovery) return discovery;

	// Front-door + crawler/commerce surfaces — GET|HEAD "/", /robots.txt, /sitemap.xml,
	// /favicon.{ico,svg}, /.well-known/x402. Same tier as above: they must never reach the 501.
	//
	// ORDERING (deliberate, measured 2026-09-03 — this block runs BEFORE the chassis passthrough).
	// #473 landed chassis-passthrough.ts while this branch was open, and its CHASSIS_PATHS set also
	// claims /robots.txt, /sitemap.xml and /favicon.{ico,svg}. Those four are served here instead,
	// because the generic chassis rendering of two of them is wrong for THIS host:
	//   · /sitemap.xml — the chassis DEFAULT_SITEMAP_PATHS advertise /pricing, /status and
	//     /transparency. rt serves NONE of them; live receipts that day: rt.wave.online/status → 501,
	//     /transparency → 501, and the deployed sitemap listed both anyway. RT_SITEMAP_PATHS lists
	//     only "/" — the one indexable page rt actually has (see discovery-routes.ts).
	//   · /favicon.svg — the passthrough hands makeFetch `markSvg()`, which is the INLINE NAV mark:
	//     no `xmlns`, plus a hard-coded width="14" height="11" and aria-hidden. Served standalone as
	//     image/svg+xml that is not a renderable SVG document (a standalone SVG needs the xmlns).
	//     `fillFavicon()` — used here — is the chassis's standalone-favicon renderer and emits both.
	// /_wave/* (the shell's own consent.js, cta.js, nav.js and the funnel beacon) still falls through
	// to the chassis below, which is the only thing that can serve those. Both seams stay live.
	const discoveryFiles = maybeHandleDiscoveryRoutes(request, url.pathname);
	if (discoveryFiles) return discoveryFiles;

	// Chassis passthrough (public GETs only, plus POST /_wave/e for the funnel beacon).
	// See src/chassis-passthrough.ts for the full seam + audit receipt.
	if (isChassisPath(url.pathname, request.method)) {
		return chassisFetch(request, env, ctx);
	}

	// #138 Canary C3 — CF-runtime recorder proof (canary-only; prod-inert). Handler lives in canary-proof.ts.
	const canaryProof = await maybeHandleCanaryProof(request, url, env);
	if (canaryProof) return canaryProof;

	// RealtimeKit recording.statusUpdate webhook (RT-R-WH). PUBLIC by design — RTK calls it directly, so it
	// is intentionally NOT behind gatewayGate; it authenticates itself via the `rtk-signature` header
	// (RSA-SHA256 over the raw body, verified against CF's published key) before acting on anything.
	// No method/path guard: the family module's internal route checks ARE the guard (the moved
	// blocks match their own method+path exactly as they did inline — GET/PUT/POST all included).
	const rtk = await maybeHandleRtkRoutes(request, env, ctx);
	if (rtk) return rtk;

	const v1 = await maybeHandleV1MediaRoutes(request, env, ctx);
	if (v1) return v1;

	// ── Item #5 — channel pub/sub plane: GET /v1/connect (WS), POST/GET /v1/channels/{channel}/{publish,
	// presence,history}. Gateway-gated (x-wave-internal) + org-scoped (x-wave-org → ChannelDO id) exactly
	// like the ROOM plane above; INERT (falls through) when the CHANNEL binding is absent. ──
	const channelRes = await maybeHandleChannelRoutes(request, env, ctx);
	if (channelRes) return channelRes;

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
			console.log(JSON.stringify({ msg: "agent-egress-dial", tokenOk, hasTok: !!tok, upgrade: (request.headers.get("Upgrade") ?? "").toLowerCase(), track: atrack }));
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
			console.log(JSON.stringify({ msg: "agent-ingest-dial", tokenOk, hasTok: !!tok, upgrade: (request.headers.get("Upgrade") ?? "").toLowerCase(), track: atrack }));
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

		// 4) TTS playout WS: the CLIENT dials IN to receive the agent's TTS PCM directly (the direct-playback
		// path — bypasses the broken SFU ingest). Same capability-token auth as ingest (the ?t= the client
		// carries, OR the gateway-trust seal); the upgrade is forwarded to the SAME `${org}:${room}`
		// AgentSessionDO, which adds the socket to its broadcast sink set so speak() fans the TTS PCM to it.
		const atMatch = url.pathname.match(AGENT_TTS_ROUTE);
		if (atMatch) {
			const [, aorg, aroom, asession, atrack] = atMatch;
			if (![aorg, aroom, asession, atrack].every((s) => SAFE_SEGMENT.test(s)) || !env.AGENT_SESSION) {
				return Response.json({ error: "BAD_REQUEST", message: "invalid agent tts path or no AGENT_SESSION binding" }, { status: 400 });
			}
			const tok = url.searchParams.get("t");
			const tokenOk = !!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, aorg, asession, atrack, tok));
			if (!tokenOk) {
				const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
				if (denied) return denied;
			}
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
				return Response.json({ error: "UPGRADE_REQUIRED", message: "agent tts route requires a WebSocket upgrade" }, { status: 426 });
			}
			const id = env.AGENT_SESSION.idFromName(`${aorg}:${aroom}`);
			const stub = env.AGENT_SESSION.get(id);
			return stub.fetch(new Request(`https://agent/tts?sessionId=${encodeURIComponent(asession)}&trackName=${encodeURIComponent(atrack)}`, request));
		}

		// 5) Audio-IN WS: a NON-browser client (local CLI / on-prem / cloud) dials IN to STREAM the
		// participant's PCM to the agent — the headless "mic" that replaces the SFU egress leg. Same
		// capability-token auth; the upgrade is forwarded to the `${org}:${room}` AgentSessionDO, which
		// feeds each binary frame into the turn loop.
		const ainMatch = url.pathname.match(AGENT_AUDIO_IN_ROUTE);
		if (ainMatch) {
			const [, aorg, aroom, asession, atrack] = ainMatch;
			if (![aorg, aroom, asession, atrack].every((s) => SAFE_SEGMENT.test(s)) || !env.AGENT_SESSION) {
				return Response.json({ error: "BAD_REQUEST", message: "invalid agent audio-in path or no AGENT_SESSION binding" }, { status: 400 });
			}
			const tok = url.searchParams.get("t");
			const tokenOk = !!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, aorg, asession, atrack, tok));
			if (!tokenOk) {
				const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
				if (denied) return denied;
			}
			if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
				return Response.json({ error: "UPGRADE_REQUIRED", message: "agent audio-in route requires a WebSocket upgrade" }, { status: 426 });
			}
			const id = env.AGENT_SESSION.idFromName(`${aorg}:${aroom}`);
			const stub = env.AGENT_SESSION.get(id);
			return stub.fetch(new Request(`https://agent/audio-in?sessionId=${encodeURIComponent(asession)}&trackName=${encodeURIComponent(atrack)}`, request));
		}
	}

	return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
}

// Cron handler body — moved to its own leaf module (./scheduled) so this file stays under 800 lines.
// Re-exported here so worker.ts, the only external consumer, keeps its import unchanged.
export { scheduledHandler } from "./scheduled";
