/**
 * E-EGRESS-ROUTER P4 (#75) — the CF Stream passthrough egress BACKEND (the cheapest tier, `cfStream`; last of the
 * three egress backends behind the P1 decision core).
 *
 * The egress-router (#75 P1) decides WHERE a job goes; P2 (`egress-wave-render.ts`) serves `waveRender` and P3
 * (`egress-runpod-nvenc.ts`) serves `runpodNvenc`. This is the P4 BACKEND — the one that serves the `cfStream`
 * verdict: PASSTHROUGH. No compositing, no encode — record or RTMP-simulcast the track(s) AS-IS via Cloudflare
 * Stream. Because passthrough consumes no frames (it hands the SFU track to CF Stream, it does not composite pixels),
 * this backend is a one-shot PROVISIONER — NOT a `MediaConsumer` like the two composite backends. Given a passthrough
 * `EgressJob` (`needsCompositing:false`) + a target (which session/track to pass through, and — for simulcast — where
 * to push), it routes through the authoritative `egressRoute` and, WHEN the verdict is `cfStream`, asks the injected
 * `CfStreamEgressClient` to create the CF Stream output (a recording, or an RTMP simulcast output to an external
 * destination). Verdicts for the OTHER tiers (`waveRender` P2, `runpodNvenc` P3 — both compositing jobs) are
 * DEFERRED, not handled here: this backend owns exactly ONE tier, so a decision outside it returns a typed `deferred`
 * outcome for the owning backend to pick up. It never silently provisions a job the router sent elsewhere.
 *
 * VALIDATE THE SIMULCAST DESTINATION. A simulcast pushes to an external RTMP target the caller supplies. The
 * destination is validated to an `rtmp:`/`rtmps:` scheme before it reaches the origin seam (validate-untrusted-input-
 * before-sink) — a non-RTMP or absent destination is refused (`unroutable`) rather than handed to CF Stream. A
 * `record` output needs no destination (CF Stream stores it).
 *
 * PURE + INJECTED SEAM. Routing, job-building, and destination validation are deterministic (no clock/env/network
 * here — the decision comes from the pure router). The ONLY I/O is behind the injected `CfStreamEgressClient`
 * interface, so the whole backend is unit-testable with a fake client and NO CF-Stream-API / wire code ships in this
 * slice (the concrete adapter — CF Stream `/live_outputs` create + recording enablement, reconciled against the live
 * API — is the ARM slice). INERT: shares `EGRESS_ROUTER_ENABLED` with P2/P3 (one flag arms the router + all its
 * backends), default OFF ([vars]); nothing instantiates this backend and no room.ts edit is needed until the ◆
 * Jake-named arm crossing. Prod is byte-identical until then.
 */
import { egressRoute, type EgressBackend, type EgressJob, type EgressOutput } from "./egress-router.js";
import { egressRouterEnabled } from "./egress-wave-render.js";

/** The passthrough target: WHICH SFU track to record/simulcast, and — for a simulcast — where to push it. The job
 *  carries `output` (record vs simulcast); this carries the identity + destination the router's shape does not. */
export interface CfStreamEgressTarget {
  readonly sessionId: string;
  readonly trackName: string;
  readonly participantId: string;
  /** Required IFF the job's output is `simulcast`: the external RTMP(S) URL to push to. Validated to an rtmp/rtmps
   *  scheme before use. Absent/ignored for a `record` output (CF Stream stores the recording). */
  readonly rtmpDestination?: string;
}

/** The create-output request handed to the origin seam: the track to pass through + the output mode (+ destination
 *  for simulcast). The concrete adapter maps this onto CF Stream's recording / live-output API. */
export interface CfStreamEgressRequest {
  readonly sessionId: string;
  readonly trackName: string;
  readonly output: EgressOutput;
  readonly rtmpDestination?: string;
}

/** The origin's reply. Discriminated so a non-2xx (e.g. CF API 401/5xx) carries a stable status + reason and is never
 *  mistaken for a provisioned output. The ok branch carries the CF-issued output id (the handle the caller stops the
 *  recording / simulcast by). */
export type CfStreamEgressResult =
  | { readonly ok: true; readonly outputId: string }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** The injected origin seam. The backend depends ONLY on this interface — the concrete adapter (CF Stream API call,
 *  recording enablement / live-output create) is deferred to the ARM slice, so this module ships zero unverified
 *  wire code. */
export interface CfStreamEgressClient {
  provisionOutput(req: CfStreamEgressRequest): Promise<CfStreamEgressResult>;
}

/** The passthrough profile the backend builds its `EgressJob` from. `needsCompositing` is FALSE by definition (a
 *  passthrough never lays out sources) — a `true` here would (correctly) route to a compositing tier and be DEFERRED
 *  away from this backend. Resolution/codec are carried for a valid job shape but are moot for passthrough (CF Stream
 *  records the source as-is, no transcode). */
export interface CfStreamEgressConfig {
  readonly output: EgressOutput;
  readonly width: number;
  readonly height: number;
  readonly codec: EgressJob["codec"];
  readonly latency: EgressJob["latency"];
}

/** The default profile: a 1080p H.264 record passthrough — `needsCompositing:false`, so a single track routes to
 *  `cfStream` (cost rank 0). */
export const DEFAULT_CF_STREAM_EGRESS_CONFIG: CfStreamEgressConfig = {
  output: "record",
  width: 1920,
  height: 1080,
  codec: "h264",
  latency: "nearRealTime",
};

/** The outcome of one provision attempt. Discriminated so the caller can tell a real provision from a tier this
 *  backend does not own (deferred) or a job that never reached a provision (unroutable) — never a silent null. */
export type EgressPassthroughOutcome =
  | { readonly status: "provisioned"; readonly result: CfStreamEgressResult }
  | { readonly status: "deferred"; readonly backend: EgressBackend }
  | { readonly status: "unroutable"; readonly reason: string };

/** Build the typed passthrough `EgressJob`. `needsCompositing` is hard-FALSE (passthrough) so the router sends it to
 *  `cfStream`; `sourceCount` comes from the caller (≥1 track being passed through). */
export function buildPassthroughJob(config: CfStreamEgressConfig, sourceCount: number): EgressJob {
  return {
    needsCompositing: false,
    sourceCount,
    width: config.width,
    height: config.height,
    output: config.output,
    latency: config.latency,
    codec: config.codec,
  };
}

/** True iff `dest` is a well-formed rtmp/rtmps URL WITH a host — the only shape a simulcast may push to. A non-URL, a
 *  non-RTMP scheme (http, file, etc.), or a hostless opaque `rtmp:` URL (`rtmp:foo`, `rtmp:`, `rtmp:///x` all parse
 *  with an empty hostname because rtmp is a non-special scheme) returns false, so a malformed/hostless destination is
 *  refused before it reaches CF Stream. */
export function isValidRtmpDestination(dest: string | undefined): dest is string {
  if (typeof dest !== "string" || dest.length === 0) return false;
  let url: URL;
  try {
    url = new URL(dest);
  } catch {
    return false;
  }
  return (url.protocol === "rtmp:" || url.protocol === "rtmps:") && url.hostname.length > 0;
}

/** The default provisioner id. */
export const CF_STREAM_EGRESS_ID = "egress:cf-stream-passthrough";

/**
 * The CF Stream passthrough egress backend. A one-shot provisioner (NOT a tap consumer): `provision(job, target)`
 * routes the job through the authoritative `egressRoute` and, ONLY when the verdict is `cfStream`, asks the injected
 * client to create the CF Stream output (recording or RTMP simulcast). Owns exactly the `cfStream` tier; every other
 * verdict is DEFERRED. A simulcast with a missing/invalid RTMP destination is `unroutable` — never provisioned to an
 * unvalidated sink. Holds no CF API, no clock — a pure decision + request-builder over the injected seam.
 */
export class CfStreamPassthroughEgressBackend {
  readonly id: string;

  constructor(
    private readonly client: CfStreamEgressClient,
    opts: { id?: string } = {},
  ) {
    this.id = opts.id ?? CF_STREAM_EGRESS_ID;
  }

  /**
   * Provision a passthrough output. Routes the job, and provisions a CF Stream output ONLY for the `cfStream`
   * verdict. A verdict for a compositing tier is `deferred` (that backend's job); a malformed job, or a `simulcast`
   * without a valid rtmp/rtmps destination, is `unroutable` with a reason — never a silent provision on bad input.
   */
  async provision(job: EgressJob, target: CfStreamEgressTarget): Promise<EgressPassthroughOutcome> {
    const decision = egressRoute(job);
    if (!decision.ok) return { status: "unroutable", reason: decision.reason };
    if (decision.backend !== "cfStream") return { status: "deferred", backend: decision.backend };

    // A simulcast pushes to an external RTMP target — validate the scheme before it reaches CF Stream. A record needs
    // no destination (CF Stream stores it), so it is not gated on one.
    if (job.output === "simulcast" && !isValidRtmpDestination(target.rtmpDestination))
      return { status: "unroutable", reason: "cfStream simulcast requires a valid rtmp/rtmps destination" };

    const result = await this.client.provisionOutput({
      sessionId: target.sessionId,
      trackName: target.trackName,
      output: job.output,
      ...(job.output === "simulcast" ? { rtmpDestination: target.rtmpDestination } : {}),
    });
    return { status: "provisioned", result };
  }
}

/** The backend's Env fields — declared in `wrangler.toml [vars]`, READ only once provisioning is wired into the
 *  egress entrypoint (the ARM slice). Falsy/absent → this backend is never instantiated, prod byte-identical. Shares
 *  the `EGRESS_ROUTER_ENABLED` flag with P2/P3; arming it is a ◆ Jake-named crossing. */
export interface EgressCfStreamEnv {
  EGRESS_ROUTER_ENABLED?: string | boolean;
  /** CF account API token with Stream scope — used by the concrete client to create recordings / live outputs
   *  (`wrangler secret put CF_STREAM_API_TOKEN`, Doppler wave/prd). Bound at the ARM slice. */
  CF_STREAM_API_TOKEN?: string;
}

/** True iff routed egress is armed. Re-exports the shared reader so all three egress backends read the ONE flag
 *  through a single strict predicate (only `true` / "1" / "true" arm it; absent / "0" / other → OFF, inert). */
export { egressRouterEnabled };
