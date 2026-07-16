// #53 — IETF WHEP v1 egress listener (draft-murillo-whep-03) for wave-realtime-edge.
//
// FROZEN CONTRACT: docs/whep-v1-frozen-contract.md (v1.1), §0/§3/§4/§10. The egress SIBLING of src/whip.ts
// (the WHIP ingest surface) — same gateway-trust auth, same fail-closed-503, same KV-backed resource record +
// fail-open teardown meter, same INERT-behind-a-[vars]-flag posture.
//
// SOURCE = CLOUDFLARE STREAM WebRTC PLAYBACK (the repoint). The CF Realtime SFU does NOT expose a one-shot WHEP
// pull (its `pullTracks` is SFU-offer/client-answer, the INVERSE of single-shot WHEP — see git history). The
// correct one-shot WHEP path is Cloudflare Stream's WebRTC playback endpoint, which IS a standard WHEP server:
//   POST {webRTCPlayback.url}  (application/sdp offer)  → 201 + application/sdp ANSWER + Location (resource)
// The playback URL is deterministic and SECRET-FREE: `https://customer-{CODE}.cloudflarestream.com/{uid}/webRTC/play`
// (confirmed live via the Stream live_inputs API field `.result.webRTCPlayback.url`). The edge substitutes the
// live-input uid into `WHEP_SRC_URL_TEMPLATE` (the `{uid}` placeholder; customer code baked in) and RELAYS the
// subscriber's SDP offer to it verbatim, returning Stream's 201 + answer verbatim. ONE-SHOT — no renegotiation.
//
//   POST   /v1/whep/subscribe?resource={liveInputUid}   (application/sdp offer) → relay → 201 + SDP answer
//   PATCH  /v1/whep/resource/{id}  (application/trickle-ice-sdpfrag)            → proxy to Stream resource → 204
//   DELETE /v1/whep/resource/{id}                                              → proxy DELETE + stop meter → 204
//
// MEDIA OFF THE WORKER (§8.2): ICE/DTLS/SRTP terminate at Cloudflare Stream's WebRTC edge, never on the Worker.
// The Worker is signaling-only glue — it relays SDP verbatim and never decodes/transcodes/carries media.
//
// TRUST (§3, §9): gateway-forwarded; the edge trusts ONLY the gateway-injected `x-wave-internal` secret via the
// worker's EXISTING timingSafeEqual gateway-trust check (gatewayGate). No JWT. Org comes from the gateway-stamped
// `x-wave-org` header (server-side from the key, never body).
//
// TENANT ISOLATION (§3, §9.6): the source live-input's org is resolved SERVER-SIDE from the `stream-input-org:`
// KV record (the SAME uid→org map src/stream-bridge.ts uses for org attribution). A WHEP subscriber may pull a
// live input ONLY when its registered org equals the request org; an unknown OR cross-org input is an
// indistinguishable 404 (no existence leak across tenants). The uid is a LOOKUP KEY, never an org claim.
//
// INERT (§3 tail): the whole surface is reached ONLY when `WHEP_EGRESS_ENABLED` is truthy. Off (the default) →
// the worker's 501 catch-all is unchanged; this module is never entered. The Stream backend additionally
// fail-closes 503 when `USE_CLOUDFLARE_STREAM` is off or no playback URL is resolvable.

import {
	type MeterEmitEnv,
	isEmitProvisioned,
	type UsageEnvelope,
	type MeterLine,
} from "./metering.js";
import { STREAM_INPUT_ORG_PREFIX } from "./stream-bridge.js";

/** WHEP egress meter — dedicated SKU per the frozen contract §4 (priced to STRIPE_PRICE_WHEP_EGRESS_MIN). */
export const METER_WHEP_EGRESS_MINUTES = "wave_whep_egress_minutes";

/** WHEP resource ids are opaque url-safe tokens we mint; guard before path interpolation / KV keys. */
const RESOURCE_ID = /^[0-9a-zA-Z_-]{8,128}$/;
/** CF Stream live-input uids are 32-hex tokens; guard BEFORE interpolating into the playback URL (SSRF-safe). */
const LIVE_INPUT_UID = /^[0-9a-fA-F]{32}$/;
/** KV key prefix for the WHEP resourceId → session record (reuses the RT_MEETING_ORG namespace). */
const WHEP_KV_PREFIX = "whep:";
/** Resource records outlive a subscribe session comfortably; TTL bounds the teardown window. */
const WHEP_KV_TTL_SECONDS = 60 * 60 * 24; // 24h

/** The minimal KV surface this module needs (read/write/delete the resource record). Matches CF KV. */
export interface WhepKv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * The subset of worker Env this module reads. The Stream playback URL gates liveness; meter/KV are optional → INERT.
 * The CF Stream creds are `wrangler secret put` values (never in wrangler.toml). Both the `CF_STREAM_*` and the
 * legacy `CLOUDFLARE_STREAM_*` names are accepted (Doppler populates the latter); whichever is bound wins.
 */
export interface WhepEnv extends MeterEmitEnv {
	WHEP_EGRESS_ENABLED?: string | boolean; // [vars] flag — falsy/absent → surface is inert (worker 501s)
	USE_CLOUDFLARE_STREAM?: string | boolean; // Stream backend gate — falsy/absent → subscribe fails closed 503
	WHEP_SRC_URL_TEMPLATE?: string; // SECRET. Stream WHEP playback URL template with a `{uid}` placeholder (primary)
	CF_STREAM_CUSTOMER_CODE?: string; // SECRET. Stream customer subdomain code — fallback URL build when no template
	CF_STREAM_API_TOKEN?: string; // SECRET. Reserved: Stream-API source resolution/validation (not on the hot path)
	CLOUDFLARE_STREAM_CUSTOMER_CODE?: string; // accepted alias of CF_STREAM_CUSTOMER_CODE (Doppler-populated name)
	CLOUDFLARE_STREAM_API_TOKEN?: string; // accepted alias of CF_STREAM_API_TOKEN
	RT_MEETING_ORG?: WhepKv; // reused KV namespace: WHEP resourceId record + `stream-input-org:` source lookup
}

/** A persisted WHEP resource record (resourceId → the upstream Stream WHEP resource), used by PATCH/DELETE. */
interface WhepResource {
	streamResourceUrl: string; // absolute Stream WHEP resource URL (Stream's Location) — proxy PATCH/DELETE here
	liveInputUid: string;
	org: string;
	startedAt: number; // epoch ms — start of the subscribe session, for the teardown meter
}

/** Injectable seams so every path unit-tests with NO live network (mirrors src/whip.ts WhipDeps). */
export interface WhepDeps {
	/** Wall clock (epoch ms) — injectable so teardown-meter duration is deterministic in tests. */
	now(): number;
	/** Mint an opaque resource id. Injectable for deterministic tests; live uses crypto.randomUUID. */
	mintResourceId(): string;
	/** HTTP for the Stream WHEP relay AND the teardown meter emit. Defaults to global fetch. */
	fetch: typeof fetch;
}

/** Live deps: real clock, crypto-random ids, global fetch (the Stream relay + meter client). */
export function liveWhepDeps(): WhepDeps {
	return {
		now: () => Date.now(),
		mintResourceId: () => crypto.randomUUID().replace(/-/g, ""),
		// BIND to globalThis: the Workers/undici global `fetch` throws "Illegal invocation" when invoked as a
		// method (`deps.fetch(...)` sets `this` to the deps object). Storing it bound keeps `this` correct — this
		// is exactly what silently 503'd the live WHEP relay (upstream fetch threw, caught → REALTIME_UPSTREAM).
		fetch: fetch.bind(globalThis),
	};
}

/** True only when an operator has flipped the flag on. Default (absent/"0"/false) → surface stays inert. */
export function whepEgressEnabled(env: WhepEnv): boolean {
	const v = env.WHEP_EGRESS_ENABLED;
	return v === true || v === "1" || v === "true";
}

/** True when the CF Stream WebRTC playback backend is armed. Off → subscribe fails closed (503). */
export function useCloudflareStream(env: WhepEnv): boolean {
	const v = env.USE_CLOUDFLARE_STREAM;
	return v === true || v === "1" || v === "true";
}

/**
 * Resolve the Cloudflare Stream WHEP playback URL for a live-input uid. PURE (no I/O) — the playback URL is
 * deterministic and secret-free. Primary: substitute `{uid}` in `WHEP_SRC_URL_TEMPLATE`. Fallback: build it
 * from the customer code (`https://customer-{code}.cloudflarestream.com/{uid}/webRTC/play`). Null when neither
 * is configured (→ caller fail-closes 503). The uid is pre-validated (LIVE_INPUT_UID) before it reaches here.
 */
export function resolveStreamPlaybackUrl(env: WhepEnv, uid: string): string | null {
	const template = env.WHEP_SRC_URL_TEMPLATE;
	if (template && template.includes("{uid}")) return template.replaceAll("{uid}", uid);
	const code = env.CF_STREAM_CUSTOMER_CODE ?? env.CLOUDFLARE_STREAM_CUSTOMER_CODE;
	if (code) return `https://customer-${code}.cloudflarestream.com/${uid}/webRTC/play`;
	return null;
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
			typeof r.streamResourceUrl === "string" &&
			typeof r.liveInputUid === "string" &&
			typeof r.org === "string" &&
			typeof r.startedAt === "number"
		) {
			return {
				streamResourceUrl: r.streamResourceUrl,
				liveInputUid: r.liveInputUid,
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
 * Resolve the source live-input's org from the `stream-input-org:{uid}` KV record (the SAME uid→org map
 * src/stream-bridge.ts uses). Returns the org ONLY when the record exists AND equals the request org (§9.6
 * tenant isolation: cross-org/unknown is an indistinguishable null → 404, no existence leak). Null on absent.
 */
async function resolveInputOrgMatch(kv: WhepKv | undefined, uid: string, org: string): Promise<boolean> {
	if (!kv) return false;
	const stored = await kv.get(`${STREAM_INPUT_ORG_PREFIX}${uid}`);
	return typeof stored === "string" && stored === org;
}

/**
 * POST /v1/whep/subscribe — the WHEP offer handshake. The request body is the subscriber's SDP offer
 * (Content-Type: application/sdp). We resolve the source live-input's org (`?resource=` = the CF Stream live-input
 * uid) — same-org only (§9.6) — build the Stream WebRTC playback URL, RELAY the offer to it verbatim, and return
 * Stream's 201 + answer body verbatim plus a `Location: /v1/whep/resource/{resourceId}` the gateway rewrites to a
 * gateway-absolute path. ONE-SHOT: Stream's WHEP playback returns the final answer; no renegotiation header.
 *
 * AUTH is enforced by the worker (gatewayGate) BEFORE this runs — org arrives via x-wave-org.
 */
async function handleSubscribe(request: Request, env: WhepEnv, deps: WhepDeps, org: string): Promise<Response> {
	const url = new URL(request.url);
	const liveInputUid = url.searchParams.get("resource") ?? "";
	if (!LIVE_INPUT_UID.test(liveInputUid)) {
		return jsonError("WHEP_BAD_REQUEST", "WHEP subscribe requires a valid ?resource={liveInputUid}", 400);
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
	// Re-terminate the offer with CRLF (the .trim() above strips the subscriber's trailing newline). Harmless and
	// conformant for a standard WHEP server. (Mirrors src/whip.ts #100B.)
	const offerSdp = sdp + "\r\n";

	// Tenant isolation (§9.6): the live-input must be registered to THIS org. Unknown OR cross-org → 404.
	if (!(await resolveInputOrgMatch(env.RT_MEETING_ORG, liveInputUid, org))) {
		return jsonError("WHEP_SOURCE_NOT_FOUND", "no such WHEP source resource for this org", 404);
	}

	// Fail-CLOSED when the Stream backend is disabled OR no playback URL is resolvable (no creds).
	if (!useCloudflareStream(env)) {
		return jsonError("REALTIME_NOT_CONFIGURED", "Cloudflare Stream WebRTC playback is not enabled", 503);
	}
	const playbackUrl = resolveStreamPlaybackUrl(env, liveInputUid);
	if (!playbackUrl) {
		return jsonError("REALTIME_NOT_CONFIGURED", "no Cloudflare Stream WHEP playback URL is configured", 503);
	}

	// Relay the offer to Stream's WHEP playback endpoint VERBATIM. The playback URL carries no secret, so no
	// Authorization header is sent. Stream answers 201 + application/sdp + a Location (the WHEP resource).
	let upstream: Response;
	try {
		upstream = await deps.fetch(playbackUrl, {
			method: "POST",
			headers: { "content-type": "application/sdp" },
			body: offerSdp,
		});
	} catch (e) {
		console.warn(`whep-relay error uid=${liveInputUid}: ${(e as Error)?.message ?? e}`);
		return jsonError("REALTIME_UPSTREAM", "Cloudflare Stream WHEP relay failed", 503);
	}

	const answer = await upstream.text();
	if (upstream.status !== 201 || !answer) {
		console.warn(`whep-relay non-201 uid=${liveInputUid} status=${upstream.status}`);
		return jsonError("REALTIME_UPSTREAM", `Cloudflare Stream WHEP returned ${upstream.status}`, 503);
	}

	// Stream's Location is the WHEP resource the client/edge addresses for trickle/teardown. Resolve it absolute
	// (against the playback URL) so PATCH/DELETE can proxy to it. Absent → PATCH/DELETE degrade to a local ack.
	const loc = upstream.headers.get("location");
	let streamResourceUrl = "";
	if (loc) {
		try {
			streamResourceUrl = new URL(loc, playbackUrl).toString();
		} catch {
			streamResourceUrl = "";
		}
	}

	const resourceId = deps.mintResourceId();
	if (!RESOURCE_ID.test(resourceId)) {
		return jsonError("REALTIME_ERROR", "failed to mint a resource id", 500);
	}

	// Persist the resourceId → Stream-resource record so PATCH(trickle)/DELETE(teardown) can address it. Fail-open
	// on the KV write: a persistence blip must not fail an otherwise-good subscribe. Loud, never silent.
	const record: WhepResource = { streamResourceUrl, liveInputUid, org, startedAt: deps.now() };
	try {
		await env.RT_MEETING_ORG?.put(`${WHEP_KV_PREFIX}${resourceId}`, JSON.stringify(record), {
			expirationTtl: WHEP_KV_TTL_SECONDS,
		});
	} catch (e) {
		console.warn(`whep-resource persist failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
	}

	// 201 Created — body is Stream's SDP answer VERBATIM; Location is an edge-relative WHEP resource path (the
	// gateway rewrites it to a gateway-absolute path so PATCH/DELETE stay on the control plane, §2/§3). One-shot:
	// Stream's WHEP playback returns the final answer, so there is NO renegotiation header.
	return new Response(answer, {
		status: 201,
		headers: {
			"content-type": "application/sdp",
			location: `/v1/whep/resource/${resourceId}`,
		},
	});
}

/**
 * PATCH /v1/whep/resource/{id} — trickle-ICE candidate update (application/trickle-ice-sdpfrag) → 204.
 * Proxies the trickle frag to the upstream Stream WHEP resource (best-effort), then returns the protocol-conformant
 * 204 ACK. (Stream negotiates ICE end-to-end; a relay failure never fails the trickle ack.)
 */
async function handlePatch(request: Request, env: WhepEnv, deps: WhepDeps, resourceId: string): Promise<Response> {
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
	// Proxy the trickle frag to the Stream WHEP resource (best-effort, fail-open). The 204 ACK is the trickle
	// contract regardless of the upstream result (Stream handles ICE end-to-end with the subscriber).
	if (resource.streamResourceUrl) {
		const frag = await request.text();
		try {
			await deps.fetch(resource.streamResourceUrl, {
				method: "PATCH",
				headers: { "content-type": "application/trickle-ice-sdpfrag" },
				body: frag,
			});
		} catch (e) {
			console.warn(`whep-trickle proxy failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
		}
	}
	return new Response(null, { status: 204 });
}

/**
 * DELETE /v1/whep/resource/{id} — teardown. Emit the teardown meter (`wave_whep_egress_minutes`,
 * idempotency = resourceId, FAIL-OPEN), proxy a DELETE to the upstream Stream WHEP resource (best-effort), and
 * clear the resource record. 204.
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

	// Proxy the teardown to the upstream Stream WHEP resource (best-effort, fail-open) so Stream releases the
	// subscriber session promptly rather than waiting on idle-GC.
	if (resource.streamResourceUrl) {
		try {
			await deps.fetch(resource.streamResourceUrl, { method: "DELETE" });
		} catch (e) {
			console.warn(`whep-teardown proxy failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
		}
	}

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
