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
 *   • POST /v1/egress/teardown — body `{inputId, outputId, org, meetingUuid, durationMs?}`. `deleteOutput`
 *       (idempotent: already-gone → still `ok`) then `emitEgressLegUsage` (leg `rtmp-out`) on the INERT/$0
 *       `/v1/internal/usage` rail — fail-open, teardown never throws because metering rejected. Returns
 *       `200 {ok:true}`. EXPLICIT teardown (not just relying on CF's live-input-delete cascade) because the
 *       cascade emits no metering event — this is the one call site that emits the hub-side O1 rtmp-out meter.
 *
 * AUTH + org: gateway-gated (x-wave-internal + x-wave-org), IDENTICAL chokepoint to whep-sources/egress-destinations
 * (`maybeHandleWhepSources`/`maybeHandleEgressDestinations`, which this module's dispatch wrapper mirrors exactly).
 * `org` in the arm request comes from the gateway-stamped header, never the body — teardown's `org` field is a
 * required BODY field instead (metering needs an org to bill; the destination is not re-resolved at teardown so
 * there's no KV-owned org to compare against, same as `emitEgressLegUsage`'s existing contract elsewhere).
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

const ARM_PATH = "/v1/egress/arm";
const TEARDOWN_PATH = "/v1/egress/teardown";

/** A CF Stream live-input uid is 32 lowercase hex — same shape `LIVE_INPUT_UID` (cf-stream-live-client.ts) /
 *  `deriveLiveInputId` (egress-cf-stream-live-output-client.ts) validate. Re-declared here (no import) so this
 *  route module stays a leaf with zero dependency on the ingest-side module. */
const LIVE_INPUT_UID = /^[0-9a-f]{32}$/;

export interface EgressArmRouteEnv extends ExternalRtmpRestreamArmEnv, EgressDestinationsEnv, EgressLegMeterEnv {
  CF_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string; // Doppler-populated alias
  CF_STREAM_API_TOKEN?: string;
  CLOUDFLARE_STREAM_API_TOKEN?: string; // accepted alias of CF_STREAM_API_TOKEN
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
  return Response.json({ ok: true, outputId: outcome.outputId, inputId: sourceUid }, { status: 200 });
}

/**
 * POST /v1/egress/teardown — see module docstring. `deleteOutput` first (idempotent), then the O1 rtmp-out
 * metering emit — which NEVER throws (`emitEgressLegUsage`'s own fail-open contract) and is a no-op when
 * unprovisioned, so this handler always returns `{ok:true}` once the CF delete itself succeeds/no-ops.
 */
async function teardownRtmp(env: EgressArmRouteEnv, request: Request, deps: EgressArmRouteDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("EGRESS_TEARDOWN_BAD_REQUEST", "request body must be valid JSON", 400);
  }
  const parsed = parseTeardownBody(body);
  if ("error" in parsed) return jsonError("EGRESS_TEARDOWN_BAD_REQUEST", parsed.error, 400);
  const { inputId, outputId, org, meetingUuid, durationMs } = parsed.body;

  const creds = resolveCfCreds(env);
  if (!creds) return jsonError("EGRESS_TEARDOWN_NOT_CONFIGURED", "CF Stream account id / API token are not configured", 503);

  const fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
  const result = await deleteOutput(fetchFn, creds.accountId, creds.apiToken, inputId, outputId);
  if (!result.ok) {
    console.error(`egress-arm-route teardown FAILED org=${org} inputId=${inputId} outputId=${outputId} status=${result.status}: ${result.reason}`);
    return jsonError("EGRESS_TEARDOWN_FAILED", result.reason, result.status);
  }

  // Fail-open by construction (emitEgressLegUsage never throws) — a metering rejection must never fail teardown.
  await emitEgressLegUsage(env, { org, meetingUuid, leg: "rtmp-out", durationMs }, { fetchFn });

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
    return teardownRtmp(env, request, deps);
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
