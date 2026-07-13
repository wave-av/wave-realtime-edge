// recording-ingest-route.ts — #151 hosted self-host recorder INGEST handler, extracted to a leaf module so
// route-dispatch.ts stays under the file-size gate (same pattern as canary-proof.ts). route-dispatch only
// DELEGATES here; all matching/auth/forwarding for PUT /v1/realtime/recording-ingest/* lives in this file.
//
// FLOW: the self-host werift recorder (containers/rt-recorder) PULLs an SFU track, muxes a WebM/Matroska
// container, and STREAMS the finalized bytes here in one PUT. The RoomDO (keyed `${org}:${room}`) appends them
// to its single-writer RealtimeRecorder → the ONE canonical R2 object (SKIP tier). Dual-auth mirrors the WS
// recorder route: a pre-signed capability token (how the third-party recorder authenticates without our
// internal secret) OR x-wave-internal. INERT: gated by RECORDER_INGEST_ENABLED (default off → honest 501).
import { verifyRecorderToken } from "./encoders/recorder-auth";
import { type Env, gatewayGate, RECORDER_INGEST_ROUTE, recorderIngestEnabled, SAFE_SEGMENT } from "./dispatch-helpers";

/**
 * Handle PUT /v1/realtime/recording-ingest/:org/:room/:sessionId/:trackName. Returns a Response when the path
 * matches (incl. auth/gate rejections), or null when it does not match (the router falls through to the next
 * route). Never throws — a malformed request is a 400, not an exception up the dispatch chain.
 */
export async function maybeHandleRecordingIngest(request: Request, url: URL, env: Env): Promise<Response | null> {
	const m = request.method === "PUT" ? url.pathname.match(RECORDER_INGEST_ROUTE) : null;
	if (!m) return null;
	const [, iorg, iroom, isession, itrack] = m;
	if (![iorg, iroom, isession, itrack].every((s) => SAFE_SEGMENT.test(s)) || !env.ROOM) {
		return Response.json({ error: "BAD_REQUEST", message: "invalid ingest path or no ROOM binding" }, { status: 400 });
	}
	// AUTH — a valid scoped capability token (?t=, how the third-party recorder dials in without our internal
	// header) OR x-wave-internal. When WAVE_INTERNAL_SECRET is unset (local/test) the token check is false AND
	// gatewayGate enforces nothing → no enforcement, mirroring every other gated route.
	const tok = url.searchParams.get("t");
	const tokenOk =
		!!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, iorg, isession, itrack, tok));
	if (!tokenOk) {
		const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
		if (denied) return denied;
	}
	// Disarmed (default) → the route does not exist (config-no-silent-noop: honest 501, never a silent accept).
	if (!recorderIngestEnabled(env)) {
		return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
	}
	if (!request.body) {
		return Response.json({ error: "BAD_REQUEST", message: "recording-ingest requires a streamed body" }, { status: 400 });
	}
	// Stream the container body to the SAME DO (org:room) that owns the session's canonical object → the DO is the
	// single writer. Its R2Sink lazy-begins on the first byte (container magic → extension), appends the rest, and
	// finalizes → {key,bytes,container}. Streaming preserves memory (no full-container buffer in the isolate).
	const id = env.ROOM.idFromName(`${iorg}:${iroom}`);
	const stub = env.ROOM.get(id);
	return stub.fetch(
		new Request(
			`https://room/recording-ingest?org=${encodeURIComponent(iorg)}&sessionId=${encodeURIComponent(isession)}&trackName=${encodeURIComponent(itrack)}`,
			// duplex:"half" is REQUIRED when the body is a stream (undici + Workers). Cast: DOM RequestInit omits `duplex`.
			{ method: "POST", body: request.body, headers: { "Content-Type": "application/octet-stream" }, duplex: "half" } as RequestInit,
		),
	);
}
