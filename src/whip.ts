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
import {
	type MeterEmitEnv,
	isEmitProvisioned,
	type UsageEnvelope,
	type MeterLine,
} from "./metering.js";
import {
	whipRoomRecordingEnabled,
	publishViaRoom,
	finalizeViaRoom,
	WHIP_ROOM_HEADER,
	type WhipRoomEnv,
} from "./whip-room.js";

/** WHIP ingest meter — dedicated SKU per the frozen contract §4 (priced to STRIPE_PRICE_WHIP_INGEST_MIN). */
export const METER_WHIP_INGEST_MINUTES = "wave_whip_ingest_minutes";

/**
 * #91 B2 stream-bridge SKU — a CF-Stream→SFU bridge publish bills a DISTINCT meter (4-layer COGS; frozen
 * contract §4 / orphan-COGS-blocks-GA), NOT the bare WHIP-ingest SKU. The gateway directs it via the SEALED
 * `x-wave-meter-override` header (stamped server-side ONLY for a `stream-bridge:write` key; forward() strips
 * any client copy). The edge honors that override but ONLY against this allowset (validate-before-sink) — an
 * unknown/malformed value can NEVER be billed; it falls back to the default WHIP-ingest meter.
 */
export const METER_STREAM_BRIDGE_MINUTES = "wave_stream_bridge_minutes";
const WHIP_METER_OVERRIDE_ALLOW: ReadonlySet<string> = new Set([METER_STREAM_BRIDGE_MINUTES]);
export const WHIP_METER_OVERRIDE_HEADER = "x-wave-meter-override";

/** Resolve the session's billing meter from the gateway-sealed override: the named bridge SKU when present
 *  AND allowed, else the default wave_whip_ingest_minutes. Pure — the security boundary (the override is
 *  gateway-sealed, never client-supplied) is upstream; this is the defense-in-depth allowset check. */
export function resolveWhipMeter(override: string | null | undefined): string {
	return override && WHIP_METER_OVERRIDE_ALLOW.has(override) ? override : METER_WHIP_INGEST_MINUTES;
}

/** WHIP resource ids are opaque url-safe tokens we mint; guard before path interpolation / KV keys. */
export const RESOURCE_ID = /^[0-9a-zA-Z_-]{8,128}$/;
/** KV key prefix for the resourceId → session record (reuses the RT_MEETING_ORG namespace). */
export const WHIP_KV_PREFIX = "whip:";
/** Resource records outlive a publish session comfortably; TTL bounds the teardown window. */
export const WHIP_KV_TTL_SECONDS = 60 * 60 * 24; // 24h

/** The minimal KV surface this module needs (read/write/delete/list the resource record). Matches CF KV. */
export interface WhipKv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
	// #35: paginated enumeration for the orphan sweeper (same shape the other cron reconciles use).
	list(opts: {
		prefix?: string;
		cursor?: string;
	}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

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

/** A persisted WHIP resource record (resourceId → SFU session), used by PATCH/DELETE/sweep. */
export interface WhipResource {
	sessionId: string;
	org: string;
	startedAt: number; // epoch ms — start of the publish session, for the teardown meter
	// #145 (#91-C): the RoomDO room this publish routed through (WHIP_ROOM_RECORDING path). Persisted so DELETE
	// can address the SAME DO (`{org}:{room}`) to finalize the recorder. Absent ⇒ direct path (no recorder tap).
	room?: string;
	// #91 B2: the resolved billing meter, captured (gateway-sealed, allowset-validated) at publish so the
	// teardown bills the right SKU regardless of how it fires (client DELETE or cron). Absent ⇒ default WHIP.
	meter?: string;
	// #35: last epoch-ms at which the sweeper OBSERVED this session alive at the SFU. The orphan sweep bills
	// `startedAt → lastSeenAt` (never → sweep-time), so a session whose publisher died without a DELETE is
	// billed only for time it was demonstrably live. Absent ⇒ never probed; falls back to startedAt.
	lastSeenAt?: number;
	// #240/#257: epoch-ms at which the sweeper first saw a DEATH signal for this session — a 410 Gone
	// (disconnected), a 404/all-inactive ("gone"), or an aged once-alive "idle". No single probe is proven
	// terminal (a 410 can be a transient ICE drop, tracks can flap inactive→active, a 404 can be a mis-routed
	// probe), so the sweeper stamps this on the first death of any kind and only bills+drops once it PERSISTS
	// past WHIP_GONE_CONFIRM_MS. Cleared ONLY by an "alive" answer (200 + active tracks); an idle 200 no longer
	// clears it (#240 Phase-2), so a recovered blip is rescued while an ambiguous flap can never reset the clock.
	disconnectedSince?: number;
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
 * Build the one teardown meter line for a WHIP publish session. PURE (no I/O) so the accounting is
 * unit-testable. Duration is ceil-minutes (a started publish bills ≥1 min); idempotency = resourceId (§4).
 */
export function buildWhipMeterLine(
	resourceId: string,
	startedAt: number,
	endedAt: number,
	meter: string = METER_WHIP_INGEST_MINUTES,
): MeterLine {
	const ms = endedAt - startedAt;
	const minutes = ms > 0 ? Math.ceil(ms / 60_000) : 0;
	return { meter, meter_value: minutes, event_id: resourceId };
}

/**
 * Emit the WHIP ingest teardown meter to the gateway `/v1/internal/usage` (same ingest the realtime tap
 * uses). FAIL-OPEN (§4): a meter failure must never affect the teardown response. Idempotent on resourceId.
 * No-op (no network) when the emit is not provisioned (GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN) or value is 0.
 */
export async function emitWhipTeardownMeter(
	env: WhipEnv,
	org: string,
	line: MeterLine,
	fetchFn: typeof fetch,
): Promise<void> {
	// Fail-open by contract: the client-DELETE path must never be affected by a metering failure.
	await deliverWhipTeardownMeter(env, org, line, fetchFn);
}

/**
 * The same emit, but REPORTING whether the usage was actually accepted. The cron sweeper needs this: unlike
 * handleDelete (where the client is tearing down regardless and fail-open is correct), the sweeper OWNS the
 * only remaining record of that session's usage. If it dropped the record on an emit that silently failed,
 * the minutes would be lost forever — reintroducing the exact revenue leak this sweeper exists to close.
 * So the sweeper retries on the next tick instead, which is safe because the emit is idempotent on
 * event_id = resourceId.
 *
 * @returns true when the usage is durably accounted for (delivered, or nothing billable to deliver).
 */
export async function deliverWhipTeardownMeter(
	env: WhipEnv,
	org: string,
	line: MeterLine,
	fetchFn: typeof fetch,
): Promise<boolean> {
	if (!isEmitProvisioned(env)) return false; // INERT — nothing was recorded, so nothing may be dropped
	if (!(line.meter_value > 0)) return true; // nothing billable (zero/negative duration) → safe to drop
	const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
	const token = env.WAVE_SERVICE_TOKEN as string;
	const body: UsageEnvelope = { org, usage: line };
	try {
		const res = await fetchFn(`${base}/v1/internal/usage`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			console.warn(`whip-meter emit failed status=${res.status} org=${org}`); // loud, non-blocking
			return false;
		}
		return true;
	} catch (e) {
		console.warn(`whip-meter emit error org=${org}: ${(e as Error)?.message ?? e}`);
		return false;
	}
}

/** Parse a `whip:`-prefixed KV record back into a typed WhipResource, or null on absent/corrupt. Shared by
 *  handlePatch/handleDelete here and by the orphan sweeper (src/whip-sweep.ts). */
export async function loadResource(kv: WhipKv | undefined, resourceId: string): Promise<WhipResource | null> {
	if (!kv) return null;
	const raw = await kv.get(`${WHIP_KV_PREFIX}${resourceId}`);
	if (!raw) return null;
	try {
		const r = JSON.parse(raw) as Partial<WhipResource>;
		if (typeof r.sessionId === "string" && typeof r.org === "string" && typeof r.startedAt === "number") {
			return {
				sessionId: r.sessionId,
				org: r.org,
				startedAt: r.startedAt,
				meter: typeof r.meter === "string" ? r.meter : undefined,
				// #145: carry the room forward so DELETE can address the recorder-holding DO to finalize.
				room: typeof r.room === "string" ? r.room : undefined,
				// #35: carry the sweeper's last observed-alive stamp so an orphan teardown bills to it.
				lastSeenAt: typeof r.lastSeenAt === "number" ? r.lastSeenAt : undefined,
				// #240: carry the sweeper's first-410 stamp forward. Without this the confirm-window stamp is
				// write-only — every sweep re-loads the record with disconnectedSince stripped, re-stamps a fresh
				// clock, and the window NEVER closes, so a crashed orphan is never billed (proven live 2026-07-20).
				disconnectedSince: typeof r.disconnectedSince === "number" ? r.disconnectedSince : undefined,
			};
		}
	} catch {
		/* corrupt record → treat as absent */
	}
	return null;
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
