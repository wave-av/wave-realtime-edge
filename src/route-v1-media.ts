// route-v1-media — the /v1/* media-protocol routes (WHIP ingest, WHEP egress + sources, egress
// destinations + arm), extracted from route-dispatch.ts (token-budget decompose, 2026-08-30) —
// the law: DECOMPOSE by responsibility seams, never trim. The seam is by PROTOCOL FAMILY: every
// IETF-standard media ingress/egress route plus its management arms lives here; route-dispatch
// keeps the entry choreography, the bridges, and the ingest family. Behavior UNCHANGED — blocks
// moved verbatim, comments included; maybeHandleV1MediaRoutes returns undefined where the inline
// blocks fell through.
import { handleWhip, whipIngestEnabled, type WhipEnv } from "./whip";
import { handleWhep, whepEgressEnabled, type WhepEnv } from "./whep";
import { maybeHandleWhepSources, type WhepSourcesEnv } from "./whep-sources";
import { maybeHandleEgressDestinations, type EgressDestinationsEnv } from "./egress-destinations";
import { maybeHandleEgressArmRoute, type EgressArmRouteEnv } from "./egress-arm-route";
import type { Env } from "./dispatch-helpers";
import { gatewayGate, SAFE_ORG } from "./dispatch-helpers";

/**
 * Every /v1/whip/*, /v1/whep/*, /v1/egress/* route. Returns the Response when matched,
 * undefined when the request belongs to another family (the dispatcher falls through).
 */
export async function maybeHandleV1MediaRoutes(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
): Promise<Response | undefined> {
	const url = new URL(request.url);

	// ── B3 (#98) IETF WHIP v1 ingest — /v1/whip/publish + /v1/whip/resource/{id} ──
	// INERT behind WHIP_INGEST_ENABLED ([vars], default off): when the flag is falsy/absent, this block is
	// skipped entirely and a /v1/whip/* request falls through to the 501 catch-all below — UNCHANGED. When
	// ON, the SAME gateway-trust chokepoint as every other paid route gates it (WAVE_INTERNAL_SECRET /
	// x-wave-internal); org is the gateway-stamped x-wave-org. The handler (src/whip.ts) talks to the CF
	// Realtime SFU directly (signaling-only glue; media terminates at the SFU, never on this Worker).
	if (url.pathname.startsWith("/v1/whip/") && whipIngestEnabled(env as WhipEnv)) {
		const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
		if (denied) return denied;
		const org = request.headers.get("x-wave-org") ?? "";
		if (!SAFE_ORG.test(org)) {
			return Response.json(
				{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
				{ status: 400 },
			);
		}
		const whipRes = await handleWhip(request, env as WhipEnv, org);
		if (whipRes) return whipRes; // null → unrecognized /v1/whip/* sub-path → 501 fall-through below
	}

	// ── WHEP-A (whep-live-egress-golive) CF Stream Live source provision + discovery — /v1/whep/sources.
	// INERT behind INGRESS_ROUTER_ENABLED (null → falls through to the WHEP egress block → 501). ──
	const whepSrcRes = await maybeHandleWhepSources(request, env as WhepSourcesEnv, gatewayGate, SAFE_ORG);
	if (whepSrcRes) return whepSrcRes;

	// ── W1 O3 (wre#289) egress destinations — /v1/egress/destinations[/{id}]. INERT behind EGRESS_DEST_MGMT_ENABLED. ──
	const destRes = await maybeHandleEgressDestinations(request, env as EgressDestinationsEnv, gatewayGate, SAFE_ORG);
	if (destRes) return destRes;

	// ── W1 HUB egress arm/teardown (wave-zoom#46) — /v1/egress/arm + /v1/egress/teardown. INERT behind
	// EGRESS_ROUTER_ENABLED AND EGRESS_DEST_MGMT_ENABLED (either off → falls through, 501 below). ──
	const armRes = await maybeHandleEgressArmRoute(request, env as EgressArmRouteEnv, gatewayGate, SAFE_ORG);
	if (armRes) return armRes;

	// ── #53 IETF WHEP v1 egress — /v1/whep/subscribe + /v1/whep/resource/{id} ──
	// The egress SIBLING of the WHIP block above. INERT behind WHEP_EGRESS_ENABLED ([vars], default off): when
	// the flag is falsy/absent, this block is skipped entirely and a /v1/whep/* request falls through to the
	// 501 catch-all below — UNCHANGED. When ON, the SAME gateway-trust chokepoint as every other paid route
	// gates it (WAVE_INTERNAL_SECRET / x-wave-internal); org is the gateway-stamped x-wave-org. The handler
	// (src/whep.ts) resolves the source publisher session from the WHIP resource record (same-org only) and
	// talks to the CF Realtime SFU directly (signaling-only glue; media terminates at the SFU, never here).
	if (url.pathname.startsWith("/v1/whep/") && whepEgressEnabled(env as WhepEnv)) {
		const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
		if (denied) return denied;
		const org = request.headers.get("x-wave-org") ?? "";
		if (!SAFE_ORG.test(org)) {
			return Response.json(
				{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
				{ status: 400 },
			);
		}
		const whepRes = await handleWhep(request, env as WhepEnv, org);
		if (whepRes) return whepRes; // null → unrecognized /v1/whep/* sub-path → 501 fall-through below
	}

	return undefined;
}
