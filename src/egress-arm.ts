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
