/// <reference types="@cloudflare/workers-types" />
/**
 * E3.P2/P4 (#127) — data-residency resolver for the realtime/SFU recorder. PURE + INERT.
 *
 * This is the realtime-edge mirror of the LIVE gateway residency contract (the gateway's region.ts +
 * src/residency.ts + the register endpoint in src/recordings.ts). The gateway is the ENFORCEMENT point;
 * this module exists so the recorder can pre-compute a residency-CONSISTENT (zone, bucket) pair so that a
 * correct register() call NEVER 403s `residency_bucket_mismatch`.
 *
 * Why a local mirror instead of a cross-repo import: wave-realtime-edge does not depend on the gateway repo,
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
 * Live gateway config this mirrors (the gateway wrangler.toml, 2026-06-27):
 *   RESIDENCY_BUCKETS = "enam=wave-recordings-enam,eu=wave-recordings-eu"
 *   (region.ts: us-east→enam, eu-west→eu).
 *
 * #114 N-REGION: the four continent/zone/binding/bucket literals this module used to carry by hand are now
 * DERIVED from the single region registry SSOT (./region-registry). Adding a jurisdiction is a registry
 * edit + a wrangler binding, not a change scattered here. Behavior for the live us-east/eu-west pair is
 * byte-identical (the registry's two `enabled:true` entries reproduce the old maps exactly); staged regions
 * are `enabled:false` in the registry so their continents keep falling to the default path until flipped (◆).
 */
import {
	activeZones,
	regionForBinding,
	regionForContinent,
	regionForZone,
} from "./region-registry";

/**
 * A residency WaveZone this recorder can produce — a real member of the gateway's WaveZone SSOT (so the
 * gateway's `isWaveZone` accepts it), NOT a jurisdiction id. Widened from the old 2-member union to `string`:
 * the set of PRODUCIBLE zones is now the registry's ACTIVE entries (validated at runtime via `isRtResidencyZone`
 * / `activeZones()`), so a new zone becomes valid by adding a registry entry, not by editing this type.
 */
export type RtResidencyZone = string;

/** The R2 binding name (wrangler.toml) that holds a zone's residency-correct bucket. Registry-driven (see above). */
export type RtResidencyBinding = string;

/** True iff `zone` is an ACTIVE residency zone (an enabled registry entry). Replaces the old hardcoded literal check. */
export function isRtResidencyZone(zone: string | null | undefined): zone is RtResidencyZone {
	return regionForZone(zone) !== null;
}

/** The active residency zones, in registry order (what a captured session zone is validated against). */
export function activeResidencyZones(): readonly RtResidencyZone[] {
	return activeZones();
}

/** A resolved residency placement: the WaveZone to assert to the gateway + the local R2 binding to write into. */
export interface RtResidencyPlacement {
  /** The WaveZone string sent as register()'s `zone` (gateway folds it zone→jurisdiction→bucket). */
  readonly zone: RtResidencyZone;
  /** The wrangler R2 binding name whose bucket the bytes are written to (residency-correct for the zone). */
  readonly binding: RtResidencyBinding;
}

/**
 * Resolve a session's residency zone from a Workers `request.cf.continent` code. Returns null for any
 * continent we do not (yet) have a residency bucket for — the caller MUST then use the non-residency default
 * path (recordingKey + RT_RECORDINGS), never a guessed zone. Registry-driven: only ENABLED regions map, so an
 * unmapped OR staged (`enabled:false`) continent returns null exactly as before. Case-insensitive.
 */
export function zoneFromContinent(continent: string | null | undefined): RtResidencyZone | null {
  return regionForContinent(continent)?.zone ?? null;
}

/**
 * The residency-correct R2 binding name for a zone (pairs with the gateway's zone→bucket fold). Registry-
 * driven. Throws on an unknown/inactive zone rather than returning undefined — callers only pass a zone that
 * `zoneFromContinent`/`lookupZone` already produced from an active region, so an unknown zone is a real defect.
 */
export function bindingForZone(zone: RtResidencyZone): RtResidencyBinding {
  const region = regionForZone(zone);
  if (!region) throw new Error(`bindingForZone: no active region for zone "${zone}"`);
  return region.binding;
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
  env: Record<string, unknown>,
  binding: RtResidencyBinding,
): R2Bucket | null {
  const v = env[binding];
  return (v as R2Bucket | undefined) ?? null;
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
