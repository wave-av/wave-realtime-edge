// recorder-dispatch-route.ts — #151 recorder-DISPATCH handler, a leaf module (like recording-ingest-route.ts)
// so route-dispatch.ts stays under the file-size gate. route-dispatch only DELEGATES here; all matching/auth/
// forwarding for POST /v1/realtime/recorder-dispatch/:org/:room lives in this file.
//
// FLOW: an INTERNAL orchestrator (the CF-Container spawner in prod, or the self-host recorder driver on-prem)
// asks the RoomDO (keyed `${org}:${room}`) "what should I record here?". The DO replies with one descriptor
// per registered track — each carrying a track-scoped ingest capability token minted with WAVE_INTERNAL_SECRET,
// which lives IN the DO, so the token verifies at the recording-ingest route by construction. The orchestrator
// then pulls each track and streams the muxed container back to that pre-signed ingest URL.
//
// AUTH: internal-ONLY. Unlike the ingest route there is NO capability-token alternative here — this endpoint
// MINTS tokens, so only the gateway (x-wave-internal) may call it. INERT: shares RECORDER_INGEST_ENABLED
// (default off → honest 501). Never returns any secret (the SFU app secret is read from the recorder's own env).
import { type Env, gatewayGate, RECORDER_DISPATCH_ROUTE, recorderIngestEnabled, SAFE_SEGMENT } from "./dispatch-helpers";

/**
 * Handle POST /v1/realtime/recorder-dispatch/:org/:room. Returns a Response when the path matches (incl. auth/
 * gate rejections), or null when it does not (the router falls through). Never throws — a malformed request is
 * a 400, not an exception up the dispatch chain.
 */
export async function maybeHandleRecorderDispatch(request: Request, url: URL, env: Env): Promise<Response | null> {
	const m = request.method === "POST" ? url.pathname.match(RECORDER_DISPATCH_ROUTE) : null;
	if (!m) return null;
	const [, dorg, droom] = m;
	if (![dorg, droom].every((s) => SAFE_SEGMENT.test(s)) || !env.ROOM) {
		return Response.json({ error: "BAD_REQUEST", message: "invalid dispatch path or no ROOM binding" }, { status: 400 });
	}
	// AUTH — gateway-trust ONLY (this MINTS ingest tokens; there is no self-authenticating token alternative).
	// When WAVE_INTERNAL_SECRET is unset (local/test) gatewayGate enforces nothing, mirroring every gated route.
	const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
	if (denied) return denied;
	// Disarmed (default) → the route does not exist (config-no-silent-noop: honest 501, never a silent accept).
	if (!recorderIngestEnabled(env)) {
		return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
	}
	// Forward to the SAME DO (org:room) that owns the room registry → it enumerates its registered tracks and
	// mints one token per track (secret lives there). GET-shaped POST (no body); the DO reads org/room from query.
	const id = env.ROOM.idFromName(`${dorg}:${droom}`);
	const stub = env.ROOM.get(id);
	return stub.fetch(
		new Request(
			`https://room/recorder-dispatch?org=${encodeURIComponent(dorg)}&room=${encodeURIComponent(droom)}`,
			{ method: "POST" },
		),
	);
}
