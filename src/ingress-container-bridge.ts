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

/** Parse an IPv6 literal (lowercased, zone-id/brackets already stripped) into its 8 16-bit groups, or null if it is
 *  not a well-formed IPv6 address. Handles `::` zero-compression (at most one) and a trailing embedded/mapped IPv4
 *  (`::ffff:a.b.c.d`, `::a.b.c.d`) by folding the dotted-quad into two hextets first. A non-canonical/expanded form
 *  (e.g. `0:0:0:0:0:0:0:1`) parses to the SAME groups as its compressed form, so the range checks cannot be bypassed
 *  by de-compressing the address. */
function parseIpv6(input: string): number[] | null {
  let s = input;
  const m = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (m) {
    const v4 = parseIpv4(m[2]);
    if (!v4) return null;
    s = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const halves = s.split("::");
  if (halves.length > 2) return null; // more than one "::" is invalid
  if (halves.length === 2) {
    const head = parseGroups(halves[0]);
    const tail = parseGroups(halves[1]);
    if (head === null || tail === null) return null;
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null; // "::" must stand for at least one zero group
    return [...head, ...Array<number>(gap).fill(0), ...tail];
  }
  const all = parseGroups(s);
  return all && all.length === 8 ? all : null;
}

/** True iff an 8-group IPv6 address is one a customer-supplied dial-out target must NEVER reach: unspecified (::),
 *  loopback (::1), ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), or an IPv4-mapped/compatible address
 *  whose embedded IPv4 is itself blocked. Bit-masked on the numeric groups so every textual form of a range is caught. */
function isBlockedIpv6(g: number[]): boolean {
  const embeddedV4 = (): [number, number, number, number] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  const firstSixZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (firstSixZero && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: unspecified + ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return isBlockedIpv4(embeddedV4()); // ::ffff:0:0/96 mapped
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isBlockedIpv4(embeddedV4()); // 64:ff9b::/96 NAT64 well-known prefix → embedded IPv4
  if (firstSixZero && (g[6] !== 0 || g[7] > 1)) return isBlockedIpv4(embeddedV4()); // ::a.b.c.d IPv4-compatible (deprecated)
  return false;
}

/** Lowercased host names that always denote an internal/loopback target regardless of DNS. */
const BLOCKED_HOST_NAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
/** Name suffixes that denote a private/loopback zone (mDNS `.local`, private `.internal`, `.localhost` TLD). */
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost"];

/** Canonicalize a host string through the WHATWG host parser — the SAME normalization a URL-based dialer (and
 *  `guardPullUrl`) applies — so an alternate IPv4 notation (decimal `2130706433`, hex `0x7f000001`, octal
 *  `0177.0.0.1`, shorthand `127.1`) or a non-canonical IPv6 form resolves to its canonical address, and the range
 *  check below cannot be evaded by an unusual spelling that the OS resolver would still map to an internal target.
 *  Returns the bracket-stripped canonical host, or null if it is not a parseable host (fail-closed → the caller
 *  rejects it). An IPv6 literal is bracketed for the parser, then unbracketed on return for numeric parsing. */
function normalizeHost(host: string): string | null {
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  try {
    const hn = new URL(`http://${needsBrackets ? `[${host}]` : host}`).hostname;
    return hn.startsWith("[") && hn.endsWith("]") ? hn.slice(1, -1) : hn;
  } catch {
    return null;
  }
}

/** Guard one caller-supplied host the container may DIAL OUT to. Returns a stable reason string when the host is an
 *  internal/loopback/link-local/metadata/CGNAT target (IP literal — in ANY notation — or known-internal name), else
 *  null (safe as far as an offline check can tell — the ARM slice re-guards the DNS-resolved address to close the
 *  rebinding gap). The host is first canonicalized via {@link normalizeHost} so alternate IPv4/IPv6 spellings cannot
 *  bypass the ranges; an IPv6 literal is then parsed to numeric groups and a `::ffff:`/embedded IPv4 is v4-checked. */
export function guardIngestHost(host: string): string | null {
  if (typeof host !== "string" || host.length === 0) return "inbound host is empty";
  // Strip an IPv6 zone id (`%eth0`) and brackets, then canonicalize alt-notations through the WHATWG host parser.
  const stripped = host.trim().toLowerCase().split("%")[0].replace(/^\[/, "").replace(/\]$/, "");
  if (stripped.length === 0) return "inbound host is empty";
  const h = normalizeHost(stripped);
  if (h === null) return `inbound host ${host} is not a valid host`;

  const v4 = parseIpv4(h);
  if (v4) return isBlockedIpv4(v4) ? `inbound host ${host} resolves to a blocked (internal/reserved) address` : null;

  if (h.includes(":")) {
    // IPv6 literal — parse to numeric groups so no textual form (expanded, compressed, mapped) can bypass the ranges.
    const g = parseIpv6(h);
    if (g === null) return `inbound host ${host} is not a valid IPv6 literal`;
    return isBlockedIpv6(g) ? `inbound host ${host} is a blocked (internal/reserved) IPv6 address` : null;
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
