/// <reference types="@cloudflare/workers-types" />
/**
 * E3.P2/P4 (#127) — data-residency resolver for the realtime/SFU recorder. PURE + INERT.
 *
 * This is the realtime-edge mirror of the LIVE gateway residency contract (wave-gateway src/region.ts +
 * src/residency.ts + the register endpoint in src/recordings.ts). The gateway is the ENFORCEMENT point;
 * this module exists so the recorder can pre-compute a residency-CONSISTENT (zone, bucket) pair so that a
 * correct register() call NEVER 403s `residency_bucket_mismatch`.
 *
 * Why a local mirror instead of a cross-repo import: wave-realtime-edge does not depend on wave-gateway,
 * and the registries-consolidated law forbids a second authoritative SSOT — so we DELIBERATELY mirror only
 * the enam/eu subset this recorder can produce (the two continents the zone resolver maps), nothing more.
 * Every other continent falls back to the NON-residency default path (recordingKey + RT_RECORDINGS), so no
 * zone is ever invented and no jurisdiction is half-supported.
 *
 * The gateway's `zone` field is validated against its 11-WaveZone SSOT (us-east, eu-west, …), and its
 * RESIDENCY_BUCKETS map is keyed by R2 JURISDICTION (enam, eu). The chain the gateway runs is
 * zone → jurisdictionOf(zone) → RESIDENCY_BUCKETS[jurisdiction] → bucket. We therefore SEND a real
 * WaveZone string (not a jurisdiction) and locally resolve the SAME bucket the gateway will, so the two
 * agree by construction.
 *
 * Live gateway config this mirrors (wave-gateway wrangler.toml, 2026-06-27):
 *   RESIDENCY_BUCKETS = "enam=wave-recordings-enam,eu=wave-recordings-eu"
 *   (region.ts: us-east→enam, eu-west→eu).
 */

/**
 * The WaveZone subset this recorder produces — exactly the two zones the continent resolver maps. A real
 * member of the gateway's WaveZone SSOT (so the gateway's `isWaveZone` accepts it), NOT a jurisdiction id.
 * Mirrored, not imported (see the file header). Extending residency to another continent is a deliberate
 * follow-up: add the zone here, its bucket binding in wrangler.toml, and the continent mapping below.
 */
export type RtResidencyZone = "us-east" | "eu-west";

/** The R2 binding name (wrangler.toml) that holds a zone's residency-correct bucket. */
export type RtResidencyBinding = "RT_RECORDINGS_ENAM" | "RT_RECORDINGS_EU";

/** A resolved residency placement: the WaveZone to assert to the gateway + the local R2 binding to write into. */
export interface RtResidencyPlacement {
  /** The WaveZone string sent as register()'s `zone` (gateway folds it zone→jurisdiction→bucket). */
  readonly zone: RtResidencyZone;
  /** The wrangler R2 binding name whose bucket the bytes are written to (residency-correct for the zone). */
  readonly binding: RtResidencyBinding;
}

/**
 * The Workers `request.cf.continent` two-letter codes → the residency zone we record in. Only NA and EU are
 * mapped; every other continent returns null → the caller falls back to the non-residency default path (do
 * NOT invent a zone for an unmapped continent). `request.cf.continent` is "NA","EU","AS","SA","AF","OC","AN".
 */
const CONTINENT_TO_ZONE: Readonly<Record<string, RtResidencyZone>> = {
  NA: "us-east",
  EU: "eu-west",
};

/** Map a zone to the local R2 binding holding its residency-correct bucket. Total over RtResidencyZone. */
const ZONE_TO_BINDING: Readonly<Record<RtResidencyZone, RtResidencyBinding>> = {
  "us-east": "RT_RECORDINGS_ENAM",
  "eu-west": "RT_RECORDINGS_EU",
};

/**
 * Resolve a session's residency zone from a Workers `request.cf.continent` code. Returns null for any
 * continent we do not (yet) have a residency bucket for — the caller MUST then use the non-residency default
 * path (recordingKey + RT_RECORDINGS), never a guessed zone. Case-insensitive on the continent code.
 */
export function zoneFromContinent(continent: string | null | undefined): RtResidencyZone | null {
  if (!continent) return null;
  return CONTINENT_TO_ZONE[continent.toUpperCase()] ?? null;
}

/** The residency-correct R2 binding name for a zone (pairs with the gateway's zone→bucket fold). */
export function bindingForZone(zone: RtResidencyZone): RtResidencyBinding {
  return ZONE_TO_BINDING[zone];
}

/**
 * Full placement for a continent: the WaveZone to assert + the local binding to write into, or null when the
 * continent has no residency bucket (→ non-residency default path). One call gives the recorder both halves
 * of the residency-consistent (zone, bucket) pair the gateway will re-derive and accept.
 */
export function placementForContinent(continent: string | null | undefined): RtResidencyPlacement | null {
  const zone = zoneFromContinent(continent);
  if (!zone) return null;
  return { zone, binding: bindingForZone(zone) };
}

/**
 * Resolve the actual R2Bucket for a residency binding off the env. Returns null when the binding is unbound
 * (defense-in-depth: the bindings exist in wrangler.toml, but a misconfigured/partial env must fail to the
 * default path rather than write nowhere). Kept env-shape-agnostic (a record of optional R2 bindings).
 */
export function bucketForBinding(
  env: Partial<Record<RtResidencyBinding, R2Bucket | undefined>>,
  binding: RtResidencyBinding,
): R2Bucket | null {
  return env[binding] ?? null;
}

/**
 * Build the region-aware R2 key for a residency recording. Mirrors recordingKey()'s org-prefix invariant
 * (MUST start with `${org}/` so the gateway register org-prefix check + the daily storage sweep both hold)
 * but inserts the region segment so a zone's objects are self-describing on disk:
 *   `${org}/realtime-recordings/${region}/${sessionId}/recording.${ext}`
 * `region` is the WaveZone string (us-east / eu-west). This is ADDITIVE — the non-residency default path
 * keeps using recordingKey() (no region segment), so today's keys are byte-identical when RT_RESIDENCY is off.
 */
export function residencyRecordingKey(
  org: string,
  region: RtResidencyZone,
  sessionId: string,
  ext: string,
): string {
  return `${org}/realtime-recordings/${region}/${sessionId}/recording.${ext}`;
}
