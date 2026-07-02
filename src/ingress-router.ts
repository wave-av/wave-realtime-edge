/**
 * E-INGRESS P1 (#77) — the inbound-ingest DECISION CORE.
 *
 * Ingress, like egress, is not one target; it is a decision function. `LiveKitIngressService` was the single entry
 * that took an ingress mode (RTMP_INPUT / WHIP_INPUT / URL_INPUT) and set up the right inbound path. wave-native
 * already has the BACKENDS — three orthogonal ingest surfaces — but no unifying router that picks between them:
 *
 *   • cfCallsSfu      — native WebRTC WHIP ingest, straight into the SFU (`whip.ts`). Most direct: no transcode,
 *                       no managed-ingest hop, no container we run.
 *   • cfStreamLive    — Cloudflare Stream Live managed ingest (`stream-bridge.ts`, Plane-1). Free managed ingest for
 *                       RTMP(S) / SRT (caller-mode) push and URL pull; a managed service hop, no container we own.
 *   • containerBridge — the Plane-2 per-protocol container (`ingest-bridge.ts`): terminates a non-WebRTC push
 *                       protocol (srt/rist/rtmp/moq) in a container, decodes → re-encodes → WHIP-publishes. The
 *                       backstop for what CF Stream can't carry (RIST, MoQ) and the self-hosted/listener-mode path.
 *                       The most owned-compute path.
 *
 * This module is that router and NOTHING else — a pure, deterministic, hermetically-testable decision function over
 * a typed job shape. It reads no clock, no env, no network; it owns no media and dispatches nothing. The backends
 * (P2 CF Stream Live ingest, P3 WHIP/WebRTC, P4 health + SSRF guard + backpressure) are follow-on slices; each is
 * wired to its existing surface and calls `ingressRoute` to learn which plane a job goes to. Keeping the decision
 * separate from the backends is the point: the routing table is authoritative CONFIG, not conditionals scattered
 * across three ingest surfaces (service-routing-table-authoritative, grounded in the transport SSOT).
 *
 * Two invariants, mirrored from `egress-router.ts`:
 *   1. CHEAPEST CAPABLE TIER FIRST. The table is ordered by ascending cost rank and walked in order; the first tier
 *      that can carry the source wins. RTMP/SRT push takes the free managed CF Stream path before the owned
 *      container; RIST/MoQ (which CF Stream can't carry) fall through to the container backstop. Escalation is on
 *      need, never by default.
 *   2. COST IS RELATIVE, NOT FABRICATED. `costRank` is an honest ordinal ordering of path directness / owned compute
 *      (native WebRTC < managed CF Stream < self-hosted container-transcode) — NOT a $/hour figure. Real per-path $
 *      COGS is measured and lands with each backend phase; the router must not assert a number it has not measured.
 */

// Reuses the Plane-2 push-protocol SSOT rather than minting a parallel enum. This is a deliberate asymmetry with
// the zero-import `egress-router.ts`: `ingest-bridge.js` (→ `whip.js` → `sfu.js`) declares only top-level
// consts/regexes with no import-time side effects, so this module stays functionally pure and inert.
import { INGEST_PROTOCOLS, type IngestProtocol } from "./ingest-bridge.js";

/** The inbound source kinds wave-native ingests. Superset of the Plane-2 push protocols (`IngestProtocol`) plus the
 *  two paths those don't cover: native WebRTC (`whip`) and a remote URL pull (`urlPull`). "Infrastructure — offer
 *  everything": every viable inbound transport is a first-class source kind, routed to the plane that carries it. */
export const INGEST_SOURCE_KINDS = ["whip", "rtmpPush", "srtPush", "ristPush", "moqPush", "urlPull"] as const;
export type IngestSourceKind = (typeof INGEST_SOURCE_KINDS)[number];

/** The three ingest backends, most-direct → most owned-compute. */
export type IngestBackend = "cfCallsSfu" | "cfStreamLive" | "containerBridge";

/** LiveKit's ingress input modes — the thing `LiveKitIngressService` dispatched on. Kept only to MAP the legacy
 *  surface onto wave-native source kinds for E-DECOMMISSION; nothing wave-native emits these. */
export const LIVEKIT_INGRESS_MODES = ["RTMP_INPUT", "WHIP_INPUT", "URL_INPUT"] as const;
export type LiveKitIngressMode = (typeof LIVEKIT_INGRESS_MODES)[number];

/** Map a LiveKit ingress mode → the wave-native source kind that replaces it (the epic's "map LiveKit ingress modes
 *  to the transport SSOT"). Total over the three LiveKit modes; feeds E-DECOMMISSION's cutover of the ingress tree. */
export function mapLiveKitIngress(mode: LiveKitIngressMode): IngestSourceKind {
  switch (mode) {
    case "RTMP_INPUT":
      return "rtmpPush";
    case "WHIP_INPUT":
      return "whip";
    case "URL_INPUT":
      return "urlPull";
  }
}

/** The Plane-2 push protocol (`IngestProtocol` SSOT) a source kind hands off to the container bridge, or null when
 *  the kind is not a container-bridge push (whip → SFU, urlPull → CF Stream). Reuses the ingest-bridge enum rather
 *  than minting a parallel one (registries-consolidated-to-one-authoritative-file). */
export function pushProtocolOf(kind: IngestSourceKind): IngestProtocol | null {
  switch (kind) {
    case "rtmpPush":
      return "rtmp";
    case "srtPush":
      return "srt";
    case "ristPush":
      return "rist";
    case "moqPush":
      return "moq";
    default:
      return null; // whip, urlPull
  }
}

/** A typed ingest job — the facts the router decides on. `sourceUrl` is required for (and only for) a `urlPull`. */
export interface IngestJob {
  /** Which inbound transport the source uses. */
  readonly sourceKind: IngestSourceKind;
  /** Target wave-native room id (single safe segment; the ingested media publishes as a participant here). */
  readonly room: string;
  /** The remote pull source — REQUIRED for `urlPull`, forbidden otherwise. Fetched (SSRF-guarded) by the backend
   *  in P4, never here; the router only records that a guard is required. */
  readonly sourceUrl?: string;
  /** Optional escalation ceiling by cost rank (0=cfCallsSfu, 1=cfStreamLive, 2=containerBridge). A tier above this
   *  is skipped and the job REJECTED rather than escalated (e.g. "managed only, never spin a container"). */
  readonly maxCostRank?: number;
}

/** The router's verdict. Discriminated union so a malformed/uncoverable job carries a stable reason and never
 *  silently resolves to a backend (mirrors `EgressDecision` / the repo's `RegisterResult` no-throw contract).
 *  `pushProtocol` is the source kind's underlying push protocol (rtmp/srt/rist/moq) or null (WebRTC / URL-pull) — it
 *  names the TRANSPORT, independent of which backend was chosen (an rtmp/srt push still resolves to `cfStreamLive`,
 *  yet carries `pushProtocol: "rtmp"/"srt"`). It is NOT a routing signal; branch on `backend`, never on this field.
 *  `requiresSsrfGuard` is true iff the chosen path fetches a remote URL — a P4 backend MUST run the SSRF guard first. */
export type IngestDecision =
  | {
      readonly ok: true;
      readonly backend: IngestBackend;
      readonly costRank: number;
      readonly pushProtocol: IngestProtocol | null;
      readonly requiresSsrfGuard: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** One tier in the authoritative routing table. `capable` returns null when the tier can carry the source, or a
 *  stable honest-negative reason string when it cannot (so a rejection is explainable, not a bare false). */
interface IngestTier {
  readonly backend: IngestBackend;
  /** Ordinal cost, ascending = more direct / less owned compute. Honest relative ordering, NOT a $ figure. */
  readonly costRank: number;
  capable(job: IngestJob): string | null;
}

/**
 * THE AUTHORITATIVE INGEST ROUTING TABLE — cost-ascending, grounded in the transport SSOT
 * (wave-transport-infra-architecture). `ingressRoute` walks it in order and takes the first capable tier, so
 * "cheapest capable first" falls out of the ordering rather than being re-encoded per ingest surface. This array is
 * the single source of truth for ingest backend selection.
 */
export const INGEST_ROUTING_TABLE: readonly IngestTier[] = [
  {
    backend: "cfCallsSfu",
    costRank: 0,
    // Native WebRTC only — WHIP publishes straight into the SFU, no transcode.
    capable: (job) => (job.sourceKind === "whip" ? null : "cfCallsSfu carries only native WHIP/WebRTC ingest"),
  },
  {
    backend: "cfStreamLive",
    costRank: 1,
    // CF Stream Live managed ingest: RTMP(S) / SRT (caller-mode) push, and remote URL pull. Free managed ingest;
    // does NOT carry RIST or MoQ (those escalate to the container). SRT listener-mode / self-hosted also escalates.
    capable: (job) => {
      if (job.sourceKind === "urlPull" || job.sourceKind === "rtmpPush" || job.sourceKind === "srtPush") return null;
      return `cfStreamLive carries rtmp/srt push + url pull, not ${job.sourceKind}`;
    },
  },
  {
    backend: "containerBridge",
    costRank: 2,
    // Plane-2 per-protocol container — carries ANY non-WebRTC push protocol (srt/rist/rtmp/moq). The backstop for
    // what CF Stream can't (RIST, MoQ) and the self-hosted/listener path, so a valid push source is never stranded.
    capable: (job) =>
      pushProtocolOf(job.sourceKind)
        ? null
        : `containerBridge carries push protocols (${INGEST_PROTOCOLS.join("/")}), not ${job.sourceKind}`,
  },
];

/** Validate a job shape before routing. Returns a stable reason string when malformed, else null. A `urlPull` MUST
 *  carry a non-empty `sourceUrl`; every other kind MUST NOT (a push source has no pull URL) — validate-before-sink
 *  so a bad job is caught at the boundary, never routed on garbage. Deep URL/SSRF validation is the P4 backend. */
export function validateIngestJob(job: IngestJob): string | null {
  if (!(INGEST_SOURCE_KINDS as readonly string[]).includes(job.sourceKind))
    return `sourceKind must be one of ${INGEST_SOURCE_KINDS.join("|")} (got ${job.sourceKind})`;
  if (typeof job.room !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(job.room))
    return `room must be a safe segment [A-Za-z0-9_.-]{1,128} (got ${JSON.stringify(job.room)})`;
  if (job.sourceKind === "urlPull") {
    if (typeof job.sourceUrl !== "string" || job.sourceUrl.length === 0)
      return "urlPull requires a non-empty sourceUrl";
  } else if (job.sourceUrl !== undefined) {
    return `sourceUrl is only valid for a urlPull source (got it on ${job.sourceKind})`;
  }
  if (job.maxCostRank !== undefined && (!Number.isInteger(job.maxCostRank) || job.maxCostRank < 0))
    return `maxCostRank must be an integer ≥0 (got ${job.maxCostRank})`;
  return null;
}

/**
 * Route an ingest job to a backend. Walks the authoritative table cost-ascending and returns the first capable tier
 * (respecting an optional `maxCostRank` ceiling). A valid WHIP source always lands on the SFU; RTMP/SRT push and URL
 * pull take the managed CF Stream path; RIST/MoQ push fall through to the container backstop. The `ok:false`
 * fallthrough is reached only for a malformed job or one whose cost ceiling excludes every capable tier (e.g. a RIST
 * push capped at the managed rank) — always with an explaining reason, never a silent default.
 */
export function ingressRoute(job: IngestJob): IngestDecision {
  const invalid = validateIngestJob(job);
  if (invalid) return { ok: false, reason: invalid };

  const exclusions: string[] = [];
  for (const tier of INGEST_ROUTING_TABLE) {
    if (job.maxCostRank !== undefined && tier.costRank > job.maxCostRank) {
      exclusions.push(`${tier.backend}: costRank ${tier.costRank} > ceiling ${job.maxCostRank}`);
      continue;
    }
    const why = tier.capable(job);
    if (why === null)
      return {
        ok: true,
        backend: tier.backend,
        costRank: tier.costRank,
        pushProtocol: pushProtocolOf(job.sourceKind),
        requiresSsrfGuard: job.sourceKind === "urlPull",
      };
    exclusions.push(`${tier.backend}: ${why}`);
  }
  return { ok: false, reason: `no capable ingest backend — ${exclusions.join("; ")}` };
}
