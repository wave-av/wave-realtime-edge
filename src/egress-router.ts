/**
 * E-EGRESS-ROUTER P1 (#75) — the routed-egress DECISION CORE.
 *
 * Egress is not one target; it is a decision function. LiveKit Egress did four distinct jobs — composite/layout
 * recording, single-track egress, RTMP simulcast, and web/composite render (which *is* wave-render). So egress on
 * wave-native is a ROUTER that sends each job to the cheapest capable tier:
 *
 *   • cfStream    — passthrough. No compositing: record or RTMP-simulcast the track(s) as-is. Cheapest (no encode).
 *   • waveRender  — the dogfood default. Composites branded/layout room views within a moderate envelope (#61).
 *   • runpodNvenc — the GPU escalation backstop. Heavy multi-source / high-res / HEVC/AV1 / real-time-at-scale.
 *
 * This module is that router and NOTHING else — a pure, deterministic, hermetically-testable decision function over
 * a typed job shape. It reads no clock, no env, no network; it owns no media. The backends (P2 wave-render, P3
 * RunPod NVENC, P4 CF passthrough + simulcast) are follow-on slices that each become a `MediaConsumer` off the one
 * `MediaTap` (#74) and call `egressRoute` to learn where a job goes. Keeping the decision separate from the
 * backends is the whole point: the routing table is authoritative CONFIG, not conditionals scattered across four
 * encoders.
 *
 * Two invariants the epic's hard-gate demands:
 *   1. CHEAPEST CAPABLE TIER FIRST. The table is ordered by ascending cost rank and walked in order; the first tier
 *      that can do the job wins. wave-render is only reached when passthrough can't (compositing needed); RunPod is
 *      only reached when wave-render's envelope is exceeded. Escalation is on need, never by default.
 *   2. COST IS RELATIVE, NOT FABRICATED. Tiers carry an ordinal `costRank` (0<1<2), an honest relative ordering
 *      (passthrough < own-infra composite < GPU) — NOT a $/hour figure. Real GPU $/hour is measured COGS that lands
 *      with the RunPod backend (P3); the router must not assert a number it has not measured.
 */

/** The three egress backends, cheapest → most expensive. */
export type EgressBackend = "cfStream" | "waveRender" | "runpodNvenc";

/** What the egress produces: a durable recording, or a live RTMP simulcast to an external target. */
export type EgressOutput = "record" | "simulcast";

/** Delivery latency class. `realTime` = live-at-scale (a large simulcast/broadcast) — the class that forces GPU. */
export type EgressLatency = "batch" | "nearRealTime" | "realTime";

/** Output codec the job requires. wave-render emits H.264 only; HEVC/AV1 force the GPU tier. */
export type EgressCodec = "h264" | "hevc" | "av1" | "vp8" | "vp9";

/** A typed egress job — the full set of facts the router decides on. Resolution is explicit px so the envelope
 *  check is unambiguous. All fields required except the optional cost cap. */
export interface EgressJob {
  /** True when the sources must be laid out/composited into one frame (grid, branded overlay, PiP). */
  readonly needsCompositing: boolean;
  /** Number of source tracks feeding the job (≥1). Drives the "heavy multi-source" escalation. */
  readonly sourceCount: number;
  /** Output frame width in px (>0). */
  readonly width: number;
  /** Output frame height in px (>0). */
  readonly height: number;
  /** Record vs simulcast (carried for the backend; simulcast typically implies a realTime latency). */
  readonly output: EgressOutput;
  /** Delivery latency class. */
  readonly latency: EgressLatency;
  /** Required output codec. */
  readonly codec: EgressCodec;
  /** Optional escalation ceiling by cost rank (0=cfStream, 1=waveRender, 2=runpodNvenc). A tier above this is
   *  skipped — the job is REJECTED rather than escalated past the ceiling (a cost guard, e.g. "never use GPU").
   *  Omitted → no cap. */
  readonly maxCostRank?: number;
}

/** The router's verdict. Discriminated union so a malformed/uncoverable job carries a stable reason and never
 *  silently resolves to a backend (mirrors the repo's `RegisterResult` no-throw contract). */
export type EgressDecision =
  | { readonly ok: true; readonly backend: EgressBackend; readonly costRank: number }
  | { readonly ok: false; readonly reason: string };

/**
 * wave-render's capability envelope. Centralized + typed so the boundary is one authoritative place, not a magic
 * number buried in a conditional (configuration-centralized-typed-and-validated). Beyond any of these, the job
 * escalates to the GPU tier. Grounded in wave-render being the still/edge branded-composite renderer (#61), not a
 * real-time-at-scale GPU encoder.
 */
export const WAVE_RENDER_CAPS = {
  /** Up to a 3×3 branded grid; heavier multi-source → escalate. */
  maxSources: 9,
  /** 1080p ceiling; higher resolution → escalate. */
  maxWidth: 1920,
  maxHeight: 1080,
  /** wave-render emits H.264; HEVC/AV1/VP* → escalate. */
  codecs: ["h264"] as readonly EgressCodec[],
  /** Batch/near-real-time only; real-time-at-scale → escalate. */
  latencies: ["batch", "nearRealTime"] as readonly EgressLatency[],
} as const;

/** One tier in the authoritative routing table. `capable` returns null when the tier can do the job, or a stable
 *  honest-negative reason string when it cannot (so a rejection is explainable, not a bare false). */
interface EgressTier {
  readonly backend: EgressBackend;
  /** Ordinal cost, ascending = cheaper. Honest relative ordering, NOT a $ figure. */
  readonly costRank: number;
  capable(job: EgressJob): string | null;
}

/**
 * THE AUTHORITATIVE ROUTING TABLE — cost-ascending. `egressRoute` walks it in order and takes the first capable
 * tier, so "cheapest capable first" falls out of the ordering rather than being re-encoded per call site. This
 * array is the single source of truth for egress backend selection.
 */
export const EGRESS_ROUTING_TABLE: readonly EgressTier[] = [
  {
    backend: "cfStream",
    costRank: 0,
    // Passthrough never lays out sources — capable ONLY when no compositing is needed (record/simulcast as-is).
    capable: (job) => (job.needsCompositing ? "cfStream is passthrough; cannot composite" : null),
  },
  {
    backend: "waveRender",
    costRank: 1,
    // Dogfood compositor — capable for a compositing job within its envelope; beyond it, escalate to GPU.
    capable: (job) => {
      if (!job.needsCompositing) return "no-composite job routes to cheaper passthrough";
      if (job.sourceCount > WAVE_RENDER_CAPS.maxSources)
        return `sourceCount ${job.sourceCount} > waveRender max ${WAVE_RENDER_CAPS.maxSources}`;
      if (job.width > WAVE_RENDER_CAPS.maxWidth || job.height > WAVE_RENDER_CAPS.maxHeight)
        return `resolution ${job.width}x${job.height} > waveRender max ${WAVE_RENDER_CAPS.maxWidth}x${WAVE_RENDER_CAPS.maxHeight}`;
      if (!WAVE_RENDER_CAPS.codecs.includes(job.codec)) return `codec ${job.codec} outside waveRender set`;
      if (!WAVE_RENDER_CAPS.latencies.includes(job.latency))
        return `latency ${job.latency} exceeds waveRender (real-time-at-scale escalates)`;
      return null;
    },
  },
  {
    backend: "runpodNvenc",
    costRank: 2,
    // GPU escalation backstop — capable for ANY compositing job (heavy/high-res/HEVC/real-time). The tier of last
    // resort, so a valid compositing job is never stranded.
    capable: (job) => (job.needsCompositing ? null : "no-composite job routes to cheaper passthrough"),
  },
];

/** Validate a job shape before routing. Returns a stable reason string when the job is malformed, else null.
 *  (configuration-validated-at-load: catch a bad job at the boundary, never route on garbage.) */
export function validateEgressJob(job: EgressJob): string | null {
  if (!Number.isInteger(job.sourceCount) || job.sourceCount < 1)
    return `sourceCount must be an integer ≥1 (got ${job.sourceCount})`;
  if (!Number.isFinite(job.width) || job.width <= 0) return `width must be >0 (got ${job.width})`;
  if (!Number.isFinite(job.height) || job.height <= 0) return `height must be >0 (got ${job.height})`;
  if (job.maxCostRank !== undefined && (!Number.isInteger(job.maxCostRank) || job.maxCostRank < 0))
    return `maxCostRank must be an integer ≥0 (got ${job.maxCostRank})`;
  return null;
}

/**
 * Route an egress job to a backend. Walks the authoritative table cost-ascending and returns the first capable
 * tier (respecting an optional `maxCostRank` ceiling). A valid compositing job always finds a home (waveRender or
 * the RunPod backstop); a valid no-composite job always routes to cfStream. The `ok:false` fallthrough is reached
 * only for a malformed job or one whose cost ceiling excludes every capable tier — always with an explaining
 * reason, never a silent default.
 */
export function egressRoute(job: EgressJob): EgressDecision {
  const invalid = validateEgressJob(job);
  if (invalid) return { ok: false, reason: invalid };

  const exclusions: string[] = [];
  for (const tier of EGRESS_ROUTING_TABLE) {
    if (job.maxCostRank !== undefined && tier.costRank > job.maxCostRank) {
      exclusions.push(`${tier.backend}: costRank ${tier.costRank} > ceiling ${job.maxCostRank}`);
      continue;
    }
    const why = tier.capable(job);
    if (why === null) return { ok: true, backend: tier.backend, costRank: tier.costRank };
    exclusions.push(`${tier.backend}: ${why}`);
  }
  return { ok: false, reason: `no capable egress backend — ${exclusions.join("; ")}` };
}
