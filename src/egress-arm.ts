/**
 * E-EGRESS-ROUTER ARM SLICE (#75) — the routed-egress `MediaConsumer` factory.
 *
 * The egress-router (#75 P1) decides WHERE a job goes; P2/P3/P4 (egress-wave-render.ts /
 * egress-runpod-nvenc.ts / egress-cf-stream-passthrough.ts) are the per-tier backends, each unit-testable
 * behind an injected client. What none of them do yet is attach to a ROOM's live `MediaTap` (#74) as a single
 * routed consumer driven by ONE decided job — that is this module's job: given an `EgressJob`, build the ONE
 * `MediaConsumer` a RoomDO registers, so a tapped frame flows straight to the decided backend's HTTP endpoint.
 *
 * INERT BY DESIGN (integration-arming plan, Task 7 — "ADDING inert code, not arming"). `onFrame` is a no-op
 * unless BOTH `EGRESS_ROUTER_ENABLED` and `MEDIA_TAP_ENABLED` read armed (`routedEgressArmed`, mirroring the
 * strict true/"1"/"true" predicates `egressRouterEnabled`/`mediaTapEnabled` already use) — so merely
 * constructing/wiring this consumer does not change prod behavior; both ◆ flag flips (Tasks 3 pre-req via
 * MEDIA_TAP_ENABLED, and Task 8 via EGRESS_ROUTER_ENABLED) are needed before a single fetch call fires.
 *
 * WHY ONLY waveRender/runpodNvenc CONSUME FRAMES. `cfStream` passthrough (egress-cf-stream-passthrough.ts) is
 * a ONE-SHOT PROVISIONER — it hands the SFU track straight to CF Stream and never touches per-frame bytes
 * (see that module's docstring: "this backend is a one-shot PROVISIONER — NOT a MediaConsumer"). So when the
 * router decides `cfStream`, this consumer's `onFrame` intentionally stays a no-op (deferred to whatever calls
 * `CfStreamPassthroughEgressBackend.provision` directly) rather than fabricating a per-frame POST to a backend
 * that was never designed to receive one.
 *
 * INJECTED FETCH. The only I/O is behind the injected `fetchFn` parameter (defaults to nothing — the caller
 * MUST supply one), so this module ships zero unverified wire code and is fully unit-testable with a fake.
 * The endpoint URL/auth-header shape here is the SAME `WAVE_RENDER_URL`+bearer / `RUNPOD_NVENC_ENDPOINT`+bearer
 * config surface the P2/P3 backend Env interfaces already declare (`EgressWaveRenderEnv`,
 * `EgressRunpodNvencEnv`) — reused, not reinvented.
 *
 * ROOMDO WIRING — NOT DONE HERE, FLAGGED FOR REVIEW. Unlike the agent media-read fold (`agent-media-consumer.ts`
 * → `RoomDO.armAgentRead`, invoked from the existing `agent-bind` intent), room.ts has NO existing egress seam
 * at all: grepping room.ts/room-recording.ts/whip-room.ts for "egress" returns nothing. There is no no-op
 * egress branch to flip on, and no existing intent (like `agent-bind`) that names WHEN a room should start
 * routed egress. Inventing a new RoomDO intent + worker route to call this factory would be guessing at
 * production control-plane shape rather than encoding an existing decision — exactly what the plan says not to
 * do ("if you can't safely locate the RoomDO seam ... REPORT the wiring point as needing review rather than
 * guessing"). This factory is therefore shipped standalone + fully tested; the RoomDO call site (mirroring
 * `armAgentRead`'s pattern: a method that builds this consumer, subscribes it via `mediaTap.subscribe`, and
 * drains it via `pumpConsumer`) is the concrete next step and needs Jake to name what triggers it.
 */
import { egressRoute, type EgressBackend, type EgressJob } from "./egress-router.js";
import { egressRouterEnabled } from "./egress-wave-render.js";
import { mediaTapEnabled, pumpConsumer } from "./media-tap.js";
import type { MediaConsumer, MediaTap, TapConsumerHandle, TapFrame, TapSelector } from "./media-tap.js";
import {
  evaluateArm,
  registerArmed,
  registerDisarmed,
  type ConcurrencyLimits,
  type KillswitchStore,
} from "./egress-killswitch.js";
import { validateDestinationUrl, type DestKind, type SsrfGuardOptions } from "./ssrf-guard.js";
import { egressDestMgmtEnabled, resolveDestinationForArm, type EgressDestinationsEnv } from "./egress-destinations.js";
import type { CfStreamEgressClient } from "./egress-cf-stream-passthrough.js";
import type { RunpodNvencClient, RunpodNvencEncodeRequest, RunpodNvencResult } from "./egress-runpod-nvenc.js";

/** Env fields this factory reads. Reuses the SAME var/secret names the P2/P3 backend Env interfaces already
 *  declare (`EgressWaveRenderEnv.WAVE_RENDER_URL`/`WAVE_INTERNAL_RENDER_TOKEN`,
 *  `EgressRunpodNvencEnv.RUNPOD_NVENC_ENDPOINT`/`RUNPOD_API_TOKEN`) — one authoritative set of names, not a
 *  parallel config surface. All optional: an absent endpoint for the decided backend is treated as
 *  not-yet-configured (no-op), never a fabricated URL. */
export interface RoutedEgressArmEnv {
  EGRESS_ROUTER_ENABLED?: string | boolean;
  MEDIA_TAP_ENABLED?: string | boolean;
  WAVE_RENDER_URL?: string;
  WAVE_INTERNAL_RENDER_TOKEN?: string;
  RUNPOD_NVENC_ENDPOINT?: string;
  RUNPOD_API_TOKEN?: string;
}

/** Default consumer id + selector: this consumer forwards VIDEO tracks (a routed room-view frame), narrowest
 *  per the tap's least-privilege selector contract (mirrors `WAVE_RENDER_EGRESS_ID`/`RUNPOD_NVENC_EGRESS_ID`). */
export const ROUTED_EGRESS_ID = "egress:routed-arm";
const VIDEO_ONLY_SELECTOR: TapSelector = { kinds: ["video"] };

/** True iff BOTH gates are armed: the egress router flag AND the media tap. Either alone is not enough to
 *  justify a network call — mirrors the strict true/"1"/"true" predicates `egressRouterEnabled` (P1/P2/P3/P4)
 *  and `mediaTapEnabled` (#74) already use, so this factory never reads a looser truthiness. */
export function routedEgressArmed(env: RoutedEgressArmEnv): boolean {
  return egressRouterEnabled(env) && mediaTapEnabled(env);
}

/** Resolve the decided backend to a concrete endpoint + bearer, or null when not applicable/configured.
 *  `cfStream` is intentionally excluded — see the module docstring: it is a one-shot provisioner, never a
 *  per-frame consumer, so routing to it here correctly no-ops rather than inventing a per-frame CF Stream call
 *  the real backend was never designed to receive. */
function backendEndpoint(
  backend: EgressBackend,
  env: RoutedEgressArmEnv,
): { url: string; token?: string } | null {
  switch (backend) {
    case "waveRender":
      return env.WAVE_RENDER_URL
        ? { url: `${env.WAVE_RENDER_URL}/v1/render/frame`, token: env.WAVE_INTERNAL_RENDER_TOKEN }
        : null;
    case "runpodNvenc":
      return env.RUNPOD_NVENC_ENDPOINT
        ? { url: `${env.RUNPOD_NVENC_ENDPOINT}/v1/encode/frame`, token: env.RUNPOD_API_TOKEN }
        : null;
    case "cfStream":
      return null; // one-shot provisioner (egress-cf-stream-passthrough.ts) — not a frame consumer
  }
}

/**
 * Build the routed-egress `MediaConsumer` a RoomDO would register on its `MediaTap` for a given decided job.
 * `onFrame` is INERT (no fetch) until `routedEgressArmed(env)` is true; once armed, it re-routes the SAME job
 * through the authoritative `egressRoute` on every frame (deterministic, no caching of a stale decision) and,
 * for a `waveRender`/`runpodNvenc` verdict with a configured endpoint, POSTs the frame's bytes via the injected
 * `fetchFn`. An unroutable job, a `cfStream` verdict, or a decided-but-unconfigured endpoint all no-op rather
 * than fabricating a request.
 */
export function buildRoutedEgressConsumer(
  job: EgressJob,
  env: RoutedEgressArmEnv,
  fetchFn: typeof fetch,
  opts: { id?: string; selector?: TapSelector } = {},
): MediaConsumer {
  return {
    id: opts.id ?? ROUTED_EGRESS_ID,
    selector: opts.selector ?? VIDEO_ONLY_SELECTOR,
    async onFrame(frame: TapFrame): Promise<void> {
      if (!routedEgressArmed(env)) return; // inert by default — prod byte-identical until both flags are armed

      const decision = egressRoute(job);
      if (!decision.ok) return; // unroutable job — never fabricate a target

      const endpoint = backendEndpoint(decision.backend, env);
      if (!endpoint) return; // cfStream (not a frame consumer) or missing config — deferred/no-op

      const headers: Record<string, string> = { "content-type": "application/octet-stream" };
      if (endpoint.token) headers.authorization = `Bearer ${endpoint.token}`;
      await fetchFn(endpoint.url, { method: "POST", headers, body: frame.bytes });
    },
  };
}

/**
 * Register the routed-egress consumer as a tap consumer and start draining it — the RoomDO call site the module
 * docstring flagged as needing to be named. Mirrors `startAgentRead` (agent-media-consumer.ts) EXACTLY: returns
 * the handle (so the caller can close it on unbind/room-end) or null when NOT armed. Gated by `routedEgressArmed`
 * (BOTH `EGRESS_ROUTER_ENABLED` and `MEDIA_TAP_ENABLED`), so an unarmed room builds/subscribes NOTHING — no
 * consumer registered, no fetch reachable (prod byte-identical until both ◆ flags flip). The pump runs detached
 * (pumpConsumer loops until the handle closes); the returned handle.close() ends it. Re-subscribing the same
 * consumer id closes the prior handle (MediaTap.subscribe contract), so a re-arm is idempotent.
 */
/** Cost-governance guard for `startRoutedEgress` (#278, W0 — kill-switch backstop). Optional: when omitted,
 *  arming behaves exactly as before (no cap, no registry bookkeeping) — additive, not a behavior change for
 *  existing callers. When supplied, EVERY arm is checked against `evaluateArm` (global kill switch, then
 *  per-org + global concurrency caps, in that order — see egress-killswitch.ts) BEFORE the tap subscription is
 *  created; a rejected arm returns `null` exactly like the existing "not armed" path, so callers do not need a
 *  new branch. `orgId`/`streamId` identify the stream in the shared armed-registry the kill switch and the
 *  max-duration sweep (`sweepExpired`) both read. */
export interface EgressCostGuard {
  readonly store: KillswitchStore;
  readonly orgId: string;
  readonly streamId: string;
  readonly limits?: ConcurrencyLimits;
}

export function startRoutedEgress(
  tap: MediaTap,
  job: EgressJob,
  env: RoutedEgressArmEnv,
  fetchFn: typeof fetch,
  opts: { id?: string; selector?: TapSelector } = {},
): TapConsumerHandle | null {
  if (!routedEgressArmed(env)) return null;
  const consumer = buildRoutedEgressConsumer(job, env, fetchFn, opts);
  const handle = tap.subscribe(consumer.id, consumer.selector);
  // Detached drain — pumpConsumer returns only when the handle closes (room end / re-arm). Isolated per
  // media-tap's contract, so no await is threaded through the frame-publish path.
  void pumpConsumer(handle, consumer);
  return handle;
}

/** Cost-governed variant of `startRoutedEgress` (#278, W0 — kill-switch backstop). Every arm is checked
 *  against `evaluateArm` (global kill switch first, then per-org + global concurrency caps — see
 *  egress-killswitch.ts) BEFORE the tap subscription is created; a rejected arm returns `null`, exactly like
 *  the existing "not armed" path, so no new branch is needed at call sites that adopt this. On success, the
 *  stream is recorded in the shared armed-registry (`registerArmed`) that the kill switch and the
 *  max-duration sweep (`sweepExpired`) both read, and the returned handle's `close()` is wrapped to also
 *  deregister it (`registerDisarmed`) — so a normal room-end/re-arm teardown keeps the registry accurate
 *  without every caller remembering to do it. Async (unlike `startRoutedEgress`) because the cap check reads
 *  the store; a plain arm with no cost governance keeps using the sync function above unchanged. */
export async function startRoutedEgressGuarded(
  tap: MediaTap,
  job: EgressJob,
  env: RoutedEgressArmEnv,
  fetchFn: typeof fetch,
  costGuard: EgressCostGuard,
  opts: { id?: string; selector?: TapSelector } = {},
): Promise<TapConsumerHandle | null> {
  if (!routedEgressArmed(env)) return null;

  const { store, orgId, streamId, limits } = costGuard;
  const decision = await evaluateArm(store, orgId, limits);
  if (!decision.ok) return null; // killswitch active, or org/global concurrency cap reached
  await registerArmed(store, orgId, streamId);

  const consumer = buildRoutedEgressConsumer(job, env, fetchFn, opts);
  const handle = tap.subscribe(consumer.id, consumer.selector);
  const originalClose = handle.close.bind(handle);
  handle.close = () => {
    originalClose();
    void registerDisarmed(store, streamId);
  };
  // Detached drain — pumpConsumer returns only when the handle closes (room end / re-arm). Isolated per
  // media-tap's contract, so no await is threaded through the frame-publish path.
  void pumpConsumer(handle, consumer);
  return handle;
}

/**
 * W1 SLICE-2B O1 (wre#287) — SSRF-AT-CONNECT (SHARED helper, lands here — the arm/connect path). A stored
 * destination cleared `validateDestinationUrl` at CREATE time (`egress-destinations.ts` POST), but DNS can
 * rebind between create and the moment the arm actually dials out (documented on `validateDestinationUrl` and
 * on `resolveDestinationForArm`, both of which explicitly punt the re-check to the caller). This is that
 * re-check: it re-runs the SAME deny-by-default, DNS-rebind-safe validation immediately before any outbound
 * provision/dial, so a destination that resolved to a public IP at create time but a private/metadata/CGNAT IP
 * NOW is refused here — never provisioned. Fail-closed: any `{ok:false}` from `validateDestinationUrl` (parse
 * failure, denied host, resolver outage) surfaces as a typed refusal, never a throw into the media path.
 */
export type ConnectSsrfCheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export async function assertDestinationSafeAtConnect(
  dest: { readonly kind: DestKind; readonly url: string },
  deps: Pick<SsrfGuardOptions, "resolveHost" | "fetchFn"> = {},
): Promise<ConnectSsrfCheckResult> {
  const result = await validateDestinationUrl(dest.kind, dest.url, deps);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/** Env this O1 arm path reads: BOTH `EGRESS_ROUTER_ENABLED` (shared egress-router flag) AND
 *  `EGRESS_DEST_MGMT_ENABLED` (destination CRUD's own flag) must be armed — either alone leaves the path INERT,
 *  same strict true/"1"/"true" predicates every other flag in this codebase uses. */
export interface ExternalRtmpRestreamArmEnv extends EgressDestinationsEnv {
  EGRESS_ROUTER_ENABLED?: string | boolean;
}

/** The outcome of one O1 external-RTMP restream arm attempt. Discriminated so a refusal (inert, not-found,
 *  foreign-org, SSRF-at-connect reject, or a non-2xx CF reply) is never mistaken for a provisioned output. */
export type ExternalRtmpRestreamOutcome =
  | { readonly status: "provisioned"; readonly outputId: string }
  | { readonly status: "refused"; readonly httpStatus: number; readonly reason: string };

/** Join a destination's separately-stored `{url, streamKey}` (`resolveDestinationForArm`) into the single
 *  combined rtmp(s) URL `CfStreamEgressTarget.rtmpDestination` already carries (`host/app/streamKey` — the exact
 *  shape `egress-cf-stream-passthrough.test.ts` exercises). The concrete CF adapter
 *  (`egress-cf-stream-live-output-client.ts`) splits it back apart into CF's real two-field wire body. */
function joinRtmpDestination(dest: { url: string; streamKey?: string }): string {
  if (!dest.streamKey) return dest.url;
  return dest.url.endsWith("/") ? `${dest.url}${dest.streamKey}` : `${dest.url}/${dest.streamKey}`;
}

/**
 * ARM an external RTMP restream (O1, wre#287): re-stream an already-ingested Zoom CF Live Input out to a
 * customer's EXTERNAL RTMP destination by creating a CF Stream Live Output. INERT unless BOTH
 * `EGRESS_ROUTER_ENABLED` and `EGRESS_DEST_MGMT_ENABLED` are armed — no behavior change with either flag off.
 *
 * FLOW (fail-closed at every step, never a throw into the media path):
 *   1. Flags off → refused (404), no lookups performed.
 *   2. `resolveDestinationForArm(env, org, destId)` — null (absent OR foreign-org) → refused (404). Never
 *      distinguishes "absent" from "foreign org" in the reason text (mirrors the HTTP GET's fail-closed shape).
 *   3. `assertDestinationSafeAtConnect(dest)` — the SSRF re-check, run BEFORE any outbound provision/dial. A
 *      reject (DNS-rebind or otherwise) → refused (403), NO provision call reaches CF.
 *   4. `client.provisionOutput(...)` — the concrete CF Live Output create. A non-2xx CF reply is a typed refusal
 *      carrying CF's status, never a throw.
 */
export async function armExternalRtmpRestream(
  env: ExternalRtmpRestreamArmEnv,
  org: string,
  destId: string,
  target: { readonly sessionId: string; readonly trackName: string },
  client: CfStreamEgressClient,
  deps: Pick<SsrfGuardOptions, "resolveHost" | "fetchFn"> = {},
): Promise<ExternalRtmpRestreamOutcome> {
  if (!egressRouterEnabled(env) || !egressDestMgmtEnabled(env)) {
    return { status: "refused", httpStatus: 404, reason: "external rtmp restream is not armed" };
  }

  // FAIL-CLOSED ON RESOLVE THROW (wre#320 sec-review LOW fix): `resolveDestinationForArm` throws when the
  // encryption key is unconfigured (`getAesKey`, egress-destinations.ts) — its own doc contract says the ARM
  // path decides its own error handling, but callers elsewhere assume it "never throws". Catch here so a
  // misconfigured key surfaces as a typed refusal, never an unhandled throw into the media path.
  let dest: Awaited<ReturnType<typeof resolveDestinationForArm>>;
  try {
    dest = await resolveDestinationForArm(env, org, destId);
  } catch (e) {
    return {
      status: "refused",
      httpStatus: 500,
      reason: `destination resolve failed, denying by default: ${(e as Error)?.message ?? String(e)}`,
    };
  }
  if (!dest) {
    return { status: "refused", httpStatus: 404, reason: "destination not found" };
  }

  // KIND GUARD (wre#320 sec-review LOW fix): this arm builds an RTMP simulcast request — a destination stored
  // as a different kind (e.g. `srt`) must never be silently treated as RTMP.
  if (dest.kind !== "rtmp") {
    return { status: "refused", httpStatus: 400, reason: `destination kind '${dest.kind}' is not rtmp` };
  }

  // SSRF-AT-CONNECT — re-runs BEFORE any outbound provision/dial (see assertDestinationSafeAtConnect docstring
  // above). Catches a DNS rebind between the destination's create-time validation and this connect attempt.
  const safe = await assertDestinationSafeAtConnect(dest, deps);
  if (!safe.ok) {
    return { status: "refused", httpStatus: 403, reason: `destination failed SSRF-at-connect check: ${safe.reason}` };
  }

  const result = await client.provisionOutput({
    sessionId: target.sessionId,
    trackName: target.trackName,
    output: "simulcast",
    rtmpDestination: joinRtmpDestination(dest),
  });
  if (!result.ok) {
    return { status: "refused", httpStatus: result.status, reason: result.reason };
  }
  return { status: "provisioned", outputId: result.outputId };
}

/**
 * W1 SLICE-2B O2 (wre#288) — external SRT restream ARM, the edge-arm-seam half. CF Stream Live Outputs are
 * RTMP-only (no SRT egress), so — unlike O1's direct CF Live Output — an SRT restream MUST route via the NVENC
 * transcode leg (`egress-runpod-nvenc.ts`): the origin composites/encodes AND pushes the result live to the SRT
 * destination, rather than CF fanning it out itself. This arm mirrors `armExternalRtmpRestream` EXACTLY (same
 * flag gate, same fail-closed resolve/kind/SSRF-at-connect ordering) but dispatches through the injected
 * `RunpodNvencClient` with the resolved destination attached to the encode request, instead of a CF provision
 * call.
 *
 * INERT / DEFERRED SCOPE. This module ships ZERO live-socket code: the actual SRT push happens inside whatever
 * concrete `RunpodNvencClient` the caller injects (the runpod-container ◆ GPU-spend task, explicitly out of
 * scope here) — this arm only builds the request and dispatches it through the seam. Same `EGRESS_ROUTER_ENABLED`
 * + `EGRESS_DEST_MGMT_ENABLED` flag gate as O1 (both default "0"): no behavior change while either is off.
 *
 * FLOW (fail-closed at every step, never a throw into the media path):
 *   1. Flags off → refused (404), no lookups performed.
 *   2. `resolveDestinationForArm(env, org, destId)` — thrown/absent/foreign-org → refused (500/404), same as O1.
 *   3. `dest.kind !== "srt"` → refused (400) — a destination stored as a different kind must never be silently
 *      pushed as SRT.
 *   4. `assertDestinationSafeAtConnect(dest)` — the SAME SSRF-at-connect re-check as O1, run BEFORE any dispatch
 *      to the NVENC client. A reject (DNS-rebind or otherwise) → refused (403), NO `client.encode` call.
 *   5. `client.encode({ ...request, destination: { url: dest.url, passphrase: dest.passphrase } })` — dispatches
 *      the NVENC leg with the resolved SRT target attached. A non-2xx/`ok:false` reply is a typed refusal, never
 *      a throw.
 */
export interface ExternalSrtRestreamArmEnv extends EgressDestinationsEnv {
  EGRESS_ROUTER_ENABLED?: string | boolean;
}

/** The outcome of one O2 external-SRT restream arm attempt. Discriminated so a refusal (inert, not-found,
 *  foreign-org, kind-mismatch, SSRF-at-connect reject, or a non-ok NVENC reply) is never mistaken for a
 *  dispatched stream. */
export type ExternalSrtRestreamOutcome =
  | { readonly status: "streamed"; readonly result: RunpodNvencResult }
  | { readonly status: "refused"; readonly httpStatus: number; readonly reason: string };

/**
 * ARM an external SRT restream (O2, wre#288): dispatch the NVENC transcode leg to push an already-composited
 * room view out to a customer's EXTERNAL SRT destination. `request` is the encode job MINUS `destination` (the
 * caller's already-built width/height/codec/output/latency/sources — the SAME `RunpodNvencEncodeRequest` shape
 * `RunpodNvencEgressBackend` builds); this function attaches the resolved+SSRF-checked destination and dispatches.
 * INERT unless BOTH `EGRESS_ROUTER_ENABLED` and `EGRESS_DEST_MGMT_ENABLED` are armed — no behavior change with
 * either flag off. See the module-level docstring above for the full fail-closed flow.
 */
export async function armExternalSrtRestream(
  env: ExternalSrtRestreamArmEnv,
  org: string,
  destId: string,
  request: Omit<RunpodNvencEncodeRequest, "destination">,
  client: RunpodNvencClient,
  deps: Pick<SsrfGuardOptions, "resolveHost" | "fetchFn"> = {},
): Promise<ExternalSrtRestreamOutcome> {
  if (!egressRouterEnabled(env) || !egressDestMgmtEnabled(env)) {
    return { status: "refused", httpStatus: 404, reason: "external srt restream is not armed" };
  }

  // FAIL-CLOSED ON RESOLVE THROW — same rationale as armExternalRtmpRestream above.
  let dest: Awaited<ReturnType<typeof resolveDestinationForArm>>;
  try {
    dest = await resolveDestinationForArm(env, org, destId);
  } catch (e) {
    return {
      status: "refused",
      httpStatus: 500,
      reason: `destination resolve failed, denying by default: ${(e as Error)?.message ?? String(e)}`,
    };
  }
  if (!dest) {
    return { status: "refused", httpStatus: 404, reason: "destination not found" };
  }

  // KIND GUARD — this arm dispatches an SRT-destined NVENC request; a destination stored as a different kind
  // (e.g. `rtmp`) must never be silently pushed as SRT.
  if (dest.kind !== "srt") {
    return { status: "refused", httpStatus: 400, reason: `destination kind '${dest.kind}' is not srt` };
  }

  // SSRF-AT-CONNECT — re-runs BEFORE any dispatch to the NVENC client (see assertDestinationSafeAtConnect
  // docstring above). Catches a DNS rebind between the destination's create-time validation and this dispatch.
  const safe = await assertDestinationSafeAtConnect(dest, deps);
  if (!safe.ok) {
    return { status: "refused", httpStatus: 403, reason: `destination failed SSRF-at-connect check: ${safe.reason}` };
  }

  const result = await client.encode({
    ...request,
    destination: dest.passphrase ? { url: dest.url, passphrase: dest.passphrase } : { url: dest.url },
  });
  if (!result.ok) {
    return { status: "refused", httpStatus: result.status, reason: result.reason };
  }
  return { status: "streamed", result };
}
