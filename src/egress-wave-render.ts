/**
 * E-EGRESS-ROUTER P2 (#75) — the wave-render egress BACKEND (the first backend behind the #75 P1 decision core).
 *
 * The egress-router (#75 P1) decides WHERE a job goes; this is the first BACKEND — the one that serves the
 * `waveRender` verdict. It is a `MediaConsumer` (#74): it attaches to the ONE room `MediaTap`, tracks the room's
 * current composite inputs (latest frame per video track), and on demand builds an `EgressJob`, routes it through
 * the authoritative `egressRoute`, and — WHEN the verdict is `waveRender` — asks the injected `WaveRenderClient` to
 * composite the current room view into a branded still (#61 wave-render still-mode). Verdicts for the OTHER tiers
 * (`cfStream` = P4 passthrough, `runpodNvenc` = P3 GPU) are DEFERRED, not handled here: this backend owns exactly
 * ONE tier, so a decision outside it returns a typed `deferred` outcome for the owning backend to pick up. It never
 * silently renders a job the router sent elsewhere.
 *
 * PURE + INJECTED SEAM. The routing, job-building, and frame-tracking are deterministic (no clock/env/network read
 * here — arrival time travels with the frame, the decision comes from the pure router). The ONLY I/O is behind the
 * injected `WaveRenderClient` interface, so the whole backend is unit-testable with a fake client and NO network /
 * wire-format code ships in this slice. The concrete HTTP adapter (POST to the wave-render origin with
 * `WAVE_INTERNAL_RENDER_TOKEN`) plus its reconciliation against the live origin's request/response contract is the
 * ARM slice — a ◆ Jake-named crossing, together with wiring this consumer into the RoomDO behind
 * `EGRESS_ROUTER_ENABLED` and building the tap subscribe/pumpConsumer loop. Nothing instantiates this backend until
 * that flag is armed, so it is INERT and additive: prod is byte-identical until the crossing.
 */
import { egressRoute, type EgressBackend, type EgressCodec, type EgressJob, type EgressLatency, type EgressOutput } from "./egress-router.js";
import type { MediaConsumer, TapFrame, TapSelector } from "./media-tap.js";

/** One composite input: the latest decoded frame the backend holds for a given room track. The bytes travel with
 *  their identity + arrival time so the still request needs no side-channel (mirrors `TapFrame`). */
export interface WaveRenderSource {
  readonly participantId: string;
  readonly trackName: string;
  readonly bytes: Uint8Array;
  /** Source arrival time (ms) of this frame — passed through from the tap, never read from a clock here. */
  readonly ts: number;
}

/** The composite-still request the backend hands to the origin seam: target frame geometry + the current sources.
 *  wave-render still-mode emits a PNG at these dimensions (#61); the exact wire mapping is the ARM slice's job. */
export interface WaveRenderStillRequest {
  readonly width: number;
  readonly height: number;
  readonly sources: readonly WaveRenderSource[];
}

/** The origin's reply. Discriminated so a non-2xx (e.g. UNTRUSTED → 402) carries a stable status + reason and is
 *  never mistaken for image bytes. */
export type WaveRenderStillResult =
  | { readonly ok: true; readonly image: Uint8Array; readonly contentType: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** The injected origin seam. The backend depends ONLY on this interface — the concrete fetch-based adapter (path,
 *  auth header, body shape reconciled against the live wave-render worker) is deferred to the ARM slice, so this
 *  module ships zero unverified wire code. */
export interface WaveRenderClient {
  renderStill(req: WaveRenderStillRequest): Promise<WaveRenderStillResult>;
}

/** Fixed target profile the backend composites to. Explicit + typed so the `EgressJob` it builds is unambiguous and
 *  the routing verdict is deterministic (configuration-centralized-typed). Defaults describe a branded 1080p room
 *  view — squarely inside wave-render's H.264 / ≤1080p / ≤9-source envelope (`WAVE_RENDER_CAPS`). */
export interface WaveRenderEgressConfig {
  readonly width: number;
  readonly height: number;
  readonly output: EgressOutput;
  readonly latency: EgressLatency;
  readonly codec: EgressCodec;
  /** A branded room view is a composite by definition; expose it so a `false` (passthrough) config routes to
   *  cfStream and is correctly DEFERRED away from this backend rather than mis-rendered. */
  readonly needsCompositing: boolean;
}

/** The default profile: a branded, near-real-time 1080p H.264 composite — inside `WAVE_RENDER_CAPS`, so a room view
 *  of ≤9 sources routes to `waveRender`. */
export const DEFAULT_WAVE_RENDER_EGRESS_CONFIG: WaveRenderEgressConfig = {
  width: 1920,
  height: 1080,
  output: "record",
  latency: "nearRealTime",
  codec: "h264",
  needsCompositing: true,
};

/** The outcome of one render attempt. Discriminated so the caller can tell a real render from a tier this backend
 *  does not own (deferred), an unroutable/malformed job, or a not-yet-ready tap (no sources) — never a silent null. */
export type EgressRenderOutcome =
  | { readonly status: "rendered"; readonly result: WaveRenderStillResult }
  | { readonly status: "deferred"; readonly backend: EgressBackend }
  | { readonly status: "unroutable"; readonly reason: string }
  | { readonly status: "empty" };

/** Build the typed `EgressJob` for the current room view. Pure: geometry + profile come from config, `sourceCount`
 *  from the live track set. `needsCompositing` is the profile's (a branded room view composites), so the router
 *  sends a passthrough profile to cfStream and a heavy/over-envelope one to the GPU backstop — this backend only
 *  claims what routes to `waveRender`. */
export function buildEgressJob(config: WaveRenderEgressConfig, sourceCount: number): EgressJob {
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

/** The default consumer id + selector: this backend composites VIDEO tracks (a room-view still), so it subscribes
 *  narrowest — video only (least-privilege selector, per the tap contract). */
export const WAVE_RENDER_EGRESS_ID = "egress:wave-render";
const VIDEO_ONLY_SELECTOR: TapSelector = { kinds: ["video"] };

/**
 * The wave-render egress backend. Implements `MediaConsumer`: `onFrame` keeps the latest frame per video track (a
 * per-track map — bounded by the room's track count, not the frame rate), and `render()` builds → routes → (only if
 * the verdict is `waveRender`) renders via the injected client. Owns exactly the `waveRender` tier; every other
 * verdict is DEFERRED. Holds no SFU, no DO, no clock — a pure consumer over the one tap.
 */
export class WaveRenderEgressBackend implements MediaConsumer {
  readonly id: string;
  readonly selector: TapSelector;
  private readonly latest = new Map<string, WaveRenderSource>();

  constructor(
    private readonly config: WaveRenderEgressConfig,
    private readonly client: WaveRenderClient,
    opts: { id?: string; selector?: TapSelector } = {},
  ) {
    this.id = opts.id ?? WAVE_RENDER_EGRESS_ID;
    this.selector = opts.selector ?? VIDEO_ONLY_SELECTOR;
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
   * Attempt one composite-still render of the current room view. Builds the job from the live source set, asks the
   * authoritative router where it goes, and renders via the injected client ONLY when the verdict is `waveRender`.
   * A verdict for another tier is returned as `deferred` (that backend's job); an unroutable/malformed job carries
   * the router's reason; an empty tap (no frames yet) is `empty`.
   */
  async render(): Promise<EgressRenderOutcome> {
    const sources = [...this.latest.values()];
    if (sources.length === 0) return { status: "empty" };

    const decision = egressRoute(buildEgressJob(this.config, sources.length));
    if (!decision.ok) return { status: "unroutable", reason: decision.reason };
    if (decision.backend !== "waveRender") return { status: "deferred", backend: decision.backend };

    const result = await this.client.renderStill({
      width: this.config.width,
      height: this.config.height,
      sources,
    });
    return { status: "rendered", result };
  }
}

/** The backend's Env fields — declared in `wrangler.toml [vars]`, but only READ once the consumer is wired into the
 *  RoomDO (the ARM slice). Falsy/absent → this backend is never instantiated, prod byte-identical (like
 *  `MEDIA_TAP_ENABLED` / `PRESENCE_ENABLED`). Arming `EGRESS_ROUTER_ENABLED` is a ◆ Jake-named crossing. */
export interface EgressWaveRenderEnv {
  EGRESS_ROUTER_ENABLED?: string | boolean;
  /** wave-render origin base URL (e.g. the edge-render service). Bound at the ARM slice. */
  WAVE_RENDER_URL?: string;
  /** Bearer the render request presents to the wave-render origin (`wrangler secret put`, Doppler wave/prd). */
  WAVE_INTERNAL_RENDER_TOKEN?: string;
}

/** True iff routed egress is armed. Strict, mirroring `mediaTapEnabled`: only `true` / "1" / "true" arm it; absent /
 *  "0" / anything else → OFF (inert). */
export function egressRouterEnabled(env: EgressWaveRenderEnv): boolean {
  const v = env.EGRESS_ROUTER_ENABLED;
  return v === true || v === "1" || v === "true";
}
