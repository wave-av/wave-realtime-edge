/// <reference types="@cloudflare/workers-types" />
/**
 * E3 (#114, absorbs #82) — the N-REGION registry SSOT for the realtime/SFU edge. PURE + additive.
 *
 * This is the ONE authoritative table that drives BOTH region axes of the multi-region topology, so adding
 * a region is a REGISTRY EDIT, not a hunt across four hand-maintained literals (`registries-consolidated`):
 *
 *   • RESIDENCY (recording placement, #127): which continents record in-jurisdiction, into which R2 binding,
 *     asserting which WaveZone to the gateway, under which R2 jurisdiction. residency-rt.ts derives its maps
 *     FROM this registry instead of carrying its own `CONTINENT_TO_ZONE` / `ZONE_TO_BINDING` / bucket-name
 *     literals — so the recorder and the gateway stay consistent by construction (register() never 403s
 *     `residency_bucket_mismatch`) AND a new jurisdiction is one entry here + one wrangler binding + one deploy.
 *
 *   • CASCADE (connectivity placement, #82): the CF `DurableObjectLocationHint` a region's relay is placed in.
 *     cascade.ts owns the FULL nine-member placement union + distribution ladders (EVERY continent must reach
 *     a nearest relay, even ones with no residency bucket) — that stays the connectivity SSOT. This registry
 *     records, per RESIDENCY region, the cascade region its recorder relay co-locates in, so the two axes
 *     COMPOSE without a third vocabulary: a relay records via residency for the zones it covers and relays via
 *     cascade for all of them (cascade.ts header §"Why region = DurableObjectLocationHint").
 *
 * WHY the two axes are NOT collapsed into one enum: residency is a JURISDICTION concern (only continents we
 * hold a compliant bucket for), cascade is a REACHABILITY concern (all nine CF placement hints). Folding them
 * would half-support a jurisdiction merely because we can place a relay there. This registry names the
 * residency axis and points each entry at its cascade hint; it does NOT re-enumerate the cascade set.
 *
 * INERT-BY-CONFIG for new regions: an entry with `enabled: false` is compiled in but excluded from every
 * ACTIVE derivation (`activeRegions`, `zoneFromContinent`, `bindingForZone`). Its continents therefore fall
 * to the NON-residency default path (RT_RECORDINGS, no region key, no register) EXACTLY as an unmapped
 * continent does today — so a region can be authored here (with its wrangler binding staged) and stay
 * byte-identically inert until it is flipped `enabled: true` + its bucket exists + a deploy lands (◆ Jake-named).
 *
 * Live gateway config this stays consistent with (gateway wrangler.toml, 2026-06-27):
 *   RESIDENCY_BUCKETS = "enam=wave-recordings-enam,eu=wave-recordings-eu"  ·  region.ts: us-east→enam, eu-west→eu.
 */

/** The R2 jurisdiction namespace a bucket lives in (CF R2 `jurisdiction` — "default" is the non-EU namespace). */
export type R2Jurisdiction = "default" | "eu" | "fedramp";

/**
 * ONE region's complete cross-axis description. Every field is load-bearing for a residency-consistent write
 * the gateway will re-derive and accept, plus the cascade hint that co-locates the region's recorder relay.
 */
export interface RegionEntry {
	/**
	 * The WaveZone string sent as the recording register()'s `zone` (the gateway folds it zone→jurisdiction→
	 * bucket). MUST be a real member of the gateway's WaveZone SSOT so its `isWaveZone` accepts it. This is the
	 * stable id used as the region-segment in the R2 key and as the KV-captured session zone.
	 */
	readonly zone: string;
	/**
	 * The Workers `request.cf.continent` two-letter codes that record in this zone ("NA","EU","AS","SA","AF",
	 * "OC","AN"). A continent appears in AT MOST ONE enabled entry (asserted by the exhaustiveness test); a
	 * continent in no enabled entry falls to the non-residency default path (never a guessed zone).
	 */
	readonly continents: readonly string[];
	/** The wrangler.toml R2 binding name whose bucket holds this zone's residency-correct recordings. */
	readonly binding: string;
	/** The R2 bucket NAME behind `binding` — what register() asserts as `bucket` (mirrors gateway RESIDENCY_BUCKETS). */
	readonly bucketName: string;
	/** The R2 jurisdiction namespace `binding` resolves in — MUST match the wrangler binding's `jurisdiction`. */
	readonly jurisdiction: R2Jurisdiction;
	/**
	 * The CF `DurableObjectLocationHint` this region's recorder relay is placed in (the cascade axis). A member
	 * of cascade.ts's CASCADE_REGIONS. Records, per residency region, WHERE its relay co-locates so the two
	 * axes compose; cascade.ts remains the authority for the full placement set + distribution ladders.
	 */
	readonly cascadeHint: DurableObjectLocationHint;
	/**
	 * ACTIVE gate. `true` → this region participates in every active derivation (its continents record
	 * in-jurisdiction). `false` → compiled in but INERT: excluded from active maps, its continents fall to the
	 * default path exactly as an unmapped continent. Flipping a region to `true` (with its bucket + deploy) is
	 * a ◆ Jake-named crossing (multi-region storage go-live), NEVER a blanket flip.
	 */
	readonly enabled: boolean;
}

/**
 * THE registry. Order is canonical (used by exhaustiveness checks + tests). The two `enabled: true` entries
 * are the PROVEN-LIVE #127 pair (RT_RESIDENCY=1, dogfood) — their fields reproduce the current hardcoded maps
 * EXACTLY (behavior-preserving). Additional regions are authored here `enabled: false` (INERT) with their
 * cascadeHint pre-assigned, ready to flip once their bucket binding + deploy land.
 */
export const REGION_REGISTRY: readonly RegionEntry[] = [
	{
		zone: "us-east",
		continents: ["NA"],
		binding: "RT_RECORDINGS_ENAM",
		bucketName: "wave-recordings-enam",
		jurisdiction: "default",
		cascadeHint: "enam",
		enabled: true,
	},
	{
		zone: "eu-west",
		continents: ["EU"],
		binding: "RT_RECORDINGS_EU",
		bucketName: "wave-recordings-eu",
		jurisdiction: "eu",
		cascadeHint: "weur",
		enabled: true,
	},
	// ── INERT staged regions (enabled:false → byte-identical to today until flipped ◆). Each needs its R2 ──
	// bucket + wrangler binding created and a deploy before `enabled` becomes true. cascadeHint is pre-assigned
	// so the cascade relay lands in-region the moment the region activates. zone strings are real gateway
	// WaveZones; bucketName/jurisdiction mirror the intended gateway RESIDENCY_BUCKETS extension.
	{
		zone: "ap-southeast",
		continents: ["AS", "OC"],
		binding: "RT_RECORDINGS_APAC",
		bucketName: "wave-recordings-apac",
		jurisdiction: "default",
		cascadeHint: "apac",
		enabled: false,
	},
	{
		zone: "sa-east",
		continents: ["SA"],
		binding: "RT_RECORDINGS_SAM",
		bucketName: "wave-recordings-sam",
		jurisdiction: "default",
		cascadeHint: "sam",
		enabled: false,
	},
];

/** The ACTIVE (enabled) regions — the only ones any live derivation consults. */
export function activeRegions(): readonly RegionEntry[] {
	return REGION_REGISTRY.filter((r) => r.enabled);
}

/** Find the ENABLED region entry a continent records in, or null (→ non-residency default path). Case-insensitive. */
export function regionForContinent(continent: string | null | undefined): RegionEntry | null {
	if (!continent) return null;
	const c = continent.toUpperCase();
	return activeRegions().find((r) => r.continents.includes(c)) ?? null;
}

/** Find the ENABLED region entry by its WaveZone string, or null. Used to re-derive placement from a captured zone. */
export function regionForZone(zone: string | null | undefined): RegionEntry | null {
	if (!zone) return null;
	return activeRegions().find((r) => r.zone === zone) ?? null;
}

/** Find the ENABLED region entry by its wrangler R2 binding name, or null. */
export function regionForBinding(binding: string | null | undefined): RegionEntry | null {
	if (!binding) return null;
	return activeRegions().find((r) => r.binding === binding) ?? null;
}

/** The set of ACTIVE WaveZone strings (what a captured session zone is validated against). Stable order. */
export function activeZones(): readonly string[] {
	return activeRegions().map((r) => r.zone);
}

/** True iff `zone` is an ACTIVE residency zone (an enabled entry's zone). */
export function isActiveZone(zone: string | null | undefined): boolean {
	return regionForZone(zone) !== null;
}
