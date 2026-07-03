/**
 * E-INGRESS P3 (#77) — the WHIP/WebRTC ingest BACKEND (the most-direct tier, `cfCallsSfu`; the second backend behind
 * the P1 decision core).
 *
 * The ingress-router (#77 P1) decides WHICH plane an inbound source goes to; P2 (`ingress-cf-stream-live.ts`) serves
 * the `cfStreamLive` verdict. This is the P3 BACKEND — the one that serves the `cfCallsSfu` verdict: native WebRTC
 * WHIP ingest straight into the SFU (the existing `whip.ts` surface — `handleWhip`), no transcode, no managed-ingest
 * hop, no container we run. Like P2 it is a router-facing decision layer over an injected seam: given a typed
 * `IngestJob` (`sourceKind: "whip"`) + the WHIP publish context (the authenticated org + the SDP offer body), it
 * routes through the authoritative `ingressRoute` and — WHEN the verdict is `cfCallsSfu` — asks the injected
 * `WhipSfuClient` to negotiate the WHIP publish into the SFU (SDP offer → SDP answer + a WHIP resource id for later
 * trickle/teardown). Verdicts for the OTHER planes (`cfStreamLive` = P2 managed, `containerBridge` = P4 per-protocol
 * container) are DEFERRED, not handled here: this backend owns EXACTLY ONE plane, so a decision outside it returns a
 * typed `deferred` outcome for the owning backend to pick up. It never silently admits a source routed elsewhere.
 *
 * NO SSRF SURFACE. WHIP is a PUSH — the caller connects to us and offers media; nothing here fetches a remote URL
 * (the router sets `requiresSsrfGuard` only for `urlPull`). So the guard here is the SDP offer + org, not a URL: an
 * empty/authless org or a non-SDP offer body is refused (`unroutable`) before it reaches the SFU seam, rather than
 * negotiating a session for garbage (validate-untrusted-input-before-sink).
 *
 * PURE + INJECTED SEAM. Routing + request-building + offer validation are deterministic (no clock/env/network here —
 * the decision comes from the pure router). The ONLY I/O — the WHIP/SFU negotiation (CF Calls SDP exchange, resource
 * allocation) — is behind the injected `WhipSfuClient` interface, so the whole backend is unit-tested with a fake
 * client and NO SFU/CF-Calls wire code ships in this slice (the concrete adapter, reconciled against `handleWhip` /
 * the live CF Calls API, is the ARM slice). INERT: shares `INGRESS_ROUTER_ENABLED` with P2 (one flag arms the ingress
 * router + its backends), default OFF ([vars]); nothing instantiates this backend and no whip.ts/room.ts edit is
 * needed until the ◆ Jake-named arm crossing. Prod is byte-identical until then.
 */
import { ingressRoute, type IngestBackend, type IngestJob } from "./ingress-router.js";
import { ingressRouterEnabled } from "./ingress-cf-stream-live.js";

/** The WHIP publish request handed to the SFU seam: the caller's room + authenticated org + the SDP offer body (the
 *  `application/sdp` WHIP POST body). The client negotiates this into the SFU and returns an answer. */
export interface WhipPublishRequest {
  readonly room: string;
  /** The authenticated caller's org — the SFU publishes the ingested media as a participant scoped to this org. */
  readonly org: string;
  /** The WHIP SDP offer (the POST body, `application/sdp`). */
  readonly sdpOffer: string;
}

/** A negotiated WHIP session: the SDP answer to return to the caller + the WHIP resource id it uses for trickle-ICE
 *  (PATCH) and teardown (DELETE), mirroring `handleWhip`'s resource route. */
export interface WhipPublishSession {
  readonly sdpAnswer: string;
  readonly resourceId: string;
}

/** The SFU's reply. Discriminated so a negotiation failure (bad offer the SFU rejects, CF Calls 5xx) carries a stable
 *  status + reason and is never mistaken for a live session (mirrors the P2 backend's result shape). */
export type WhipPublishResult =
  | { readonly ok: true; readonly session: WhipPublishSession }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** The injected SFU seam. The backend depends ONLY on this interface — the concrete adapter (the CF Calls SDP
 *  exchange / `handleWhip` publish path, resource allocation) is deferred to the ARM slice, so this module ships zero
 *  unverified SFU/wire code. */
export interface WhipSfuClient {
  publish(req: WhipPublishRequest): Promise<WhipPublishResult>;
}

/** The outcome of one admit attempt. Discriminated so the caller can tell a real admit from a plane this backend does
 *  not own (deferred) or a source that never reached the SFU (unroutable) — never a silent null. */
export type IngestAdmitOutcome =
  | { readonly status: "admitted"; readonly result: WhipPublishResult }
  | { readonly status: "deferred"; readonly backend: IngestBackend }
  | { readonly status: "unroutable"; readonly reason: string };

/** True iff `offer` is a plausible SDP offer — a non-empty body whose first line (after any leading whitespace) is the
 *  mandatory SDP version line `v=0` (RFC 4566). A light guard to refuse an empty/non-SDP body before the SFU seam; the
 *  SFU does the authoritative parse. */
export function isValidSdpOffer(offer: string | undefined): offer is string {
  return typeof offer === "string" && offer.trimStart().startsWith("v=0");
}

/** The default backend id. */
export const WHIP_SFU_INGEST_ID = "ingress:whip-sfu";

/**
 * The WHIP/WebRTC ingest backend. A router-facing negotiator (NOT a tap consumer): `admit(job, ctx)` routes the job
 * through the authoritative `ingressRoute` and, ONLY when the verdict is `cfCallsSfu`, asks the injected client to
 * negotiate the WHIP publish into the SFU. Owns exactly the `cfCallsSfu` plane; every other verdict is DEFERRED. A
 * missing org or a non-SDP offer is `unroutable` — never negotiated on bad input. Holds no SFU, no CF Calls creds, no
 * clock — a pure decision + request-builder over the injected seam.
 */
export class WhipSfuIngestBackend {
  readonly id: string;

  constructor(
    private readonly client: WhipSfuClient,
    opts: { id?: string } = {},
  ) {
    this.id = opts.id ?? WHIP_SFU_INGEST_ID;
  }

  /**
   * Admit a native WHIP source. Routes the job, and negotiates the WHIP publish ONLY for the `cfCallsSfu` verdict. A
   * verdict for another plane is `deferred` (that backend's job); a malformed job, a missing org, or a non-SDP offer
   * is `unroutable` with a reason — never a silent negotiation on bad input.
   */
  async admit(job: IngestJob, ctx: { org: string; sdpOffer: string }): Promise<IngestAdmitOutcome> {
    const decision = ingressRoute(job);
    if (!decision.ok) return { status: "unroutable", reason: decision.reason };
    if (decision.backend !== "cfCallsSfu") return { status: "deferred", backend: decision.backend };

    if (typeof ctx.org !== "string" || ctx.org.length === 0)
      return { status: "unroutable", reason: "cfCallsSfu WHIP ingest requires an authenticated org" };
    if (!isValidSdpOffer(ctx.sdpOffer))
      return { status: "unroutable", reason: "cfCallsSfu WHIP ingest requires a non-empty SDP offer (v=0)" };

    const result = await this.client.publish({ room: job.room, org: ctx.org, sdpOffer: ctx.sdpOffer });
    return { status: "admitted", result };
  }
}

/** The backend's Env fields — declared in `wrangler.toml`, READ only once the backend is wired into the WHIP publish
 *  path (the ARM slice). Falsy/absent → this backend is never instantiated, prod byte-identical. Shares the
 *  `INGRESS_ROUTER_ENABLED` flag with P2; arming it is a ◆ Jake-named crossing. The SFU credentials are the CF Calls
 *  app pair the existing `whip.ts` surface already uses. */
export interface WhipSfuIngestEnv {
  INGRESS_ROUTER_ENABLED?: string | boolean;
  /** CF Calls app id — used by the concrete client to negotiate the SFU session (already bound for the RoomDO). */
  CF_CALLS_APP_ID?: string;
  /** CF Calls app secret — a wrangler SECRET (`wrangler secret put CF_CALLS_APP_SECRET`, Doppler wave/prd). */
  CF_CALLS_APP_SECRET?: string;
}

/** True iff routed ingress is armed. Re-exports the shared reader so both ingress backends read the ONE flag through a
 *  single strict predicate (only `true` / "1" / "true" arm it; absent / "0" / other → OFF, inert). */
export { ingressRouterEnabled };
