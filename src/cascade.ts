/// <reference types="@cloudflare/workers-types" />
/**
 * #82 EX P2/P3 — multi-region cascaded-SFU resolver core. PURE + INERT.
 *
 * This is the code half of the cascade ADR (docs/2026-06-25-multiregion-cascade-topology-adr.md). The ADR pins
 * the topology; this module implements the substrate-agnostic DERIVATIONS the ADR leaves "for P2/P3 to
 * implement, not violate" — with ZERO live effect until a caller wires it in behind the RT_CASCADE flag and a
 * Jake-named per-region relay/recorder spawn (◆). It spawns no Durable Object, opens no socket, reads no env.
 *
 * What it owns:
 *   • the Relay DO KEY derivation (P2) — a strict suffix of the primary `(org, room)` key, so no existing route
 *     changes meaning (ADR invariant "Stable identity");
 *   • the region → `locationHint` placement (P2) — region IS a `DurableObjectLocationHint`, the same union CF's
 *     `DurableObjectNamespace.get(id, { locationHint })` accepts, so a relay is placed in its region by
 *     construction with no second vocabulary to drift;
 *   • the participant continent → nearest region map, and the nearest-healthy DISTRIBUTION ladder (P3) — a
 *     `scored-transport-fallback-ladder` that serves a subscriber from its nearest LIVE region or descends.
 *
 * Why region = `DurableObjectLocationHint` (enam/weur/apac/sam/…), not the residency WaveZone (us-east/eu-west):
 * residency-rt.ts deliberately mirrors only the 2 zones the gateway has buckets for (enam, eu) — it is a
 * RECORDING-PLACEMENT concern. The cascade is a CONNECTIVITY concern: EVERY participant, on EVERY continent,
 * must reach a nearest relay, so the cascade's region set is the full CF placement-hint union, not the
 * residency subset. The two compose (a relay records via residency-rt for the zones it covers; it relays via
 * cascade for all of them) but they are NOT the same axis — keeping them separate avoids half-supporting a
 * jurisdiction just because we can place a relay there.
 */

/**
 * A cascade REGION is exactly a Cloudflare `DurableObjectLocationHint` — the same nine-member union accepted by
 * `DurableObjectNamespace.get(id, { locationHint })`. Using CF's own type means a region value is ALWAYS a
 * valid placement hint (no map, no drift) and the compiler rejects an invented region.
 */
export type CascadeRegion = DurableObjectLocationHint;

/** The full region set, in a stable canonical order (used by exhaustiveness checks + tests). */
export const CASCADE_REGIONS: readonly CascadeRegion[] = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
] as const;

/** Narrow an arbitrary string to a CascadeRegion (e.g. validating a stored/forwarded region segment). */
export function isCascadeRegion(v: unknown): v is CascadeRegion {
  return typeof v === "string" && (CASCADE_REGIONS as readonly string[]).includes(v);
}

/**
 * The PRIMARY Room DO key — `(org, room)` — UNCHANGED from today's `idFromName(\`${org}:${room}\`)`. The primary
 * holds the authoritative roster + signaling (ADR §cascade topology). Exposed so the cascade and the existing
 * publish/subscribe paths derive the SAME key from one definition (no two string literals to drift apart).
 */
export function primaryRoomKey(org: string, room: string): string {
  return `${org}:${room}`;
}

/**
 * The REGIONAL RELAY DO key — `(org, room, region)`, a STRICT SUFFIX of the primary key (ADR invariant "Stable
 * identity: relays are a strict suffix `(org, room, region)`. No existing route changes meaning."). The relay is
 * a NEW DO instance, placed in `region` via `relayLocationHint(region)`, peering back to the primary. Keyed off
 * `primaryRoomKey` so the prefix is provably identical to the primary's.
 */
export function relayRoomKey(org: string, room: string, region: CascadeRegion): string {
  return `${primaryRoomKey(org, room)}:${region}`;
}

/**
 * The `locationHint` to pass to `env.ROOM.get(id, { locationHint })` so a relay DO is created IN its region.
 * Identity today (region IS a location hint) — wrapped in a named function so the call site reads intent and a
 * future region→hint refinement (e.g. splitting a region into sub-hints) has ONE place to change.
 */
export function relayLocationHint(region: CascadeRegion): DurableObjectLocationHint {
  return region;
}

/**
 * Workers `request.cf.continent` two-letter code → the region a participant on that continent connects to FIRST
 * (the head of its distribution ladder; ADR §distribution step 1 "maps to the nearest region"). Total over the
 * seven continent codes CF emits ("NA","SA","EU","AS","AF","OC","AN"). Antarctica (AN) has no colo of its own;
 * it folds to weur as the conventional nearest landing (CF routes AN traffic via Europe). Derived from a
 * participant's edge colo/continent ONLY — never client-supplied (ADR: "derived from `request.cf.continent`,
 * never from client-supplied data").
 *
 * NA folds to enam (not wnam) as the single nearest-for-most default; a west-coast participant whose colo is
 * nearer wnam is still served correctly by the LADDER (wnam sits second on NA's ladder) once that relay is live.
 */
const CONTINENT_TO_REGION: Readonly<Record<string, CascadeRegion>> = {
  NA: "enam",
  SA: "sam",
  EU: "weur",
  AS: "apac",
  AF: "afr",
  OC: "oc",
  AN: "weur",
};

/**
 * The nearest region for a participant's continent, or null when the continent is absent/unknown (the caller
 * then uses a deployment default region — never an invented one). Case-insensitive on the continent code.
 */
export function regionFromContinent(continent: string | null | undefined): CascadeRegion | null {
  if (!continent) return null;
  return CONTINENT_TO_REGION[continent.toUpperCase()] ?? null;
}

/**
 * The DISTRIBUTION LADDER for a continent (P3): the ordered list of regions to try, nearest FIRST, for routing a
 * WHEP subscriber (or placing a relay) — a `scored-transport-fallback-ladder`. Index 0 is `regionFromContinent`;
 * the tail is the remaining regions in a geographically-sensible descent so a subscriber whose nearest region
 * has no live/healthy relay still reaches the next-closest one rather than the event origin. Every ladder is a
 * permutation of the full region set (every region is reachable as a last resort — the cascade never refuses a
 * subscriber, it only prefers).
 */
const CONTINENT_LADDER: Readonly<Record<string, readonly CascadeRegion[]>> = {
  // North America: east → west → south-am → western-europe → rest.
  NA: ["enam", "wnam", "sam", "weur", "eeur", "apac", "oc", "me", "afr"],
  // South America: south-am → east-na → west-na → western-europe → rest.
  SA: ["sam", "enam", "wnam", "weur", "afr", "eeur", "me", "apac", "oc"],
  // Europe (west): western-eu → eastern-eu → middle-east → east-na → rest.
  EU: ["weur", "eeur", "me", "enam", "afr", "wnam", "apac", "sam", "oc"],
  // Asia: apac → middle-east → oceania → eastern-eu → west-na → rest.
  AS: ["apac", "me", "oc", "eeur", "wnam", "weur", "enam", "afr", "sam"],
  // Africa: afr → middle-east → western-eu → south-am → rest.
  AF: ["afr", "me", "weur", "sam", "eeur", "enam", "apac", "wnam", "oc"],
  // Oceania: oc → apac → west-na → middle-east → rest.
  OC: ["oc", "apac", "wnam", "me", "enam", "eeur", "weur", "sam", "afr"],
  // Antarctica: folds to the Europe ladder (its nearest landing is weur — see CONTINENT_TO_REGION).
  AN: ["weur", "eeur", "me", "enam", "afr", "wnam", "apac", "sam", "oc"],
};

/**
 * The full nearest-first ladder for a continent, or null when the continent is absent/unknown. Each non-null
 * result is a permutation of CASCADE_REGIONS whose head equals `regionFromContinent(continent)`. Case-insensitive.
 */
export function distributionLadder(continent: string | null | undefined): readonly CascadeRegion[] | null {
  if (!continent) return null;
  return CONTINENT_LADDER[continent.toUpperCase()] ?? null;
}

/**
 * Pick the nearest HEALTHY region to serve a subscriber from (P3 distribution + health gate). Walks the
 * continent's ladder nearest-first and returns the first region for which `isHealthy(region)` is true; returns
 * null when the continent is unknown OR no region on the ladder is healthy (the caller then falls back to the
 * primary/event-origin relay — ADR §distribution step 2/3). `isHealthy` is the caller's liveness probe (a relay
 * DO answering a ping within budget); this function owns ONLY the ordering + selection, never the probe itself,
 * so it stays pure and unit-testable. An unhealthy region is skipped, never served (ADR: "an unhealthy relay is
 * skipped down the ladder, never served").
 */
export function nearestHealthyRegion(
  continent: string | null | undefined,
  isHealthy: (region: CascadeRegion) => boolean,
): CascadeRegion | null {
  const ladder = distributionLadder(continent);
  if (!ladder) return null;
  for (const region of ladder) {
    if (isHealthy(region)) return region;
  }
  return null;
}

/** A resolved relay placement: the region, its DO key suffix-derived from the primary, and its locationHint. */
export interface RelayPlacement {
  /** The cascade region (a CF location hint) this relay serves. */
  readonly region: CascadeRegion;
  /** The relay DO key — `${org}:${room}:${region}`, a strict suffix of the primary `(org, room)` key. */
  readonly key: string;
  /** The locationHint to pass to `env.ROOM.get(id, { locationHint })` so the DO is placed in its region. */
  readonly locationHint: DurableObjectLocationHint;
}

/**
 * One-call relay placement for a region: the DO key + locationHint a caller needs to lazily spawn the regional
 * relay (ADR §cascade topology). PURE — it computes the placement; it does NOT call `idFromName`/`get` (no DO is
 * created, no ◆ crossed). The lazy spawn + per-region recorder attach remain the Jake-named P2/P3 live crossings.
 */
export function relayPlacement(org: string, room: string, region: CascadeRegion): RelayPlacement {
  return {
    region,
    key: relayRoomKey(org, room, region),
    locationHint: relayLocationHint(region),
  };
}
