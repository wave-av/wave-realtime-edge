/**
 * E-INGRESS P4 (#77) — the CONTAINER-BRIDGE ingest BACKEND (`containerBridge`, the most-owned-compute tier; the third
 * and LAST backend behind the P1 decision core, completing the ingest backend set).
 *
 * The ingress-router (#77 P1) decides WHICH plane an inbound source goes to; P2 (`ingress-cf-stream-live.ts`) serves
 * `cfStreamLive`, P3 (`ingress-whip-sfu.ts`) serves `cfCallsSfu`. This is the P4 BACKEND — the one that serves the
 * `containerBridge` verdict: the Plane-2 per-protocol container (`ingest-bridge.ts`) that terminates a non-WebRTC push
 * protocol (rist/moq — and the self-hosted/listener rtmp/srt path) in a container, decodes → re-encodes → WHIP-
 * publishes into the SFU. It is the backstop for what CF Stream can't carry, so a valid push source is never stranded.
 *
 * REUSES the existing control plane, does NOT re-mint it. `ingest-bridge.ts` (F #55) already IS the container control
 * plane — `/start`+`/stop`, gateway-trust, server-side org, the every-15-min cron reconcile, fail-closed
 * `<PROTO>_BRIDGE_NOT_ACTIVATED` 501s. This module is the ROUTER-FACING ADAPTER over it (the sibling of P2/P3): given a
 * typed `IngestJob` + the container start context (the authenticated org + the untrusted inbound descriptor), it routes
 * through the authoritative `ingressRoute` and — WHEN the verdict is `containerBridge` — asks the injected
 * `ContainerBridgeClient` to start the per-protocol container leg. Verdicts for the OTHER planes (`cfCallsSfu` = P3,
 * `cfStreamLive` = P2) are DEFERRED, not handled here: this backend owns EXACTLY ONE plane. The `pushProtocol` the
 * container terminates is taken from the router's decision (authoritative), never re-derived from the wire.
 *
 * THE SSRF GUARD (the security value the router explicitly deferred to "the backend in P4", ingress-router.ts §L91).
 * The container is the ONE ingest path that can DIAL OUT: a self-hosted leg carries `inbound.host` — the remote origin
 * the container connects to. That host is caller-supplied (parsed from the untrusted `/start` body), so before it can
 * reach the container-dial sink it is guarded against internal/loopback/link-local/metadata/CGNAT (tailnet) targets —
 * a customer must never make our owned compute touch an internal address (validate-untrusted-input-before-sink,
 * ssrf-guard-before-user-supplied-url-fetch). The guard here is the LITERAL-IP + known-internal-name rejection a pure
 * module can do offline; the residual DNS-rebinding gap (a public name that resolves to a private IP) is closed at the
 * ARM slice, where the concrete client resolves the host and re-guards the resolved address. `guardPullUrl` is the same
 * guard as a reusable URL wrapper — the cfStreamLive pull path (P2's `urlPull` feed) uses it at ITS arm, fulfilling the
 * router's promise that the URL fetch is SSRF-guarded, from one authoritative guard rather than two.
 *
 * HEALTH / BACKPRESSURE are SURFACED, not fabricated. The container is owned compute with finite capacity; when the
 * plane is unhealthy or at-capacity the injected client returns a non-2xx `ContainerBridgeResult` (e.g. 503), which
 * this backend surfaces as `admitted` with `result.ok === false` — never mistaken for a live leg (mirrors P3's non-2xx
 * SFU test). Durable start-failure recovery already lives in the control plane's cron reconcile; this adapter does not
 * re-implement it.
 *
 * PURE + INJECTED SEAM. Routing + request-building + SSRF guarding are deterministic (no clock/env/network). The ONLY
 * I/O — the container `/start` control fetch — is behind the injected `ContainerBridgeClient` interface (the concrete
 * adapter wraps `liveIngestBridgeDeps().dispatchStart`), so the whole backend is unit-tested with a fake client and NO
 * container/CF wire code ships in this slice. INERT: shares `INGRESS_ROUTER_ENABLED` with P2/P3, default OFF ([vars]);
 * nothing instantiates this backend and no ingest-bridge.ts / room.ts edit is needed until the ◆ Jake-named arm
 * crossing. Prod is byte-identical until then.
 */
import { ingressRoute, type IngestBackend, type IngestJob } from "./ingress-router.js";
import type { IngestInbound, IngestProtocol } from "./ingest-bridge.js";
import { ingressRouterEnabled } from "./ingress-cf-stream-live.js";

/** The request handed to the container seam: the push protocol the container terminates (authoritative, from the
 *  router's decision), the target SFU room, the authenticated org (the container's DO-id + meter scope), and the
 *  GUARDED inbound descriptor. The client starts the per-protocol container leg and returns whether it went live. */
export interface ContainerBridgeStartRequest {
  readonly protocol: IngestProtocol;
  readonly room: string;
  /** The authenticated caller's org — the container is reached by the deterministic `${org}:${room}` DO id and bills
   *  under this org (server-side, never from the wire). */
  readonly org: string;
  /** The inbound leg descriptor — SSRF-guarded before it reaches this request (a present `host` has passed the guard). */
  readonly inbound: IngestInbound;
}

/** The container control plane's reply. Discriminated so a non-2xx (binding absent → 501, at-capacity → 503, a bad
 *  leg the container rejects) carries a stable status + reason and is never mistaken for a live leg (mirrors P2's
 *  `CfStreamLiveResult` / P3's `WhipPublishResult`). */
export type ContainerBridgeResult =
  | { readonly ok: true; readonly leg: { readonly protocol: IngestProtocol; readonly room: string } }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** The injected container seam. The backend depends ONLY on this interface — the concrete adapter (the `ingest-bridge`
 *  `/start` control fetch via `liveIngestBridgeDeps().dispatchStart`, plus the DNS-resolution-time SSRF re-guard) is
 *  deferred to the ARM slice, so this module ships zero unverified container/CF wire code. */
export interface ContainerBridgeClient {
  startBridge(req: ContainerBridgeStartRequest): Promise<ContainerBridgeResult>;
}

/** The outcome of one admit attempt. Discriminated so the caller can tell a real start from a plane this backend does
 *  not own (deferred) or a source that never reached the container (unroutable) — never a silent null. */
export type ContainerBridgeAdmitOutcome =
  | { readonly status: "admitted"; readonly result: ContainerBridgeResult }
  | { readonly status: "deferred"; readonly backend: IngestBackend }
  | { readonly status: "unroutable"; readonly reason: string };

/** Parse a dotted-quad into its four octets, or null if `host` is not a well-formed IPv4 literal (0-255 each). Used
 *  by the SSRF guard to range-check IP literals; a DNS name (no dotted-quad match) returns null and is name-checked. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return oct.every((o) => o >= 0 && o <= 255) ? oct : null;
}

/** True iff an IPv4 literal falls in a range a customer-supplied dial-out target must NEVER reach: this-network,
 *  private (RFC1918), CGNAT/tailnet (100.64/10), loopback, link-local + cloud metadata (169.254/16), IETF/TEST-NET,
 *  benchmarking, and multicast/reserved/broadcast (≥224). */
function isBlockedIpv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (WAVE tailnet lives here)
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 IETF + 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** Lowercased host names that always denote an internal/loopback target regardless of DNS. */
const BLOCKED_HOST_NAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
/** Name suffixes that denote a private/loopback zone (mDNS `.local`, private `.internal`, `.localhost` TLD). */
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost"];

/** Guard one caller-supplied host the container may DIAL OUT to. Returns a stable reason string when the host is an
 *  internal/loopback/link-local/metadata/CGNAT target (IP literal or known-internal name), else null (safe as far as
 *  an offline check can tell — the ARM slice re-guards the DNS-resolved address to close the rebinding gap). An IPv6
 *  literal is range-checked by known-bad prefix; a `::ffff:`-mapped or trailing embedded IPv4 is unwrapped and
 *  v4-checked. */
export function guardIngestHost(host: string): string | null {
  if (typeof host !== "string" || host.length === 0) return "inbound host is empty";
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  if (h.length === 0) return "inbound host is empty";

  const v4 = parseIpv4(h);
  if (v4) return isBlockedIpv4(v4) ? `inbound host ${host} resolves to a blocked (internal/reserved) address` : null;

  if (h.includes(":")) {
    // IPv6 literal. Reject loopback/unspecified/ULA/link-local/multicast; unwrap an embedded/mapped IPv4 and re-check.
    if (h === "::1" || h === "::") return `inbound host ${host} is an IPv6 loopback/unspecified address`;
    if (/^f[cd]/.test(h)) return `inbound host ${host} is an IPv6 unique-local (fc00::/7) address`;
    if (/^fe[89ab]/.test(h)) return `inbound host ${host} is an IPv6 link-local (fe80::/10) address`;
    if (/^ff/.test(h)) return `inbound host ${host} is an IPv6 multicast (ff00::/8) address`;
    const tail = h.slice(h.lastIndexOf(":") + 1);
    const mapped = parseIpv4(tail);
    if (mapped && isBlockedIpv4(mapped)) return `inbound host ${host} embeds a blocked IPv4 address`;
    return null; // global unicast (e.g. 2000::/3)
  }

  if (BLOCKED_HOST_NAMES.has(h)) return `inbound host ${host} is an internal name`;
  if (BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s))) return `inbound host ${host} is in a private/loopback zone`;
  return null;
}

/** True iff `host` is a safe dial-out target (the predicate form of {@link guardIngestHost}). */
export function isSafeRemoteHost(host: string): boolean {
  return guardIngestHost(host) === null;
}

/** Guard a caller-supplied PULL URL (the reusable form the router promised P4 owns — the `cfStreamLive` `urlPull` feed
 *  uses it at its ARM). Requires a parseable absolute URL over an ingest-appropriate scheme, and SSRF-guards its host
 *  with the SAME {@link guardIngestHost}. Returns a stable reason when unsafe, else null. */
export function guardPullUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return "pull url is empty";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `pull url ${raw} is not a valid absolute URL`;
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (!["http", "https", "rtmp", "rtmps", "srt"].includes(scheme))
    return `pull url scheme ${url.protocol} is not an allowed ingest scheme`;
  if (url.hostname.length === 0) return `pull url ${raw} has no host`;
  return guardIngestHost(url.hostname);
}

/** The default backend id. */
export const CONTAINER_BRIDGE_INGEST_ID = "ingress:container-bridge";

/**
 * The container-bridge ingest backend. A router-facing adapter (NOT a tap consumer): `admit(job, ctx)` routes the job
 * through the authoritative `ingressRoute` and, ONLY when the verdict is `containerBridge`, SSRF-guards the inbound
 * descriptor and asks the injected client to start the per-protocol container leg. Owns exactly the `containerBridge`
 * plane; every other verdict is DEFERRED. A missing org, a routed job with no push protocol, or an inbound host that
 * fails the SSRF guard is `unroutable` — never started on bad/unsafe input. Holds no container, no CF creds, no clock.
 */
export class ContainerBridgeIngestBackend {
  readonly id: string;

  constructor(
    private readonly client: ContainerBridgeClient,
    opts: { id?: string } = {},
  ) {
    this.id = opts.id ?? CONTAINER_BRIDGE_INGEST_ID;
  }

  /**
   * Admit a container-bridged source. Routes the job, and starts the container leg ONLY for the `containerBridge`
   * verdict. A verdict for another plane is `deferred` (that backend's job); a malformed/uncoverable job, a missing
   * org, or an inbound host that fails the SSRF guard is `unroutable` with a reason — never a silent start on
   * bad/unsafe input.
   */
  async admit(job: IngestJob, ctx: { org: string; inbound?: IngestInbound }): Promise<ContainerBridgeAdmitOutcome> {
    const decision = ingressRoute(job);
    if (!decision.ok) return { status: "unroutable", reason: decision.reason };
    if (decision.backend !== "containerBridge") return { status: "deferred", backend: decision.backend };

    // The container is reached by `${org}:${room}` + bills under the org — a leg with no org can never be dispatched.
    if (typeof ctx.org !== "string" || ctx.org.length === 0)
      return { status: "unroutable", reason: "containerBridge ingest requires an authenticated org" };

    // The router guarantees a push protocol for every containerBridge route (rist/moq/rtmp/srt); guard the type anyway.
    const protocol = decision.pushProtocol;
    if (protocol === null)
      return { status: "unroutable", reason: "containerBridge routing produced no push protocol" };

    // SSRF guard: a self-hosted leg's inbound host is the remote the container dials — never let it reach an internal
    // target before it crosses into the container-start sink. A leg with no host is a listener the container binds
    // itself (no dial-out), so the guard applies only when a host is supplied.
    const inbound: IngestInbound = ctx.inbound ?? {};
    if (inbound.host !== undefined) {
      const reason = guardIngestHost(inbound.host);
      if (reason !== null) return { status: "unroutable", reason };
    }

    const result = await this.client.startBridge({ protocol, room: job.room, org: ctx.org, inbound });
    return { status: "admitted", result };
  }
}

/** The backend's Env fields. Arming `INGRESS_ROUTER_ENABLED` (shared with P2/P3) is a ◆ Jake-named crossing; the
 *  per-protocol container bindings (`SRT_BRIDGE`/`RIST_BRIDGE`/`RTMPS_BRIDGE`/`MOQ_BRIDGE`) live in the existing
 *  `ingest-bridge.ts` runtime env and stay COMMENTED until each leg's own go-live → absent → fail-closed 501. */
export interface ContainerBridgeIngestEnv {
  INGRESS_ROUTER_ENABLED?: string | boolean;
}

/** True iff routed ingress is armed. Re-exports the shared strict reader so all three ingress backends read the ONE
 *  flag through a single predicate (only `true` / "1" / "true" arm it; absent / "0" / other → OFF, inert). */
export { ingressRouterEnabled };
