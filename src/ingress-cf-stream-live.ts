/**
 * E-INGRESS P2 (#77) — the CF Stream Live INGEST backend (the first backend behind the #77 P1 decision core).
 *
 * The ingress-router (#77 P1) decides WHICH plane an inbound source goes to; this is the first BACKEND — the one
 * that serves the `cfStreamLive` verdict. Unlike egress (a MediaConsumer draining the tap), ingress is a one-shot
 * PROVISION: given a typed `IngestJob`, it routes through the authoritative `ingressRoute`, and — WHEN the verdict is
 * `cfStreamLive` — asks the injected `CfStreamLiveClient` to create a Cloudflare Stream Live input (the free managed
 * RTMP(S)/SRT push + URL-pull ingest) for the caller's room + org. Verdicts for the OTHER planes (`cfCallsSfu` = P3
 * native WHIP, `containerBridge` = P4 per-protocol container) are DEFERRED, not handled here: this backend owns
 * EXACTLY ONE plane, so a decision outside it returns a typed `deferred` outcome for the owning backend to pick up.
 *
 * THE ORG BINDING. `stream-bridge.ts` (the Plane-1 RECEIVER) is deliberately receive-only: when a live input goes
 * live, its webhook resolves the org from a server-side `stream-input-org:${uid}` KV lookup (never trusting the wire)
 * and bridges into the deterministic `cfstream:${uid}` room. That binding must EXIST by the time the webhook fires —
 * so provisioning is where it is written. Here it is the injected client's job: `createLiveInput` both creates the
 * CF input AND persists the `uid → org` mapping, atomically, so the receiver never fail-closes on a missing org.
 *
 * PURE + INJECTED SEAM. Routing + job/request-building are deterministic (no clock/env/network). The only I/O — the
 * CF Stream API call + the KV binding write — is behind the injected `CfStreamLiveClient` interface, so the whole
 * backend is unit-tested with a fake client and NO wire/CF-API code ships in this slice (the concrete adapter +
 * reconciliation against the live CF Stream Live API is the ARM slice). INERT: `INGRESS_ROUTER_ENABLED` default OFF
 * ([vars]); nothing instantiates this backend and NO stream-bridge.ts / room.ts edit is needed until the ◆
 * Jake-named arm crossing wires provisioning into the ingest entrypoint. Prod is byte-identical until then.
 */
import { ingressRoute, type IngestBackend, type IngestJob } from "./ingress-router.js";
import type { IngestProtocol } from "./ingest-bridge.js";

/** How a CF Stream Live input is fed: a push (RTMP/SRT — the caller pushes to a CF ingest endpoint) or a pull (CF
 *  fetches a remote URL). Mirrors the `cfStreamLive` tier's capable set (rtmpPush / srtPush / urlPull). */
export type CfStreamLiveFeed =
  | { readonly mode: "push"; readonly protocol: IngestProtocol }
  | { readonly mode: "pull"; readonly sourceUrl: string };

/** The provisioning request handed to the origin seam: the caller's room + org (for the uid→org binding the receiver
 *  requires) and how the input is fed. The client creates the CF live input AND writes the org binding. */
export interface CfStreamLiveIngestRequest {
  readonly room: string;
  /** The authenticated caller's org — the VALUE persisted at `stream-input-org:${uid}` so the receiver resolves it
   *  server-side (never from the webhook wire). */
  readonly org: string;
  readonly feed: CfStreamLiveFeed;
}

/** One ingest endpoint the provisioned input exposes for the caller to push to (a push input) — the CF-issued URL
 *  and, for RTMP, the stream key. A pull input exposes none (CF fetches the source itself). */
export interface CfStreamLiveEndpoint {
  readonly protocol: IngestProtocol;
  readonly url: string;
  readonly streamKey?: string;
}

/** A provisioned CF Stream Live input: its uid (the dispatch lookup key the receiver keys everything on) + the
 *  endpoints to push to (empty for a pull input). */
export interface CfStreamLiveInput {
  readonly uid: string;
  readonly endpoints: readonly CfStreamLiveEndpoint[];
}

/** The origin's reply. Discriminated so a non-2xx CF API / KV failure carries a stable status + reason and is never
 *  mistaken for a provisioned input (mirrors the egress backend's `WaveRenderStillResult`). */
export type CfStreamLiveResult =
  | { readonly ok: true; readonly input: CfStreamLiveInput }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** The injected origin seam. The backend depends ONLY on this interface — the concrete adapter (CF Stream Live API
 *  create-input call, `stream-input-org:${uid}` KV write, endpoint parsing) is deferred to the ARM slice, so this
 *  module ships zero unverified CF-API / KV code. */
export interface CfStreamLiveClient {
  createLiveInput(req: CfStreamLiveIngestRequest): Promise<CfStreamLiveResult>;
}

/** The outcome of one provision attempt. Discriminated so the caller can tell a real provision from a plane this
 *  backend does not own (deferred) or a job that never reached a provision (unroutable) — never a silent null. */
export type IngestProvisionOutcome =
  | { readonly status: "provisioned"; readonly result: CfStreamLiveResult }
  | { readonly status: "deferred"; readonly backend: IngestBackend }
  | { readonly status: "unroutable"; readonly reason: string };

/** Build the CF Stream Live feed for an ingest job. A guard whitelist scoped to EXACTLY the `cfStreamLive` tier's
 *  kinds (rtmpPush / srtPush / urlPull → rtmp push / srt push / URL pull); ANY other kind — whip (→ SFU), rist/moq
 *  push (→ container) — returns null, because CF Stream Live does not carry it. Deliberately does NOT reuse
 *  `pushProtocolOf` (which would happily emit a rist/moq protocol): the feed set is the cfStreamLive carry set, not
 *  the container's push-protocol set. */
export function buildCfStreamLiveFeed(job: IngestJob): CfStreamLiveFeed | null {
  switch (job.sourceKind) {
    case "urlPull":
      // The router only routes urlPull to cfStreamLive after validating a non-empty sourceUrl; guard anyway.
      return job.sourceUrl ? { mode: "pull", sourceUrl: job.sourceUrl } : null;
    case "rtmpPush":
      return { mode: "push", protocol: "rtmp" };
    case "srtPush":
      return { mode: "push", protocol: "srt" };
    default:
      return null; // whip (→SFU), ristPush/moqPush (→container) are not CF Stream Live feeds
  }
}

/** The default consumer/provisioner id. */
export const CF_STREAM_LIVE_INGEST_ID = "ingress:cf-stream-live";

/**
 * The CF Stream Live ingest backend. A one-shot provisioner (NOT a tap consumer): `provision(job, ctx)` routes the
 * job through the authoritative `ingressRoute` and, ONLY when the verdict is `cfStreamLive`, asks the injected client
 * to create the live input + write its uid→org binding. Owns exactly the `cfStreamLive` plane; every other verdict is
 * DEFERRED. Holds no CF API, no KV, no clock — a pure decision + request-builder over the injected seam.
 */
export class CfStreamLiveIngestBackend {
  readonly id: string;

  constructor(
    private readonly client: CfStreamLiveClient,
    opts: { id?: string } = {},
  ) {
    this.id = opts.id ?? CF_STREAM_LIVE_INGEST_ID;
  }

  /**
   * Provision an inbound source. Routes the job, and provisions a CF Stream Live input ONLY for the `cfStreamLive`
   * verdict. A verdict for another plane is `deferred` (that backend's job); a malformed job or a missing org (the
   * binding the receiver requires) is `unroutable` with a reason — never a silent provision on bad input.
   */
  async provision(job: IngestJob, ctx: { org: string }): Promise<IngestProvisionOutcome> {
    const decision = ingressRoute(job);
    if (!decision.ok) return { status: "unroutable", reason: decision.reason };
    if (decision.backend !== "cfStreamLive") return { status: "deferred", backend: decision.backend };

    // Org is the VALUE persisted at stream-input-org:${uid}; without it the receiver fail-closes (no dispatch), so a
    // provision that could never be bridged is refused here rather than creating an orphan CF input.
    if (typeof ctx.org !== "string" || ctx.org.length === 0)
      return { status: "unroutable", reason: "cfStreamLive ingest requires a non-empty org for the uid→org binding" };

    const feed = buildCfStreamLiveFeed(job);
    if (feed === null)
      return { status: "unroutable", reason: `cfStreamLive routing produced no feed for ${job.sourceKind}` };

    const result = await this.client.createLiveInput({ room: job.room, org: ctx.org, feed });
    return { status: "provisioned", result };
  }
}

/** The backend's Env fields — declared in `wrangler.toml [vars]`, READ only once provisioning is wired into the
 *  ingest entrypoint (the ARM slice). Falsy/absent → this backend is never instantiated, prod byte-identical (like
 *  `EGRESS_ROUTER_ENABLED` / `MEDIA_TAP_ENABLED`). Arming `INGRESS_ROUTER_ENABLED` is a ◆ Jake-named crossing. */
export interface CfStreamLiveIngestEnv {
  INGRESS_ROUTER_ENABLED?: string | boolean;
  /** CF account API token with Stream scope — used by the concrete client to create live inputs (`wrangler secret
   *  put CF_STREAM_API_TOKEN`, Doppler wave/prd). Bound at the ARM slice. */
  CF_STREAM_API_TOKEN?: string;
  /** CF Stream customer code — used to build the RTMPS/SRT ingest endpoint URLs. */
  CF_STREAM_CUSTOMER_CODE?: string;
}

/** True iff routed ingress is armed. Strict, mirroring `egressRouterEnabled` / `mediaTapEnabled`: only `true` / "1" /
 *  "true" arm it; absent / "0" / anything else → OFF (inert). */
export function ingressRouterEnabled(env: CfStreamLiveIngestEnv): boolean {
  const v = env.INGRESS_ROUTER_ENABLED;
  return v === true || v === "1" || v === "true";
}
