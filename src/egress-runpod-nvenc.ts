/**
 * E-EGRESS-ROUTER P3 (#75) — the RunPod NVENC egress BACKEND (the GPU escalation backstop behind the P1 core).
 *
 * The egress-router (#75 P1) decides WHERE a job goes; P2 (`egress-wave-render.ts`) serves the `waveRender` verdict.
 * This is the P3 BACKEND — the one that serves the `runpodNvenc` verdict: the GPU tier of last resort for jobs
 * wave-render's envelope cannot carry (heavy multi-source, >1080p, HEVC/AV1, real-time-at-scale simulcast). Like P2
 * it is a `MediaConsumer` (#74): it attaches to the ONE room `MediaTap`, tracks the room's current composite inputs
 * (latest frame per video track), and on demand builds an `EgressJob`, routes it through the authoritative
 * `egressRoute`, and — WHEN the verdict is `runpodNvenc` — asks the injected `RunpodNvencClient` to composite +
 * NVENC-encode the current room view into a video artifact. Verdicts for the OTHER tiers (`cfStream` = P4
 * passthrough, `waveRender` = P2) are DEFERRED, not handled here: this backend owns exactly ONE tier, so a decision
 * outside it returns a typed `deferred` outcome for the owning backend to pick up. It never silently encodes a job
 * the router sent elsewhere.
 *
 * MEASURED COGS, NOT FABRICATED. The router (P1) deliberately carries only an ordinal `costRank`; the real GPU COGS
 * lands here (P1 doc: "measured COGS that lands with the RunPod backend"). This module honours that WITHOUT asserting
 * a number it has not measured: the encode result carries `gpuSeconds` — the GPU wall-time the RunPod worker actually
 * spent, a MEASURED quantity — and `cogsUsd()` multiplies it by the grounded RunPod serverless flex rate
 * ($0.000528/s for an L40S-class 48GB GPU, from runpod.io/pricing, 2026-06-30). So COGS = measured-seconds ×
 * grounded-rate; nothing is invented. What is NOT asserted here: any $/output-minute egress price or list price —
 * that needs a GPU-seconds-per-encoded-minute throughput bench under load (mirroring the LLM-COGS rule "NEVER list
 * before benching"; that bench + the concrete client is the ARM slice, not this pure slice).
 *
 * PURE + INJECTED SEAM. Routing, job-building, frame-tracking, and the COGS arithmetic are deterministic (no
 * clock/env/network read here — arrival time travels with the frame, the decision comes from the pure router, the
 * rate is a config constant). The ONLY I/O is behind the injected `RunpodNvencClient` interface, so the whole backend
 * is unit-testable with a fake client and NO network / wire-format code ships in this slice. The concrete adapter
 * (POST to the RunPod serverless NVENC endpoint with `RUNPOD_API_TOKEN`, artifact upload, real GPU-seconds readback +
 * throughput bench) is the ARM slice — a ◆ Jake-named crossing, together with wiring this consumer into the RoomDO
 * behind `EGRESS_ROUTER_ENABLED`. Nothing instantiates this backend until that flag is armed, so it is INERT and
 * additive: prod is byte-identical until the crossing.
 */
import { egressRoute, type EgressBackend, type EgressCodec, type EgressJob, type EgressLatency, type EgressOutput } from "./egress-router.js";
import { egressRouterEnabled } from "./egress-wave-render.js";
import type { MediaConsumer, TapFrame, TapSelector } from "./media-tap.js";
import {
  circuitBreakerCheck,
  DEFAULT_BUDGET_LIMITS,
  type AlertSink,
  type BudgetLimits,
  type KillswitchStore,
} from "./egress-killswitch.js";

/** One composite input: the latest decoded frame the backend holds for a given room track. The bytes travel with
 *  their identity + arrival time so the encode request needs no side-channel (mirrors `TapFrame`). */
export interface EncodeSource {
  readonly participantId: string;
  readonly trackName: string;
  readonly bytes: Uint8Array;
  /** Source arrival time (ms) of this frame — passed through from the tap, never read from a clock here. */
  readonly ts: number;
}

/** The composite + NVENC-encode request the backend hands to the origin seam: target geometry/codec + the current
 *  sources. The RunPod worker composites the sources and hardware-encodes to `codec`; the exact wire mapping (and the
 *  artifact sink) is the ARM slice's job. */
export interface RunpodNvencEncodeRequest {
  readonly width: number;
  readonly height: number;
  readonly codec: EgressCodec;
  readonly output: EgressOutput;
  readonly latency: EgressLatency;
  readonly sources: readonly EncodeSource[];
}

/** The origin's reply. Discriminated so a non-2xx (e.g. endpoint 5xx / auth 401) carries a stable status + reason and
 *  is never mistaken for a produced artifact. The ok branch carries a REFERENCE to the encoded artifact (video is far
 *  too large to inline, unlike the P2 still) plus `gpuSeconds` — the measured GPU wall-time the encode consumed, the
 *  sole basis for grounded COGS. */
export type RunpodNvencResult =
  | { readonly ok: true; readonly artifactKey: string; readonly codec: EgressCodec; readonly gpuSeconds: number }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** The injected origin seam. The backend depends ONLY on this interface — the concrete adapter (RunPod serverless
 *  endpoint call, artifact upload, GPU-seconds readback) is deferred to the ARM slice, so this module ships zero
 *  unverified wire code. */
export interface RunpodNvencClient {
  encode(req: RunpodNvencEncodeRequest): Promise<RunpodNvencResult>;
}

/** The grounded COGS rate basis. `gpuFlexUsdPerSecond` is the RunPod serverless FLEX rate for an L40S-class 48GB GPU
 *  ($1.90/hr = $0.000528/s, runpod.io/pricing, 2026-06-30) — the class that carries NVENC hardware encode. It is a
 *  RATE, not a price: COGS = measured `gpuSeconds` × this rate. No $/output-minute or list price is derived here (that
 *  needs a throughput bench — the ARM slice). Typed + centralized so the one authoritative number is not a magic
 *  literal buried in a conditional. */
export interface RunpodNvencCost {
  readonly gpuFlexUsdPerSecond: number;
}

/** The grounded default rate: L40S-class serverless flex. The exact GPU is an arm-time choice; if it changes, this
 *  one constant changes with it (and the throughput bench re-runs). */
export const DEFAULT_RUNPOD_NVENC_COST: RunpodNvencCost = {
  gpuFlexUsdPerSecond: 0.000528,
};

/** Grounded COGS for one encode: measured GPU wall-seconds × the grounded flex rate. Pure arithmetic over a MEASURED
 *  input — never a fabricated $/minute. Returns USD. Guards a non-finite/negative `gpuSeconds` (a malformed origin
 *  readback) to `null` rather than emitting a bogus cost. */
export function cogsUsd(gpuSeconds: number, cost: RunpodNvencCost = DEFAULT_RUNPOD_NVENC_COST): number | null {
  if (!Number.isFinite(gpuSeconds) || gpuSeconds < 0) return null;
  return gpuSeconds * cost.gpuFlexUsdPerSecond;
}

/** Fixed target profile the backend encodes to. Explicit + typed so the `EgressJob` it builds is unambiguous and the
 *  routing verdict is deterministic. Defaults describe a HEAVY egress — a 4K HEVC real-time simulcast composite —
 *  which exceeds `WAVE_RENDER_CAPS` on resolution AND codec AND latency, so any room view (≥1 source) routes to
 *  `runpodNvenc`. A lighter profile would (correctly) route to wave-render and be DEFERRED away from this backend. */
export interface RunpodNvencEgressConfig {
  readonly width: number;
  readonly height: number;
  readonly output: EgressOutput;
  readonly latency: EgressLatency;
  readonly codec: EgressCodec;
  /** A composited room view by definition; a `false` (passthrough) config routes to cfStream and is correctly
   *  DEFERRED away from this backend rather than mis-encoded. */
  readonly needsCompositing: boolean;
}

/** The default profile: a 4K, real-time, HEVC simulcast composite — over `WAVE_RENDER_CAPS` on three axes, so it
 *  routes unambiguously to the GPU backstop. */
export const DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG: RunpodNvencEgressConfig = {
  width: 3840,
  height: 2160,
  output: "simulcast",
  latency: "realTime",
  codec: "hevc",
  needsCompositing: true,
};

/** The outcome of one encode attempt. Discriminated so the caller can tell a real encode from a tier this backend
 *  does not own (deferred), an unroutable/malformed job, or a not-yet-ready tap (no sources) — never a silent null.
 *  `cogsUsd` is the grounded COGS (measured `gpuSeconds` × rate) when the encode produced an artifact, else null. */
export type EgressEncodeOutcome =
  | { readonly status: "encoded"; readonly result: RunpodNvencResult; readonly cogsUsd: number | null }
  | { readonly status: "deferred"; readonly backend: EgressBackend }
  | { readonly status: "unroutable"; readonly reason: string }
  | { readonly status: "empty" }
  | { readonly status: "circuitOpen"; readonly orgId: string };

/** #278, W0 — the COGS circuit-breaker hook: when supplied, every SUCCESSFUL encode's measured `cogsUsd`
 *  (never a fabricated number) is accumulated per `orgId` per time window (`egress-killswitch.ts`); crossing
 *  `limits.budgetUsd` trips the breaker — the backend fires `alertSink` once and then short-circuits every
 *  subsequent `encode()` call with `{status: "circuitOpen"}` (no further RunPod spend for that org instance)
 *  until a NEW backend instance is constructed (a deliberate hard stop, not an auto-recovering breaker — a
 *  human/ops decision re-arms it, mirroring the kill switch's "nothing auto re-arms" stance). */
export interface RunpodNvencBudgetGuard {
  readonly store: KillswitchStore;
  readonly orgId: string;
  readonly limits?: BudgetLimits;
  readonly alertSink: AlertSink;
}

/** Build the typed `EgressJob` for the current room view. Pure: geometry/codec/latency come from config, `sourceCount`
 *  from the live track set. `needsCompositing` is the profile's — so the router sends a passthrough profile to cfStream
 *  and a within-envelope one to wave-render; this backend only claims what routes to `runpodNvenc`. */
export function buildEncodeJob(config: RunpodNvencEgressConfig, sourceCount: number): EgressJob {
  return {
    needsCompositing: config.needsCompositing,
    sourceCount,
    width: config.width,
    height: config.height,
    output: config.output,
    latency: config.latency,
    codec: config.codec,
  };
}

/** The default consumer id + selector: this backend composites VIDEO tracks (a room-view encode), so it subscribes
 *  narrowest — video only (least-privilege selector, per the tap contract). */
export const RUNPOD_NVENC_EGRESS_ID = "egress:runpod-nvenc";
const VIDEO_ONLY_SELECTOR: TapSelector = { kinds: ["video"] };

/**
 * The RunPod NVENC egress backend. Implements `MediaConsumer`: `onFrame` keeps the latest frame per video track (a
 * per-track map — bounded by the room's track count, not the frame rate), and `encode()` builds → routes → (only if
 * the verdict is `runpodNvenc`) encodes via the injected client, then attaches grounded COGS from the measured
 * `gpuSeconds`. Owns exactly the `runpodNvenc` tier; every other verdict is DEFERRED. Holds no SFU, no DO, no clock —
 * a pure consumer over the one tap.
 */
export class RunpodNvencEgressBackend implements MediaConsumer {
  readonly id: string;
  readonly selector: TapSelector;
  private readonly latest = new Map<string, EncodeSource>();
  private circuitOpen = false;

  constructor(
    private readonly config: RunpodNvencEgressConfig,
    private readonly client: RunpodNvencClient,
    private readonly cost: RunpodNvencCost = DEFAULT_RUNPOD_NVENC_COST,
    opts: { id?: string; selector?: TapSelector } = {},
    private readonly budgetGuard?: RunpodNvencBudgetGuard,
  ) {
    this.id = opts.id ?? RUNPOD_NVENC_EGRESS_ID;
    this.selector = opts.selector ?? VIDEO_ONLY_SELECTOR;
  }

  /** True once a budget-guarded encode has tripped the circuit breaker for this backend instance. */
  isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /** Store the latest frame per track (newest wins — live media prefers fresh over complete, like the tap queue). */
  onFrame(frame: TapFrame): void {
    this.latest.set(frame.trackName, {
      participantId: frame.participantId,
      trackName: frame.trackName,
      bytes: frame.bytes,
      ts: frame.ts,
    });
  }

  /** The tap closed the handle (room ended / consumer evicted) — drop held frames so nothing leaks past the room. */
  onClose(): void {
    this.latest.clear();
  }

  /** How many distinct tracks the backend is currently holding a frame for (the composite's source count). */
  sourceCount(): number {
    return this.latest.size;
  }

  /**
   * Attempt one composite + NVENC encode of the current room view. Builds the job from the live source set, asks the
   * authoritative router where it goes, and encodes via the injected client ONLY when the verdict is `runpodNvenc`. A
   * verdict for another tier is returned as `deferred` (that backend's job); an unroutable/malformed job carries the
   * router's reason; an empty tap (no frames yet) is `empty`. On a produced artifact, grounded COGS is computed from
   * the worker's measured `gpuSeconds`.
   */
  async encode(): Promise<EgressEncodeOutcome> {
    if (this.circuitOpen && this.budgetGuard) return { status: "circuitOpen", orgId: this.budgetGuard.orgId };

    const sources = [...this.latest.values()];
    if (sources.length === 0) return { status: "empty" };

    const decision = egressRoute(buildEncodeJob(this.config, sources.length));
    if (!decision.ok) return { status: "unroutable", reason: decision.reason };
    if (decision.backend !== "runpodNvenc") return { status: "deferred", backend: decision.backend };

    const result = await this.client.encode({
      width: this.config.width,
      height: this.config.height,
      codec: this.config.codec,
      output: this.config.output,
      latency: this.config.latency,
      sources,
    });
    const cost = result.ok ? cogsUsd(result.gpuSeconds, this.cost) : null;

    // #278 circuit breaker: accumulate the MEASURED cost (never fabricated) and trip on budget breach.
    if (this.budgetGuard && cost !== null) {
      const { store, orgId, limits, alertSink } = this.budgetGuard;
      const breaker = await circuitBreakerCheck(store, orgId, cost, limits ?? DEFAULT_BUDGET_LIMITS, alertSink);
      if (breaker.tripped) this.circuitOpen = true;
    }

    return { status: "encoded", result, cogsUsd: cost };
  }
}

/** The backend's Env fields — declared in `wrangler.toml [vars]`, but only READ once the consumer is wired into the
 *  RoomDO (the ARM slice). Falsy/absent → this backend is never instantiated, prod byte-identical (like
 *  `MEDIA_TAP_ENABLED` / `PRESENCE_ENABLED`). Shares the `EGRESS_ROUTER_ENABLED` flag with P2 (one flag arms the
 *  egress router + its backends); arming it is a ◆ Jake-named crossing. */
export interface EgressRunpodNvencEnv {
  EGRESS_ROUTER_ENABLED?: string | boolean;
  /** RunPod serverless NVENC endpoint base URL. Bound at the ARM slice. */
  RUNPOD_NVENC_ENDPOINT?: string;
  /** Bearer the encode request presents to the RunPod endpoint (`wrangler secret put`, Doppler wave/prd). */
  RUNPOD_API_TOKEN?: string;
}

/** True iff routed egress is armed. Re-exports the shared reader so both egress backends read the ONE flag through a
 *  single strict predicate (only `true` / "1" / "true" arm it; absent / "0" / other → OFF, inert). */
export { egressRouterEnabled };
