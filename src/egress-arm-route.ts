/**
 * W1 HUB egress arm/teardown (epic wave-zoom#46, W1; Fable-resolved Option-1 spoke-orchestrated design). The THIN
 * HTTP surface the wave-zoom SPOKE calls to arm/teardown an external RTMP restream of an already-armed CF Live
 * input — wrapping the existing INERT `armExternalRtmpRestream` (egress-arm.ts) and the new `deleteOutput`
 * (egress-cf-stream-live-output-client.ts). RTMP ONLY — SRT stays flag-off (O2's arm exists but is not wired here).
 *
 * TWO VERBS:
 *   • POST /v1/egress/arm      — body `{destId, sourceUid}`. `sourceUid` is the already-armed CF Stream Live
 *       input's uid (the ingest-side `whep-sources.ts` provision, NOT created here). Resolves the destination
 *       (`resolveDestinationForArm`), refuses non-rtmp kinds, then `armExternalRtmpRestream` (SSRF-at-connect +
 *       CF Live Output provision). Returns `200 {ok:true, outputId, inputId}` on success — `outputId` is the ONE
 *       thing the spoke must persist to later tear down. A refused/failed arm returns a distinct non-2xx (never a
 *       silent 200) so the spoke can log loudly.
 *   • POST /v1/egress/teardown — body `{inputId, outputId, org, meetingUuid, durationMs?}`. OWNERSHIP-checked
 *       (wre#323 sec-review HIGH fix, cross-org IDOR) against `EGRESS_OUTPUT_ORG_PREFIX` — the outputId→org
 *       binding `armRtmp` persists at arm success — BEFORE `deleteOutput`: a missing binding is a 404 refusal
 *       (never a silent success), a binding owned by a DIFFERENT org than the gateway-stamped caller is a 403.
 *       `deleteOutput` (idempotent: already-gone → still `ok`) then `emitEgressLegUsage` (leg `rtmp-out`) on the
 *       INERT/$0 `/v1/internal/usage` rail — fail-open, teardown never throws because metering rejected. Returns
 *       `200 {ok:true}`. EXPLICIT teardown (not just relying on CF's live-input-delete cascade) because the
 *       cascade emits no metering event — this is the one call site that emits the hub-side O1 rtmp-out meter.
 *
 * AUTH + org: gateway-gated (x-wave-internal + x-wave-org), IDENTICAL chokepoint to whep-sources/egress-destinations
 * (`maybeHandleWhepSources`/`maybeHandleEgressDestinations`, which this module's dispatch wrapper mirrors exactly).
 * `org` in the arm request comes from the gateway-stamped header, never the body. `armRtmp` ADDITIONALLY verifies
 * `sourceUid` (the CF Live Input being armed) belongs to that SAME gateway-stamped org before provisioning
 * (`STREAM_INPUT_ORG_PREFIX` lookup, wre#323 sec-review HIGH fix — a caller could otherwise arm a restream
 * against another org's live input). Teardown's body still carries an `org` field (wire-contract back-compat),
 * but it is NEVER trusted for authorization OR billing — the gateway-stamped `callerOrg` is what the ownership
 * check verifies AND the sole value `emitEgressLegUsage` is metered against (wre#323 sec-review LOW fix).
 *
 * Gated INERT behind BOTH `EGRESS_ROUTER_ENABLED` and `EGRESS_DEST_MGMT_ENABLED` (either off → 404, mirrors
 * `armExternalRtmpRestream`'s own internal flag gate exactly — this route's flag check is redundant with the
 * function's own, intentionally, so the 404 happens BEFORE any KV/CF I/O rather than deferring to the function).
 * Meeting-agnostic naming throughout (org/dest/session) — `meetingUuid` is just an opaque metering key passed
 * through, never interpreted here.
 */
import { armExternalRtmpRestream, type ExternalRtmpRestreamArmEnv } from "./egress-arm.js";
import { egressRouterEnabled } from "./egress-wave-render.js";
import { egressDestMgmtEnabled, resolveDestinationForArm, type EgressDestinationsEnv } from "./egress-destinations.js";
import { CfStreamEgressLiveOutputClient, deleteOutput } from "./egress-cf-stream-live-output-client.js";
import type { CfStreamEgressClient } from "./egress-cf-stream-passthrough.js";
import { emitEgressLegUsage, type EgressLegMeterEnv } from "./egress-leg-metering.js";
import { STREAM_INPUT_ORG_PREFIX } from "./stream-bridge.js";
import type { StreamInputKv } from "./cf-stream-live-client.js";

const ARM_PATH = "/v1/egress/arm";
const TEARDOWN_PATH = "/v1/egress/teardown";

/** wre#323 sec-review HIGH fix — the outputId→org ownership binding this route writes at ARM success and reads
 *  at TEARDOWN, mirroring `STREAM_INPUT_ORG_PREFIX` (stream-bridge.ts) EXACTLY (same KV namespace, sibling
 *  prefix) so a torn-down output's org can be verified without re-resolving the destination (which teardown
 *  never does — see module docstring). */
export const EGRESS_OUTPUT_ORG_PREFIX = "egress-output-org:";

/** A CF Stream live-input uid is 32 lowercase hex — same shape `LIVE_INPUT_UID` (cf-stream-live-client.ts) /
 *  `deriveLiveInputId` (egress-cf-stream-live-output-client.ts) validate. Re-declared here (no import) so this
 *  route module stays a leaf with zero dependency on the ingest-side module. */
const LIVE_INPUT_UID = /^[0-9a-f]{32}$/;

export interface EgressArmRouteEnv extends ExternalRtmpRestreamArmEnv, EgressDestinationsEnv, EgressLegMeterEnv {
  CF_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string; // Doppler-populated alias
  CF_STREAM_API_TOKEN?: string;
  CLOUDFLARE_STREAM_API_TOKEN?: string; // accepted alias of CF_STREAM_API_TOKEN
  /** Reused KV namespace (SAME binding as whep-sources.ts/stream-bridge.ts) — reads `stream-input-org:{uid}`
   *  (sourceUid ownership, wre#323 HIGH fix) and read/writes `egress-output-org:{outputId}` (teardown IDOR
   *  binding, wre#323 HIGH fix). */
  RT_MEETING_ORG?: StreamInputKv;
}

export interface EgressArmRouteDeps {
  fetchFn?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Test seam only — bypasses the real CF client. Production always constructs the real
   *  `CfStreamEgressLiveOutputClient`. */
  cfClient?: CfStreamEgressClient;
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

/** Resolve the CF account id + Stream API token from env (accepting the Doppler `CLOUDFLARE_*` aliases) —
 *  IDENTICAL resolution to `whep-sources.ts`'s `resolveCfCreds` (same two env-var pairs, same alias precedence). */
function resolveCfCreds(env: EgressArmRouteEnv): { accountId: string; apiToken: string } | null {
  const accountId = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "";
  const apiToken = env.CF_STREAM_API_TOKEN || env.CLOUDFLARE_STREAM_API_TOKEN || "";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

interface ParsedArmBody {
  destId: string;
  sourceUid: string;
}

function parseArmBody(body: unknown): { body: ParsedArmBody } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.destId !== "string" || !b.destId) return { error: "destId is required (string)" };
  if (typeof b.sourceUid !== "string" || !LIVE_INPUT_UID.test(b.sourceUid)) {
    return { error: "sourceUid must be a 32-char lowercase-hex CF Stream live-input id" };
  }
  return { body: { destId: b.destId, sourceUid: b.sourceUid } };
}

interface ParsedTeardownBody {
  inputId: string;
  outputId: string;
  org: string;
  meetingUuid: string;
  durationMs: number;
}

function parseTeardownBody(body: unknown): { body: ParsedTeardownBody } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.inputId !== "string" || !LIVE_INPUT_UID.test(b.inputId)) {
    return { error: "inputId must be a 32-char lowercase-hex CF Stream live-input id" };
  }
  if (typeof b.outputId !== "string" || !b.outputId) return { error: "outputId is required (string)" };
  if (typeof b.org !== "string" || !b.org) return { error: "org is required (string)" };
  if (typeof b.meetingUuid !== "string" || !b.meetingUuid) return { error: "meetingUuid is required (string)" };
  if (b.durationMs !== undefined && (typeof b.durationMs !== "number" || !Number.isFinite(b.durationMs))) {
    return { error: "durationMs must be a number when provided" };
  }
  return {
    body: {
      inputId: b.inputId,
      outputId: b.outputId,
      org: b.org,
      meetingUuid: b.meetingUuid,
      durationMs: typeof b.durationMs === "number" ? b.durationMs : 0,
    },
  };
}

/**
 * POST /v1/egress/arm — see module docstring. `org` is the gateway-stamped, already-validated caller org (never
 * trusted from the body).
 */
async function armRtmp(env: EgressArmRouteEnv, org: string, request: Request, deps: EgressArmRouteDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("EGRESS_ARM_BAD_REQUEST", "request body must be valid JSON", 400);
  }
  const parsed = parseArmBody(body);
  if ("error" in parsed) return jsonError("EGRESS_ARM_BAD_REQUEST", parsed.error, 400);
  const { destId, sourceUid } = parsed.body;

  let dest: Awaited<ReturnType<typeof resolveDestinationForArm>>;
  try {
    dest = await resolveDestinationForArm(env, org, destId);
  } catch (e) {
    console.error(`egress-arm-route arm: destination resolve threw org=${org} destId=${destId}: ${(e as Error)?.message ?? e}`);
    return jsonError("EGRESS_ARM_FAILED", "destination resolve failed, denying by default", 500);
  }
  if (!dest) return jsonError("EGRESS_ARM_DEST_NOT_FOUND", "destination not found", 404);
  if (dest.kind !== "rtmp") {
    return jsonError("EGRESS_ARM_BAD_DEST_KIND", `destination kind '${dest.kind}' is not rtmp`, 400);
  }

  // SOURCEUID↔ORG OWNERSHIP (wre#323 sec-review HIGH fix): `sourceUid` is a CF Live Input the caller does NOT
  // own by default — without this check any caller org could arm a restream against ANOTHER org's live input,
  // exfiltrating their live feed to an attacker-controlled RTMP destination. Mirrors `whep-sources.ts`'s
  // `teardownSource` ownership pattern EXACTLY (same KV, same `STREAM_INPUT_ORG_PREFIX` forward binding):
  // absent KV binding → fail closed (not-configured, never a silent skip); a missing OR foreign-org entry both
  // refuse with the SAME 403 shape (never distinguishes "unknown" from "foreign org" — same fail-closed
  // discipline `resolveDestinationForArm`'s null already uses for destId).
  if (!env.RT_MEETING_ORG) {
    return jsonError("EGRESS_ARM_NOT_CONFIGURED", "stream-input org KV binding (RT_MEETING_ORG) is not configured", 503);
  }
  const sourceOwner = await env.RT_MEETING_ORG.get(`${STREAM_INPUT_ORG_PREFIX}${sourceUid}`);
  if (sourceOwner !== org) {
    console.warn(`egress-arm-route arm REFUSED cross-org sourceUid org=${org} sourceUid=${sourceUid}`);
    return jsonError("EGRESS_ARM_FORBIDDEN", "sourceUid belongs to a different org", 403);
  }

  let client: CfStreamEgressClient;
  if (deps.cfClient) {
    client = deps.cfClient;
  } else {
    const creds = resolveCfCreds(env);
    if (!creds) return jsonError("EGRESS_ARM_NOT_CONFIGURED", "CF Stream account id / API token are not configured", 503);
    client = new CfStreamEgressLiveOutputClient({
      accountId: creds.accountId,
      apiToken: creds.apiToken,
      fetchFn: deps.fetchFn,
      resolveHost: deps.resolveHost,
    });
  }

  const outcome = await armExternalRtmpRestream(
    env,
    org,
    destId,
    // sessionId is the deterministic `cfstream:{uid}` bridged-room string `deriveLiveInputId` parses back apart
    // (egress-cf-stream-live-output-client.ts); trackName carries no meaning for this simulcast-only adapter
    // (never read by `provisionOutput`) — a fixed constant, not fabricated per-request state.
    { sessionId: `cfstream:${sourceUid}`, trackName: "external-rtmp-restream" },
    client,
    { resolveHost: deps.resolveHost, fetchFn: deps.fetchFn },
  );

  if (outcome.status === "refused") {
    console.warn(`egress-arm-route arm REFUSED org=${org} destId=${destId} sourceUid=${sourceUid} status=${outcome.httpStatus}: ${outcome.reason}`);
    return jsonError("EGRESS_ARM_REFUSED", outcome.reason, outcome.httpStatus);
  }

  // OUTPUTID↔ORG BINDING (wre#323 sec-review HIGH fix, teardown IDOR): persisted on EVERY successful arm so
  // `/v1/egress/teardown` can verify the caller owns `outputId` without re-resolving the destination (which it
  // never does — see module docstring). Written AFTER the CF provision succeeds (never bind an id CF didn't
  // actually create). A KV write failure here is logged loud but must not undo the just-provisioned output —
  // the caller already holds the (now possibly-unbound) outputId; the metering/teardown path is the CONSEQUENCE,
  // never the gate, of the provision itself.
  try {
    await env.RT_MEETING_ORG.put(`${EGRESS_OUTPUT_ORG_PREFIX}${outcome.outputId}`, org);
  } catch (e) {
    console.error(`egress-arm-route arm: outputId->org binding write FAILED org=${org} outputId=${outcome.outputId}: ${(e as Error)?.message ?? e}`);
  }

  return Response.json({ ok: true, outputId: outcome.outputId, inputId: sourceUid }, { status: 200 });
}

/**
 * POST /v1/egress/teardown — see module docstring. OWNERSHIP-checked BEFORE `deleteOutput` (wre#323 sec-review
 * HIGH fix, cross-org IDOR — see `EGRESS_OUTPUT_ORG_PREFIX` docstring above): `outputId`'s bound org (written by
 * `armRtmp` at arm success) MUST match `callerOrg` (the gateway-stamped `x-wave-org`, NEVER the body's `org`
 * field — a caller could otherwise assert any org string in the body). `deleteOutput` first (idempotent), then
 * the O1 rtmp-out metering emit — which NEVER throws (`emitEgressLegUsage`'s own fail-open contract) and is a
 * no-op when unprovisioned, so this handler always returns `{ok:true}` once the CF delete itself succeeds/no-ops.
 */
async function teardownRtmp(env: EgressArmRouteEnv, callerOrg: string, request: Request, deps: EgressArmRouteDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("EGRESS_TEARDOWN_BAD_REQUEST", "request body must be valid JSON", 400);
  }
  const parsed = parseTeardownBody(body);
  if ("error" in parsed) return jsonError("EGRESS_TEARDOWN_BAD_REQUEST", parsed.error, 400);
  // `org` in the parsed body is intentionally NOT destructured here — see the billing-attribution fix below
  // (wre#323 sec-review LOW fix): every trust decision and the metering emit both use `callerOrg` (the
  // gateway-stamped, KV-verified owner), never the body-asserted `org` field.
  const { inputId, outputId, meetingUuid, durationMs } = parsed.body;

  // OUTPUTID↔ORG OWNERSHIP (wre#323 sec-review HIGH fix, cross-org IDOR): a missing binding (never armed
  // through this route, or already torn down) is a 404 refusal — NOT a silent success — so a forged/guessed
  // outputId can never be used to probe for "does this exist" via a 200. A binding that resolves to a
  // DIFFERENT org than the gateway-stamped caller → 403. Gates BEFORE `deleteOutput` (never delete on behalf
  // of an unverified caller); the metering emit below stays fail-open exactly as before — only the OWNERSHIP
  // check itself is a hard gate.
  if (!env.RT_MEETING_ORG) {
    return jsonError("EGRESS_TEARDOWN_NOT_CONFIGURED", "stream-input org KV binding (RT_MEETING_ORG) is not configured", 503);
  }
  const boundOrg = await env.RT_MEETING_ORG.get(`${EGRESS_OUTPUT_ORG_PREFIX}${outputId}`);
  if (boundOrg === null) {
    return jsonError("EGRESS_TEARDOWN_NOT_FOUND", "outputId has no known arm binding", 404);
  }
  if (boundOrg !== callerOrg) {
    console.warn(`egress-arm-route teardown REFUSED cross-org outputId org=${callerOrg} outputId=${outputId} boundOrg=${boundOrg}`);
    return jsonError("EGRESS_TEARDOWN_FORBIDDEN", "outputId belongs to a different org", 403);
  }

  const creds = resolveCfCreds(env);
  if (!creds) return jsonError("EGRESS_TEARDOWN_NOT_CONFIGURED", "CF Stream account id / API token are not configured", 503);

  const fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
  const result = await deleteOutput(fetchFn, creds.accountId, creds.apiToken, inputId, outputId);
  if (!result.ok) {
    console.error(`egress-arm-route teardown FAILED org=${callerOrg} inputId=${inputId} outputId=${outputId} status=${result.status}: ${result.reason}`);
    return jsonError("EGRESS_TEARDOWN_FAILED", result.reason, result.status);
  }

  // Remove the binding once the output is actually gone — mirrors whep-sources.ts's KV cleanup-after-delete
  // discipline (never leaves a stale ownership record a later, unrelated re-use of the same outputId could
  // collide with). Best-effort: a delete failure here must never fail an already-successful teardown.
  await env.RT_MEETING_ORG.delete(`${EGRESS_OUTPUT_ORG_PREFIX}${outputId}`).catch((e) => {
    console.warn(`egress-arm-route teardown: outputId->org binding cleanup FAILED outputId=${outputId}: ${(e as Error)?.message ?? e}`);
  });

  // wre#323 sec-review LOW fix — billing-attribution: meter against `callerOrg` (the gateway-stamped,
  // KV-verified owner — SAME org the ownership check just proved owns outputId), NEVER the body's `org` field.
  // Before this fix a caller could tear down its OWN output (passing the ownership check above) while still
  // asserting an arbitrary/mismatched `org` string in the body, mis-attributing the rtmp-out billing event to a
  // different org (or a malformed one) than the one that actually owned + used the output. `org` in the parsed
  // body is kept only because it's a required field of the wire contract (spoke back-compat); it is never the
  // value trusted for a billing-relevant emit.
  // Fail-open by construction (emitEgressLegUsage never throws) — a metering rejection must never fail teardown.
  await emitEgressLegUsage(env, { org: callerOrg, meetingUuid, leg: "rtmp-out", durationMs }, { fetchFn });

  return Response.json({ ok: true }, { status: 200 });
}

/**
 * Handle `/v1/egress/arm` or `/v1/egress/teardown`. Returns a Response for a recognized method/path, or `null` so
 * the caller falls through to the 501 catch-all (same null-fallthrough contract as handleWhepSources/
 * handleEgressDestinations). `org` is the gateway-stamped, already-validated caller org.
 */
export async function handleEgressArmRoute(
  request: Request,
  env: EgressArmRouteEnv,
  org: string,
  deps: EgressArmRouteDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === ARM_PATH) {
    if (request.method !== "POST") return jsonError("EGRESS_ARM_METHOD_NOT_ALLOWED", "POST to arm", 405);
    return armRtmp(env, org, request, deps);
  }
  if (url.pathname === TEARDOWN_PATH) {
    if (request.method !== "POST") return jsonError("EGRESS_TEARDOWN_METHOD_NOT_ALLOWED", "POST to teardown", 405);
    return teardownRtmp(env, org, request, deps);
  }
  return null;
}

/**
 * Dispatch wrapper mirroring `maybeHandleWhepSources`/`maybeHandleEgressDestinations`: co-locates the flag +
 * gateway-trust + org gating with the handler it guards. Returns null (fall-through) when the path isn't
 * `/v1/egress/arm` or `/v1/egress/teardown`, or when EITHER `EGRESS_ROUTER_ENABLED` or `EGRESS_DEST_MGMT_ENABLED`
 * is off (mirrors `armExternalRtmpRestream`'s own dual-flag gate — the route refuses at the SAME boundary the
 * wrapped function would, just before any KV/CF I/O rather than after).
 */
export async function maybeHandleEgressArmRoute(
  request: Request,
  env: EgressArmRouteEnv & { WAVE_INTERNAL_SECRET?: string },
  gatewayGate: (request: Request, secret: string | undefined) => Response | null,
  safeOrg: RegExp,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isArmPath = url.pathname === ARM_PATH || url.pathname === TEARDOWN_PATH;
  if (!isArmPath || !egressRouterEnabled(env) || !egressDestMgmtEnabled(env)) return null;
  const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
  if (denied) return denied;
  const org = request.headers.get("x-wave-org") ?? "";
  if (!safeOrg.test(org)) {
    return Response.json(
      { error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
      { status: 400 },
    );
  }
  return handleEgressArmRoute(request, env, org);
}

export { ARM_PATH, TEARDOWN_PATH };
