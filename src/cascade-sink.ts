/// <reference types="@cloudflare/workers-types" />
/**
 * #82/#114 EX P2/P3 — CASCADE wiring for the realtime/SFU room path. ALL inert unless RT_CASCADE.
 *
 * This module owns the env/request glue between the PURE cascade resolver (./cascade) and the live
 * room/relay dispatch path (route-dispatch.ts). route-dispatch only DELEGATES to it: one call resolves the
 * relay DO id + locationHint for a regional join, or null to keep today's primary-room path. Keeping the
 * glue here keeps route-dispatch under the file-size gate AND keeps cascade.ts PURE (no env, no DO, no cf).
 *
 * INERT BY DEFAULT: with RT_CASCADE off, cascadeEnabled()=false → resolveRelay() returns null → the caller
 * uses the UNCHANGED primary `idFromName(`${org}:${room}`)` path, byte-identical to today (no relay, no
 * locationHint, no region segment). Arming RT_CASCADE in any live env — plus the per-region relay/recorder
 * spawn — is a ◆ Jake-named crossing (cascade ADR §◆ Gated crossing).
 *
 * STABLE IDENTITY (ADR invariant): the relay DO key is `relayRoomKey(org,room,region)` — a STRICT SUFFIX of
 * the primary `(org, room)` key — so no existing route changes meaning. The primary's roster/signaling key is
 * never touched; a relay is a NEW DO instance placed in its region, peering back to the primary (DO code is
 * shared; the parentRoom pointer is the logical (org,room) the intent already carries in ctx).
 */
import {
	relayPlacement,
	nearestHealthyRegion,
	regionFromContinent,
	type CascadeRegion,
} from "./cascade";

/** Minimal namespace shape the relay resolution needs (a superset of dispatch-helpers' RoomNamespace). */
interface RelayRoomNamespace {
	idFromName(name: string): unknown;
}

/** The cascade-specific Env fields. Bound in wrangler.toml [vars] but only USED when RT_CASCADE is on. */
export interface CascadeSinkEnv {
	// ── #82/#114 CASCADE — inert unless RT_CASCADE is set ([vars], default OFF) ──
	// Falsy/absent → the room path is byte-identical to today (primary `idFromName(org:room)`, no relay, no
	// locationHint). Truthy ("1") → a regional join is placed on its nearest region's relay DO (a strict-suffix
	// key) via ROOM.get(id,{locationHint}), descending the nearest-healthy ladder. Arming it is a ◆ crossing.
	RT_CASCADE?: string | boolean;
}

/** True iff the cascade path is armed (RT_CASCADE truthy). Falsy/absent/"0"/"false"/"" → OFF (today). */
export function cascadeEnabled(env: CascadeSinkEnv): boolean {
	const v = env.RT_CASCADE;
	return v === true || (typeof v === "string" && v !== "" && v !== "0" && v.toLowerCase() !== "false");
}

/** Read the participant's continent from the Workers edge (request.cf.continent) — NEVER client-supplied. */
function continentOf(request: Request): string | null {
	return (request as Request & { cf?: { continent?: string } }).cf?.continent ?? null;
}

/** A resolved relay routing decision: the DO id (placed in-region) + its locationHint + the chosen region. */
export interface RelayRouting {
	/** The relay DO id (from `idFromName(relayRoomKey(...))`) — a strict suffix of the primary key. */
	readonly id: unknown;
	/** The locationHint to pass to `ROOM.get(id, { locationHint })` so the DO is placed in its region. */
	readonly locationHint: DurableObjectLocationHint;
	/** The cascade region this relay serves (a CF location hint), for observability/logging. */
	readonly region: CascadeRegion;
}

/**
 * Resolve the regional relay routing for a join, or null to keep the primary path. INERT when RT_CASCADE is
 * off (returns null immediately → caller uses the unchanged primary `idFromName(org:room)`).
 *
 * When ON: derive the participant's nearest region from `request.cf.continent`, descending the cascade's
 * nearest-HEALTHY ladder (so a region whose relay is down is skipped, never served). `isHealthy` is the
 * caller's liveness probe; when omitted (no probe wired yet) every region is treated as healthy so the
 * nearest region is chosen by construction. Returns null — falling back to the primary, never an invented
 * region — when the continent is unknown/absent OR no region on the ladder is healthy (ADR §distribution
 * step 2/3) OR the ROOM binding is absent.
 *
 * HONEST: this resolves the placement; it does NOT spawn the DO (the caller's `ROOM.get(id,{locationHint})`
 * lazily materializes the relay). No region is invented; the primary key is never touched.
 */
export function resolveRelay(
	env: CascadeSinkEnv & { ROOM?: RelayRoomNamespace },
	request: Request,
	org: string,
	room: string,
	isHealthy?: (region: CascadeRegion) => boolean,
): RelayRouting | null {
	if (!cascadeEnabled(env) || !env.ROOM) return null;
	const continent = continentOf(request);
	// No continent → no nearest region to place against → primary path (never invent a region).
	if (!regionFromContinent(continent)) return null;
	// Walk the nearest-healthy ladder. Absent probe → all-healthy → the nearest region (ladder head).
	const region = nearestHealthyRegion(continent, isHealthy ?? (() => true));
	if (!region) return null; // unknown continent or no healthy relay → primary fallback (loud, not silent)
	const placement = relayPlacement(org, room, region);
	return {
		id: env.ROOM.idFromName(placement.key),
		locationHint: placement.locationHint,
		region,
	};
}
