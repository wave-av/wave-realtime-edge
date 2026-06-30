// #53 — IETF WHEP v1 egress listener (draft-murillo-whep-03) for wave-realtime-edge.
//
// FROZEN CONTRACT: docs/whep-v1-frozen-contract.md (v1.0), §3/§4/§10. The egress SIBLING of src/whip.ts
// (the WHIP ingest surface) — same gateway-trust auth, same fail-closed-503-on-absent-SFU-creds, same
// KV-backed resource record + fail-open teardown meter, same INERT-behind-a-[vars]-flag posture.
//
// This is the dedicated `/v1/whep/*` SFU-only egress surface: a subscriber receives a published WebRTC
// stream over plain HTTP signaling.
//   POST   /v1/whep/subscribe?resource={whipResourceId}&track={trackName}  (application/sdp offer)
//                                                            → newSession(offer)+pullTracks → 201 + SDP answer
//   PATCH  /v1/whep/resource/{id}  (application/trickle-ice-sdpfrag)                                    → 204
//   DELETE /v1/whep/resource/{id}                                          → 204 + stop meter
//
// MEDIA OFF THE WORKER (§8.2): ICE/DTLS/SRTP terminate at CF Realtime SFU (rtc.live.cloudflare.com). The
// Worker is signaling-only glue — it relays SDP verbatim and never decodes/transcodes/carries media.
//
// TRUST (§3, §9): gateway-forwarded; the edge trusts ONLY the gateway-injected `x-wave-internal` secret via
// the worker's EXISTING timingSafeEqual gateway-trust check (gatewayGate). No JWT. Org comes from the
// gateway-stamped `x-wave-org` header (server-side from the key, never body).
//
// SOURCE RESOLUTION (§3, §0): the publisher's SFU session is resolved from the WHIP resource record
// (`whip:{resourceId}` in RT_MEETING_ORG) the WHIP publish persisted — the WHIP→WHEP join point. The source
// record's org MUST equal the request org (§9.6 tenant isolation; cross-org/unknown → indistinguishable 404).
//
// INERT (§3 tail): the whole surface is reached ONLY when `WHEP_EGRESS_ENABLED` is truthy. Off (the default)
// → the worker's 501 catch-all is unchanged. This module is never entered.
//
// ⚠️ SFU-API GAP (§10): CF Realtime pull is SFU-offer/client-answer (the inverse of single-shot WHEP).
// newSession(clientOffer) returns the transport answer, but the PULLED track is attached by a SECOND
// negotiation the single WHEP answer cannot carry; v1 signals this with `x-wave-whep-renegotiation: 1`.
// First-frame is therefore NOT proven by this surface alone — see the contract §10.

import { SfuClient, SfuError, type SessionDescription } from "./sfu.js";
import {
	type MeterEmitEnv,
	isEmitProvisioned,
	type UsageEnvelope,
	type MeterLine,
} from "./metering.js";

/** WHEP egress meter — dedicated SKU per the frozen contract §4 (priced to STRIPE_PRICE_WHEP_EGRESS_MIN). */
export const METER_WHEP_EGRESS_MINUTES = "wave_whep_egress_minutes";

/** WHEP resource ids are opaque url-safe tokens we mint; guard before path interpolation / KV keys. */
const RESOURCE_ID = /^[0-9a-zA-Z_-]{8,128}$/;
/** Track names (subscriber-supplied, §10 gap 2) are url-safe SFU identifiers; guard before relay. */
const TRACK_NAME = /^[0-9a-zA-Z_.:-]{1,256}$/;
/** KV key prefix for the WHEP resourceId → session record (reuses the RT_MEETING_ORG namespace). */
const WHEP_KV_PREFIX = "whep:";
/** The WHIP publish persists its resource record under this prefix — the WHEP source-resolution join point. */
const WHIP_KV_PREFIX = "whip:";
/** Resource records outlive a subscribe session comfortably; TTL bounds the teardown window. */
const WHEP_KV_TTL_SECONDS = 60 * 60 * 24; // 24h

/** The minimal KV surface this module needs (read/write/delete the resource record). Matches CF KV. */
export interface WhepKv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

/** The subset of worker Env this module reads. SFU creds gate liveness; meter/KV are optional → INERT. */
export interface WhepEnv extends MeterEmitEnv {
	WHEP_EGRESS_ENABLED?: string | boolean; // [vars] flag — falsy/absent → surface is inert (worker 501s)
	CF_CALLS_APP_ID?: string; // CF Realtime SFU app id (hex) — SfuClient appId
	CF_CALLS_APP_SECRET?: string; // CF Realtime SFU app secret (Bearer) — never logged/returned
	RT_MEETING_ORG?: WhepKv; // reused KV namespace: WHEP resourceId record + WHIP source lookup
}

/** A persisted WHEP resource record (resourceId → subscriber SFU session), used by PATCH/DELETE. */
interface WhepResource {
	subscriberSessionId: string;
	publisherSessionId: string;
	trackName: string;
	org: string;
	startedAt: number; // epoch ms — start of the subscribe session, for the teardown meter
}

/** Shape of the WHIP publish record we read to resolve the source publisher session (whip.ts WhipResource). */
interface WhipSourceRecord {
	sessionId: string;
	org: string;
}

/** Injectable seams so every path unit-tests with NO live network (mirrors src/whip.ts WhipDeps). */
export interface WhepDeps {
	/** Build the SFU client (live: from env creds). Throws SfuError(503) when unconfigured (fail-closed). */
	sfu(env: WhepEnv): SfuClient;
	/** Wall clock (epoch ms) — injectable so teardown-meter duration is deterministic in tests. */
	now(): number;
	/** Mint an opaque resource id. Injectable for deterministic tests; live uses crypto.randomUUID. */
	mintResourceId(): string;
	/** HTTP for the teardown meter emit (fail-open). Defaults to global fetch. */
	fetch: typeof fetch;
}

/** Live deps: SfuClient from env, real clock, crypto-random ids, global fetch. */
export function liveWhepDeps(): WhepDeps {
	return {
		sfu: (env) => new SfuClient({ appId: env.CF_CALLS_APP_ID ?? "", appSecret: env.CF_CALLS_APP_SECRET ?? "" }),
		now: () => Date.now(),
		mintResourceId: () => crypto.randomUUID().replace(/-/g, ""),
		fetch,
	};
}

/** True only when an operator has flipped the flag on. Default (absent/"0"/false) → surface stays inert. */
export function whepEgressEnabled(env: WhepEnv): boolean {
	const v = env.WHEP_EGRESS_ENABLED;
	return v === true || v === "1" || v === "true";
}

/** Typed JSON error envelope (the 201 body is SDP; every error body is JSON, mirroring the spoke contract). */
function jsonError(code: string, message: string, status: number): Response {
	return Response.json({ error: code, message }, { status });
}

/**
 * Build the one teardown meter line for a WHEP subscribe session. PURE (no I/O) so the accounting is
 * unit-testable. Duration is ceil-minutes (a started subscribe bills ≥1 min); idempotency = resourceId (§4).
 */
export function buildWhepMeterLine(resourceId: string, startedAt: number, endedAt: number): MeterLine {
	const ms = endedAt - startedAt;
	const minutes = ms > 0 ? Math.ceil(ms / 60_000) : 0;
	return { meter: METER_WHEP_EGRESS_MINUTES, meter_value: minutes, event_id: resourceId };
}

/**
 * Emit the WHEP egress teardown meter to the gateway `/v1/internal/usage` (same ingest the WHIP teardown +
 * realtime tap use). FAIL-OPEN (§4): a meter failure must never affect the teardown response. Idempotent on
 * resourceId. No-op (no network) when the emit is not provisioned (GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN) or
 * value is 0.
 */
export async function emitWhepTeardownMeter(
	env: WhepEnv,
	org: string,
	line: MeterLine,
	fetchFn: typeof fetch,
): Promise<void> {
	if (!isEmitProvisioned(env)) return; // INERT until operator provisions URL + token
	if (!(line.meter_value > 0)) return; // nothing billable (zero/negative duration)
	const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
	const token = env.WAVE_SERVICE_TOKEN as string;
	const body: UsageEnvelope = { org, usage: line };
	try {
		const res = await fetchFn(`${base}/v1/internal/usage`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
		if (!res.ok) console.warn(`whep-meter emit failed status=${res.status} org=${org}`); // loud, non-blocking
	} catch (e) {
		// Fail-open: a usage emit must NEVER affect the live/teardown path (media-safety > metering).
		console.warn(`whep-meter emit error org=${org}: ${(e as Error)?.message ?? e}`);
	}
}

/** Parse a `whep:`-prefixed KV record back into a typed WhepResource, or null on absent/corrupt. */
async function loadResource(kv: WhepKv | undefined, resourceId: string): Promise<WhepResource | null> {
	if (!kv) return null;
	const raw = await kv.get(`${WHEP_KV_PREFIX}${resourceId}`);
	if (!raw) return null;
	try {
		const r = JSON.parse(raw) as Partial<WhepResource>;
		if (
			typeof r.subscriberSessionId === "string" &&
			typeof r.publisherSessionId === "string" &&
			typeof r.trackName === "string" &&
			typeof r.org === "string" &&
			typeof r.startedAt === "number"
		) {
			return {
				subscriberSessionId: r.subscriberSessionId,
				publisherSessionId: r.publisherSessionId,
				trackName: r.trackName,
				org: r.org,
				startedAt: r.startedAt,
			};
		}
	} catch {
		/* corrupt record → treat as absent */
	}
	return null;
}

/**
 * Resolve the source publisher SFU session from a WHIP resource record (`whip:{resourceId}`). Returns the
 * publisher sessionId ONLY when the record exists AND is owned by the SAME org (§9.6 tenant isolation:
 * cross-org/unknown is an indistinguishable null → 404 to the caller, no existence leak). Null on absent/corrupt.
 */
async function resolvePublisherSession(kv: WhepKv | undefined, resourceId: string, org: string): Promise<string | null> {
	if (!kv) return null;
	const raw = await kv.get(`${WHIP_KV_PREFIX}${resourceId}`);
	if (!raw) return null;
	try {
		const r = JSON.parse(raw) as Partial<WhipSourceRecord>;
		if (typeof r.sessionId === "string" && typeof r.org === "string" && r.org === org) {
			return r.sessionId;
		}
	} catch {
		/* corrupt record → treat as absent */
	}
	return null;
}

/**
 * POST /v1/whep/subscribe — the WHEP offer handshake. The request body is the subscriber's SDP offer
 * (Content-Type: application/sdp). We resolve the source publisher session from the WHIP resource id
 * (`?resource=`), create the subscriber's SFU session FROM the offer (newSession, verbatim SDP passthrough),
 * pull the named published track (`?track=`) into it, and return the SFU's SDP answer as the 201 body plus a
 * `Location: /v1/whep/resource/{resourceId}` the gateway rewrites to a gateway-absolute path.
 *
 * ⚠️ §10 gap 1: CF Realtime pull is SFU-offer/client-answer. The 201 answer is the transport answer; the
 * pulled track may need a follow-up renegotiation (signalled via `x-wave-whep-renegotiation: 1`). First-frame
 * over the single-shot answer is therefore not guaranteed — see the contract §10.
 *
 * AUTH is enforced by the worker (gatewayGate) BEFORE this runs — org arrives via x-wave-org.
 */
async function handleSubscribe(request: Request, env: WhepEnv, deps: WhepDeps, org: string): Promise<Response> {
	const url = new URL(request.url);
	const sourceResource = url.searchParams.get("resource") ?? "";
	const trackName = url.searchParams.get("track") ?? "";
	if (!RESOURCE_ID.test(sourceResource) || !TRACK_NAME.test(trackName)) {
		return jsonError(
			"WHEP_BAD_REQUEST",
			"WHEP subscribe requires a valid ?resource={whipResourceId} and ?track={trackName}",
			400,
		);
	}

	const ct = (request.headers.get("content-type") ?? "").toLowerCase();
	if (!ct.includes("application/sdp")) {
		return jsonError("WHEP_UNSUPPORTED_MEDIA_TYPE", "WHEP subscribe requires Content-Type: application/sdp", 415);
	}
	const sdp = (await request.text()).trim();
	// Minimal SDP sanity: a valid offer starts with the version line `v=0`. Anything else is unparseable.
	if (!sdp || !/^v=0(\r?\n|\r)/.test(sdp)) {
		return jsonError("WHEP_UNPROCESSABLE_SDP", "request body is not a parseable SDP offer", 422);
	}
	// CF Realtime's SDP parser REJECTS an offer that does not end in a newline (400 "Unable to parse SDP").
	// The .trim() above (needed for the v=0 guard) strips the subscriber's trailing CRLF, so re-terminate the
	// relayed offer. (Mirrors src/whip.ts #100B.)
	const offer: SessionDescription = { type: "offer", sdp: sdp + "\r\n" };

	// Resolve the source publisher session from the WHIP resource record (same-org only — §9.6). An unknown or
	// cross-org source is an indistinguishable 404 (no existence leak across tenants).
	const publisherSessionId = await resolvePublisherSession(env.RT_MEETING_ORG, sourceResource, org);
	if (!publisherSessionId) {
		return jsonError("WHEP_SOURCE_NOT_FOUND", "no such WHEP source resource for this org", 404);
	}

	let sfu: SfuClient;
	try {
		sfu = deps.sfu(env); // throws SfuError(503) when CF Realtime app creds are absent (fail-closed)
	} catch (e) {
		const err = e instanceof SfuError ? e : new SfuError("REALTIME_NOT_CONFIGURED", "SFU unavailable", 503);
		return jsonError(err.code, err.message, err.status);
	}

	try {
		// newSession(offer) creates the subscriber's SFU session FROM the offer and returns the SFU's transport
		// answer (verbatim SDP passthrough).
		const session = await sfu.newSession(offer);
		const answer = session.sessionDescription;
		if (!answer || answer.type !== "answer" || !answer.sdp) {
			return jsonError("REALTIME_UPSTREAM", "SFU did not return an SDP answer", 503);
		}

		// Attach the published track: pull it from the PUBLISHER's session into the subscriber's session. The SFU
		// may return requiresImmediateRenegotiation (an SFU offer the client answers) — §10 gap 1. We surface that
		// to the caller via a response header; we do NOT throw on it (the transport answer is still valid).
		let renegotiationRequired = false;
		try {
			const pull = await sfu.pullTracks(session.sessionId, [
				{ location: "remote", sessionId: publisherSessionId, trackName },
			]);
			renegotiationRequired = pull.requiresImmediateRenegotiation === true;
		} catch (e) {
			const err = e instanceof SfuError ? e : new SfuError("REALTIME_ERROR", "WHEP pull failed", 503);
			const status = err.status === 502 ? 503 : err.status;
			return jsonError(err.code, err.message, status);
		}

		const resourceId = deps.mintResourceId();
		if (!RESOURCE_ID.test(resourceId)) {
			return jsonError("REALTIME_ERROR", "failed to mint a resource id", 500);
		}

		// Persist the resourceId → session record so PATCH(trickle)/DELETE(teardown) can address this session.
		// Fail-open on the KV write: a persistence blip must not fail an otherwise-good subscribe. Loud, never silent.
		const record: WhepResource = {
			subscriberSessionId: session.sessionId,
			publisherSessionId,
			trackName,
			org,
			startedAt: deps.now(),
		};
		try {
			await env.RT_MEETING_ORG?.put(`${WHEP_KV_PREFIX}${resourceId}`, JSON.stringify(record), {
				expirationTtl: WHEP_KV_TTL_SECONDS,
			});
		} catch (e) {
			console.warn(`whep-resource persist failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
		}

		// 201 Created — body is the SFU's SDP answer; Location is an edge-relative WHEP resource path (the
		// gateway rewrites it to a gateway-absolute path so PATCH/DELETE stay on the control plane, §2/§3).
		return new Response(answer.sdp, {
			status: 201,
			headers: {
				"content-type": "application/sdp",
				location: `/v1/whep/resource/${resourceId}`,
				"x-wave-whep-renegotiation": renegotiationRequired ? "1" : "0",
			},
		});
	} catch (e) {
		const err = e instanceof SfuError ? e : new SfuError("REALTIME_ERROR", "WHEP subscribe failed", 503);
		// SfuError default status is 502 for upstream; surface the SFU-unavailable class as 503 per §3.
		const status = err.status === 502 ? 503 : err.status;
		return jsonError(err.code, err.message, status);
	}
}

/**
 * PATCH /v1/whep/resource/{id} — trickle-ICE candidate update (application/trickle-ice-sdpfrag) → 204.
 * v1 is SFU-only: CF Realtime negotiates ICE end-to-end with the subscriber, so an edge trickle PATCH is a
 * protocol-conformant ACK (204 No Content) — we validate the content-type and resource, and return 204.
 */
async function handlePatch(request: Request, env: WhepEnv, _deps: WhepDeps, resourceId: string): Promise<Response> {
	if (!RESOURCE_ID.test(resourceId)) {
		return jsonError("WHEP_BAD_RESOURCE", "invalid WHEP resource id", 404);
	}
	const ct = (request.headers.get("content-type") ?? "").toLowerCase();
	if (!ct.includes("application/trickle-ice-sdpfrag")) {
		return jsonError(
			"WHEP_UNSUPPORTED_MEDIA_TYPE",
			"WHEP trickle requires Content-Type: application/trickle-ice-sdpfrag",
			415,
		);
	}
	const resource = await loadResource(env.RT_MEETING_ORG, resourceId);
	if (!resource) {
		return jsonError("WHEP_RESOURCE_GONE", "no such WHEP resource", 404);
	}
	// 204 No Content — the trickle is accepted (SFU handles ICE end-to-end with the subscriber).
	return new Response(null, { status: 204 });
}

/**
 * DELETE /v1/whep/resource/{id} — teardown. Emit the teardown meter (`wave_whep_egress_minutes`,
 * idempotency = resourceId, FAIL-OPEN), and clear the resource record. 204. CF Realtime sessions GC on idle,
 * so there is no explicit SFU close primitive to drive from here in v1.
 */
async function handleDelete(env: WhepEnv, deps: WhepDeps, resourceId: string): Promise<Response> {
	if (!RESOURCE_ID.test(resourceId)) {
		return jsonError("WHEP_BAD_RESOURCE", "invalid WHEP resource id", 404);
	}
	const resource = await loadResource(env.RT_MEETING_ORG, resourceId);
	// Idempotent teardown: an unknown/already-torn-down resource is a clean 204 (no error), never a 404 storm.
	if (!resource) return new Response(null, { status: 204 });

	// Emit the duration meter for the subscribe session FIRST (fail-open) — before we drop the record, so the
	// idempotency key (resourceId) and the org/startedAt are still in hand. A meter failure never blocks teardown.
	const line = buildWhepMeterLine(resourceId, resource.startedAt, deps.now());
	await emitWhepTeardownMeter(env, resource.org, line, deps.fetch);

	// Best-effort: clear the resource record. Dropping it makes a re-DELETE the idempotent no-op above.
	try {
		await env.RT_MEETING_ORG?.delete(`${WHEP_KV_PREFIX}${resourceId}`);
	} catch (e) {
		console.warn(`whep-resource delete failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
	}
	return new Response(null, { status: 204 });
}

/** Route shapes for the WHEP surface. */
const SUBSCRIBE_PATH = "/v1/whep/subscribe";
const RESOURCE_ROUTE = /^\/v1\/whep\/resource\/([^/]+)\/?$/;

/**
 * Dispatch a `/v1/whep/*` request to the right handler. Returns a Response, or null when the path is NOT a
 * WHEP path (so the worker continues its route chain / 501 fall-through). The caller (route-dispatch.ts) gates
 * this behind whepEgressEnabled() AND the gateway-trust check, so by the time we get here the request is trusted.
 *
 * @param org — the gateway-stamped org (x-wave-org), already validated by the worker.
 */
export async function handleWhep(
	request: Request,
	env: WhepEnv,
	org: string,
	deps: WhepDeps = liveWhepDeps(),
): Promise<Response | null> {
	const url = new URL(request.url);

	if (url.pathname === SUBSCRIBE_PATH) {
		if (request.method !== "POST") {
			return jsonError("WHEP_METHOD_NOT_ALLOWED", "WHEP subscribe is POST", 405);
		}
		return handleSubscribe(request, env, deps, org);
	}

	const m = url.pathname.match(RESOURCE_ROUTE);
	if (m) {
		const resourceId = m[1];
		if (request.method === "PATCH") return handlePatch(request, env, deps, resourceId);
		if (request.method === "DELETE") return handleDelete(env, deps, resourceId);
		return jsonError("WHEP_METHOD_NOT_ALLOWED", "WHEP resource accepts PATCH (trickle) or DELETE (teardown)", 405);
	}

	return null; // not a WHEP path → worker continues (501 fall-through unchanged)
}
