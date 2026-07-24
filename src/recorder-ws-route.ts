// recorder-ws-route.ts — RT-R9 raw-SFU recorder WS route, extracted to a leaf module so route-dispatch.ts
// stays under the file-size gate (same pattern as recording-ingest-route.ts / canary-proof.ts). route-dispatch
// only DELEGATES here; all matching/auth/WS-upgrade wiring for /v1/realtime/recorder/* lives in this file.
//
// The CF Realtime SFU dials OUT to this hibernatable WS endpoint (per the container-encoder adapter) and
// pushes ONE track's media as binary frames; each frame is forwarded to the room's DO tap. INERT: gated
// behind the SAME internal-secret chokepoint AND RT_RECORD==="1" — unarmed (live default) it 404s, so
// nothing can dial it. A non-Upgrade request → 426. The DO feed is fail-open (ctx.waitUntil), never blocks.
import { verifyRecorderToken } from "./encoders/recorder-auth";
import { type Env, gatewayGate, RECORDER_ROUTE, SAFE_SEGMENT } from "./dispatch-helpers";

/**
 * Handle the RT-R9 recorder WS dial-in at /v1/realtime/recorder/:org/:room/:sessionId/:trackName. Returns a
 * Response when the path matches (incl. auth/gate rejections), or null when it does not match (the router
 * falls through to the next route).
 */
export async function maybeHandleRecorderWs(
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext | undefined,
): Promise<Response | null> {
	const recMatch = url.pathname.match(RECORDER_ROUTE);
	if (!recMatch) return null;
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
	// #147 diagnostic — capture the shape of CF's dial-in so we can see WHY its WS handshake cancels
	// (create-adapter 503). NEVER logs the token VALUE (only presence) or any secret; the Sec-WebSocket-*
	// and Upgrade/Connection headers are handshake metadata, not secrets. Remove once #147 is diagnosed.
	console.warn(
		`recorder-dial org=${rorg} room=${rroom} session=${rsession} track=${rtrack} ` +
			`upgrade=${request.headers.get("Upgrade") ?? ""} connection=${request.headers.get("Connection") ?? ""} ` +
			`wsKey=${request.headers.get("Sec-WebSocket-Key") ? "1" : "0"} wsVer=${request.headers.get("Sec-WebSocket-Version") ?? ""} ` +
			`wsProto=${request.headers.get("Sec-WebSocket-Protocol") ?? ""} hasTok=${tok ? "1" : "0"} tokenOk=${tokenOk} rtRecord=${env.RT_RECORD ?? ""}`,
	);
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
