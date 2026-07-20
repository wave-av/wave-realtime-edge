// B3 (#98) — IETF WHIP v1 ingest listener (draft-ietf-wish-whip-09) for wave-realtime-edge.
//
// FROZEN CONTRACT: ~/.claude/plans/wave-any-to-any-matrix/whip-v1-frozen-contract.md (v1.1), §3/§4/§6-B3/§9.
//
// This is the dedicated `/v1/whip/*` SFU-only ingest surface. It is DISTINCT from the LK-rip #42
// `/v1/realtime/ingress/whip/create` path (worker.ts INGRESS_ROUTE), which forwards to the Room DO `join`
// intent. The frozen contract (§3) pins THIS surface to talk to the CF Realtime SFU directly via SfuClient:
//   POST   /v1/whip/publish        (application/sdp offer) → newSession(offer)+pushTracks → 201 + SDP answer
//   PATCH  /v1/whip/resource/{id}  (application/trickle-ice-sdpfrag)                       → 204
//   DELETE /v1/whip/resource/{id}                                                          → 200 + stop meter
//
// MEDIA OFF THE WORKER (§9.2): ICE/DTLS/SRTP terminate at CF Realtime SFU (rtc.live.cloudflare.com). The
// Worker is signaling-only glue — it relays the publisher's SDP offer to the SFU verbatim and returns the
// SFU's SDP answer verbatim. It never decodes, transcodes, or carries media.
//
// TRUST (§3, §9.3): the request is gateway-forwarded; the edge trusts ONLY the gateway-injected
// `x-wave-internal` secret via the worker's EXISTING timingSafeEqual gateway-trust check (gatewayGate). No
// JWT. Org comes from the gateway-stamped `x-wave-org` header (server-side from the key, never body).
//
// INERT (§3 tail, §6-B3): the whole surface is reached ONLY when `WHIP_INGEST_ENABLED` is truthy. Off (the
// default) → the worker's 501 catch-all is unchanged. This module is never entered.

import { SfuClient, SfuError, type SessionDescription, type LocalTrack } from "./sfu.js";
import { type MeterEmitEnv } from "./metering.js";
import {
	whipRoomRecordingEnabled,
	publishViaRoom,
	finalizeViaRoom,
	WHIP_ROOM_HEADER,
	type WhipRoomEnv,
} from "./whip-room.js";
import {
	METER_WHIP_INGEST_MINUTES,
	resolveWhipMeter,
	buildWhipMeterLine,
	emitWhipTeardownMeter,
	WHIP_METER_OVERRIDE_HEADER,
} from "./whip-meter.js";
import {
	RESOURCE_ID,
	WHIP_KV_PREFIX,
	WHIP_KV_TTL_SECONDS,
	type WhipKv,
	type WhipResource,
	loadResource,
} from "./whip-resource.js";

// Re-export the two split-out clusters' public surface so every currently-importable symbol stays importable
// from src/whip.ts (whip-sweep.ts and tests import several of these directly).
export {
	METER_WHIP_INGEST_MINUTES,
	METER_STREAM_BRIDGE_MINUTES,
	WHIP_METER_OVERRIDE_HEADER,
	resolveWhipMeter,
	buildWhipMeterLine,
	emitWhipTeardownMeter,
	deliverWhipTeardownMeter,
} from "./whip-meter.js";
export { RESOURCE_ID, WHIP_KV_PREFIX, WHIP_KV_TTL_SECONDS, type WhipKv, type WhipResource, loadResource } from "./whip-resource.js";

/** The subset of worker Env this module reads. SFU creds gate liveness; meter/KV are optional → INERT. */
export interface WhipEnv extends MeterEmitEnv, WhipRoomEnv {
	WHIP_INGEST_ENABLED?: string | boolean; // [vars] flag — falsy/absent → surface is inert (worker 501s)
	WHIP_SWEEP_ENABLED?: string | boolean; // #35 [vars] flag — falsy/absent → the orphan sweeper never runs
	CF_CALLS_APP_ID?: string; // CF Realtime SFU app id (hex) — SfuClient appId
	CF_CALLS_APP_SECRET?: string; // CF Realtime SFU app secret (Bearer) — never logged/returned
	RT_MEETING_ORG?: WhipKv; // reused KV namespace: resourceId → {sessionId, org, startedAt}
	// #144 (#91-B): WHIP_ROOM_RECORDING (WhipRoomEnv) routes publish through a RoomDO room so the recorder +
	// negotiation apply. Default-off → the direct SFU path below is byte-identical. ROOM (WhipRoomEnv) is the
	// RoomDO binding used only on that flagged path.
}

/** Injectable seams so every path unit-tests with NO live network (mirrors the repo's __egressDeps pattern). */
export interface WhipDeps {
	/** Build the SFU client (live: from env creds). Throws SfuError(503) when unconfigured (fail-closed). */
	sfu(env: WhipEnv): SfuClient;
	/** Wall clock (epoch ms) — injectable so teardown-meter duration is deterministic in tests. */
	now(): number;
	/** Mint an opaque resource id. Injectable for deterministic tests; live uses crypto.randomUUID. */
	mintResourceId(): string;
	/** HTTP for the teardown meter emit (fail-open). Defaults to global fetch. */
	fetch: typeof fetch;
}

/** Live deps: SfuClient from env, real clock, crypto-random ids, global fetch. */
export function liveWhipDeps(): WhipDeps {
	return {
		sfu: (env) => new SfuClient({ appId: env.CF_CALLS_APP_ID ?? "", appSecret: env.CF_CALLS_APP_SECRET ?? "" }),
		now: () => Date.now(),
		mintResourceId: () => crypto.randomUUID().replace(/-/g, ""),
		fetch,
	};
}

/** True only when an operator has flipped the flag on. Default (absent/"0"/false) → surface stays inert. */
export function whipIngestEnabled(env: WhipEnv): boolean {
	const v = env.WHIP_INGEST_ENABLED;
	return v === true || v === "1" || v === "true";
}

/** Typed JSON error envelope (the 201 body is SDP; every error body is JSON, mirroring the spoke contract). */
function jsonError(code: string, message: string, status: number): Response {
	return Response.json({ error: code, message }, { status });
}

/**
 * POST /v1/whip/publish — the WHIP offer handshake. The request body is the publisher's SDP offer
 * (Content-Type: application/sdp). We relay it to the CF Realtime SFU verbatim (newSession(offer) +
 * pushTracks for any offered m-lines) and return the SFU's SDP answer as the 201 body, plus a
 * `Location: /v1/whip/resource/{resourceId}` the gateway rewrites to a gateway-absolute path.
 *
 * AUTH is enforced by the worker (gatewayGate) BEFORE this runs — org arrives via x-wave-org.
 */
/**
 * #240 branch-A: parse a WHIP offer's `m=` media sections into CF Realtime `LocalTrack` push requests.
 * Walks the SDP line-by-line; for each `audio`/`video` `m=` section, captures the FIRST `a=mid:<value>`
 * line that follows (stopping at the next `m=` line or end of SDP) and mints `{location:"local", mid,
 * trackName: "<resourceId>-<mid>"}`. `m=application` (datachannel) sections are ignored — they carry no
 * media track. An offer with no media sections (or none with a mid) returns `[]`; the caller must treat
 * that as a hard failure (nothing to push).
 */
export function parseOfferMids(offer: SessionDescription, resourceId: string): LocalTrack[] {
	const lines = offer.sdp.split(/\r?\n/);
	const tracks: LocalTrack[] = [];
	let inMediaSection = false;
	let sectionIsTrackable = false;
	let sectionHasMid = false;
	for (const line of lines) {
		if (line.startsWith("m=")) {
			inMediaSection = true;
			sectionHasMid = false;
			// m=<media> <port> <proto> ... — only "audio"/"video" kinds carry a pushable track.
			const kind = line.slice(2).split(" ")[0];
			sectionIsTrackable = kind === "audio" || kind === "video";
			continue;
		}
		if (!inMediaSection || !sectionIsTrackable || sectionHasMid) continue;
		const midMatch = /^a=mid:(\S+)/.exec(line);
		if (midMatch) {
			sectionHasMid = true;
			tracks.push({ location: "local", mid: midMatch[1], trackName: `${resourceId}-${midMatch[1]}` });
		}
	}
	return tracks;
}

async function handlePublish(request: Request, env: WhipEnv, deps: WhipDeps, org: string): Promise<Response> {
	const ct = (request.headers.get("content-type") ?? "").toLowerCase();
	if (!ct.includes("application/sdp")) {
		return jsonError("WHIP_UNSUPPORTED_MEDIA_TYPE", "WHIP publish requires Content-Type: application/sdp", 415);
	}
	const sdp = (await request.text()).trim();
	// Minimal SDP sanity: a valid offer starts with the version line `v=0`. Anything else is unparseable.
	if (!sdp || !/^v=0(\r?\n|\r)/.test(sdp)) {
		return jsonError("WHIP_UNPROCESSABLE_SDP", "request body is not a parseable SDP offer", 422);
	}
	// CF Realtime's SDP parser REJECTS an offer that does not end in a newline (400
	// invalid_session_description "Unable to parse SDP"). The .trim() above (needed for the v=0 guard)
	// strips the publisher's trailing CRLF, so re-terminate the relayed offer. Verified live: trimmed →
	// 400, trimmed + CRLF → 201 + answer. (#100B)
	const offer: SessionDescription = { type: "offer", sdp: sdp + "\r\n" };

	let sfu: SfuClient;
	try {
		sfu = deps.sfu(env); // throws SfuError(503) when CF Realtime app creds are absent (fail-closed)
	} catch (e) {
		const err = e instanceof SfuError ? e : new SfuError("REALTIME_NOT_CONFIGURED", "SFU unavailable", 503);
		return jsonError(err.code, err.message, err.status);
	}

	// Mint the resource id up front — the recorder-routed path (#144) derives its room key from it.
	const resourceId = deps.mintResourceId();
	if (!RESOURCE_ID.test(resourceId)) {
		return jsonError("REALTIME_ERROR", "failed to mint a resource id", 500);
	}

	try {
		// #144 (#91-B): when WHIP_ROOM_RECORDING is armed AND a ROOM binding is present, route the publish
		// through a RoomDO room so the room owns the recorder + capability negotiation (the bare newSession
		// below bypasses BOTH). FAIL-SOFT: publishViaRoom returns null on ANY failure → fall back to the proven
		// direct path (media-safety > recording, design §4). Default-off → the direct path is byte-identical.
		let sessionId: string;
		let answerSdp: string;
		const routed = whipRoomRecordingEnabled(env)
			? await publishViaRoom(env, org, offer, resourceId, request.headers.get(WHIP_ROOM_HEADER), `whip-${resourceId}`)
			: null;
		if (routed) {
			sessionId = routed.sessionId;
			answerSdp = routed.answerSdp;
		} else {
			// Direct path (#240 branch-A): newSession() with NO offer creates an EMPTY SFU session (no SDP
			// exchange yet) -- the prior "newSession(offer) pushes tracks in the same negotiation" comment was
			// WRONG (disproved live: GET /sessions/{id} came back {"tracks":[]} for the session's whole life,
			// which is why the orphan sweeper could never see an "alive" verdict). The publisher's offer is
			// instead relayed via pushTracks, which registers LOCAL tracks against the session AND carries the
			// SDP exchange -- so this is STILL exactly one offer/answer round-trip from the WHIP client's view
			// (no server-initiated renegotiation is introduced).
			//
			// Validate the offer BEFORE minting a CF session (#254 review): parseOfferMids used to run AFTER
			// newSession(), so a medialess offer left a real CF Realtime session behind with NO KV record —
			// unreachable to the sweeper (kv.list({prefix}) is its only discovery mechanism) and therefore
			// leaked forever.
			const localTracks = parseOfferMids(offer, resourceId);
			if (localTracks.length === 0) {
				return jsonError("REALTIME_UPSTREAM", "offer carried no media sections", 502);
			}
			const session = await sfu.newSession();
			// #254 review (finding 1): persist a sweeper-reachable KV record IMMEDIATELY after the CF session
			// exists, BEFORE pushTracks — not only after a successful push. A track-less session is NOT GC'd by
			// CF on idle (see sfu.ts sessionLiveness: CF keeps answering 200/tracks:[] indefinitely); the ONLY
			// cleanup path is the whip-sweep 410/disconnected flow (#240/#253), and that sweep discovers
			// candidates solely via kv.list({prefix}) — so a session with no KV row is invisible to it forever.
			// Deliberately conservative: lastSeenAt/disconnectedSince are left unset (never "verified alive"),
			// so if pushTracks below throws, the sweeper will find this record, confirm the SFU's 410, and
			// bill+drop it for at most the minimal `startedAt+1` window (whip-sweep.ts:197) rather than treating
			// it as ever having been live.
			const preMeter = resolveWhipMeter(request.headers.get(WHIP_METER_OVERRIDE_HEADER));
			const preRecord: WhipResource = { sessionId: session.sessionId, org, startedAt: deps.now(), meter: preMeter };
			try {
				await env.RT_MEETING_ORG?.put(`${WHIP_KV_PREFIX}${resourceId}`, JSON.stringify(preRecord), {
					expirationTtl: WHIP_KV_TTL_SECONDS,
				});
			} catch (e) {
				console.warn(`whip-resource pre-push persist failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
			}
			let pushed;
			try {
				pushed = await sfu.pushTracks(session.sessionId, localTracks, offer);
			} catch (e) {
				// newSession succeeded but pushTracks failed -> an orphaned empty session at the SFU. SfuClient
				// has no closeSession, so we can't close it inline; the KV record written above (pre-pushTracks)
				// is what makes this orphan sweeper-reachable — the sweeper will see the SFU 410, confirm it
				// persists past WHIP_GONE_CONFIRM_MS, and bill+drop it. Log loudly so this is visible, then
				// re-throw so the caller gets the real upstream error.
				console.warn(
					`whip-publish pushTracks failed after newSession sessionId=${session.sessionId} resourceId=${resourceId}: ${(e as Error)?.message ?? e}`,
				);
				throw e;
			}
			const answer = pushed.sessionDescription;
			if (!answer || answer.type !== "answer" || !answer.sdp) {
				return jsonError("REALTIME_UPSTREAM", "SFU did not return an SDP answer", 503);
			}
			sessionId = session.sessionId;
			answerSdp = answer.sdp;
		}

		// Persist the resourceId → session record so PATCH(trickle)/DELETE(teardown) can address this session.
		// Fail-open on the KV write: a persistence blip must not fail an otherwise-good publish (the resource
		// is still live in the SFU; teardown GCs on idle). Loud, never silent.
		// #91 B2: resolve the billing meter from the gateway-SEALED override header (allowset-validated) and
		// persist it, so the teardown bills the right SKU (bridge vs bare WHIP) however it later fires.
		const meter = resolveWhipMeter(request.headers.get(WHIP_METER_OVERRIDE_HEADER));
		const record: WhipResource = { sessionId, org, startedAt: deps.now(), meter, room: routed?.room };
		try {
			await env.RT_MEETING_ORG?.put(`${WHIP_KV_PREFIX}${resourceId}`, JSON.stringify(record), {
				expirationTtl: WHIP_KV_TTL_SECONDS,
			});
		} catch (e) {
			console.warn(`whip-resource persist failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
		}

		// 201 Created — body is the SFU's SDP answer; Location is an edge-relative WHIP resource path (the
		// gateway rewrites it to a gateway-absolute path so PATCH/DELETE stay on the control plane, §2/§3).
		return new Response(answerSdp, {
			status: 201,
			headers: {
				"content-type": "application/sdp",
				location: `/v1/whip/resource/${resourceId}`,
			},
		});
	} catch (e) {
		const err = e instanceof SfuError ? e : new SfuError("REALTIME_ERROR", "WHIP publish failed", 503);
		// SfuError default status is 502 for upstream; surface the SFU-unavailable class as 503 per §3.
		const status = err.status === 502 ? 503 : err.status;
		return jsonError(err.code, err.message, status);
	}
}

/**
 * PATCH /v1/whip/resource/{id} — trickle-ICE candidate update (application/trickle-ice-sdpfrag) → 204.
 * v1 is SFU-only: CF Realtime negotiates ICE end-to-end with the publisher, so an edge trickle PATCH is a
 * protocol-conformant ACK (204 No Content) — we validate the content-type and resource, and return 204.
 */
async function handlePatch(request: Request, env: WhipEnv, _deps: WhipDeps, resourceId: string): Promise<Response> {
	if (!RESOURCE_ID.test(resourceId)) {
		return jsonError("WHIP_BAD_RESOURCE", "invalid WHIP resource id", 404);
	}
	const ct = (request.headers.get("content-type") ?? "").toLowerCase();
	if (!ct.includes("application/trickle-ice-sdpfrag")) {
		return jsonError(
			"WHIP_UNSUPPORTED_MEDIA_TYPE",
			"WHIP trickle requires Content-Type: application/trickle-ice-sdpfrag",
			415,
		);
	}
	const resource = await loadResource(env.RT_MEETING_ORG, resourceId);
	if (!resource) {
		return jsonError("WHIP_RESOURCE_GONE", "no such WHIP resource", 404);
	}
	// 204 No Content — the trickle is accepted (SFU handles ICE end-to-end with the publisher).
	return new Response(null, { status: 204 });
}

/**
 * DELETE /v1/whip/resource/{id} — teardown. Close the SFU session (best-effort), emit the teardown meter
 * (`wave_whip_ingest_minutes`, idempotency = resourceId, FAIL-OPEN), and clear the resource record. 204.
 */
async function handleDelete(env: WhipEnv, deps: WhipDeps, resourceId: string): Promise<Response> {
	if (!RESOURCE_ID.test(resourceId)) {
		return jsonError("WHIP_BAD_RESOURCE", "invalid WHIP resource id", 404);
	}
	const resource = await loadResource(env.RT_MEETING_ORG, resourceId);
	// Idempotent teardown: an unknown/already-torn-down resource is a clean 204 (no error), never a 404 storm.
	if (!resource) return new Response(null, { status: 204 });

	// Emit the duration meter for the publish session FIRST (fail-open) — before we drop the record, so the
	// idempotency key (resourceId) and the org/startedAt are still in hand. A meter failure never blocks teardown.
	const line = buildWhipMeterLine(resourceId, resource.startedAt, deps.now(), resolveWhipMeter(resource.meter));
	await emitWhipTeardownMeter(env, resource.org, line, deps.fetch);

	// #145 (#91-C): finalize the raw-SFU recorder for this session. The room-routed publish (WHIP_ROOM_RECORDING)
	// opened a tap streaming to an R2 MULTIPART upload; only finalize() completes it into the canonical object.
	// WHIP DELETE has no `leave` to hang finalize on, so drive it here — to the SAME DO (`{org}:{room}`) that
	// holds the tap. Fail-open (media-safety > recording, §4): a finalize blip never blocks the 204 teardown.
	if (resource.room && whipRoomRecordingEnabled(env)) {
		await finalizeViaRoom(env, resource.org, resource.room, resource.sessionId);
	}

	// Best-effort: clear the resource record. CF Realtime sessions GC on idle, so there is no explicit
	// SFU close primitive to drive from here in v1 (closeTracks needs the published mids, which the edge
	// does not track — media is end-to-end). Dropping the record makes a re-DELETE the idempotent no-op above.
	try {
		await env.RT_MEETING_ORG?.delete(`${WHIP_KV_PREFIX}${resourceId}`);
	} catch (e) {
		console.warn(`whip-resource delete failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
	}
	return new Response(null, { status: 204 });
}

/** Route shapes for the WHIP surface. */
const PUBLISH_PATH = "/v1/whip/publish";
const RESOURCE_ROUTE = /^\/v1\/whip\/resource\/([^/]+)\/?$/;

/**
 * Dispatch a `/v1/whip/*` request to the right handler. Returns a Response, or null when the path is NOT a
 * WHIP path (so the worker continues its route chain / 501 fall-through). The caller (worker.ts) gates this
 * behind whipIngestEnabled() AND the gateway-trust check, so by the time we get here the request is trusted.
 *
 * @param org — the gateway-stamped org (x-wave-org), already validated by the worker.
 */
export async function handleWhip(
	request: Request,
	env: WhipEnv,
	org: string,
	deps: WhipDeps = liveWhipDeps(),
): Promise<Response | null> {
	const url = new URL(request.url);

	if (url.pathname === PUBLISH_PATH) {
		if (request.method !== "POST") {
			return jsonError("WHIP_METHOD_NOT_ALLOWED", "WHIP publish is POST", 405);
		}
		return handlePublish(request, env, deps, org);
	}

	const m = url.pathname.match(RESOURCE_ROUTE);
	if (m) {
		const resourceId = m[1];
		if (request.method === "PATCH") return handlePatch(request, env, deps, resourceId);
		if (request.method === "DELETE") return handleDelete(env, deps, resourceId);
		return jsonError("WHIP_METHOD_NOT_ALLOWED", "WHIP resource accepts PATCH (trickle) or DELETE (teardown)", 405);
	}

	return null; // not a WHIP path → worker continues (501 fall-through unchanged)
}
