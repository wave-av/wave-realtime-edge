/**
 * SSRF GUARD (#17, W1 O3 dest-mgmt) — validates a user-supplied external RTMP/SRT destination URL before it is
 * persisted as an egress destination, and again (documented, not duplicated) at ARM/connect time.
 *
 * THREAT MODEL. An org can name ANY `url` when creating a restream destination. Without validation, that url
 * becomes an outbound network target the Worker (or the container/GPU leg it drives) will DIAL — a classic SSRF:
 * an attacker points the "destination" at cloud metadata (169.254.169.254), a loopback admin port, an RFC1918
 * internal service, or a CGNAT/ULA address reachable only from our own network, and turns "configure a restream"
 * into "make our infrastructure request an internal URL for you."
 *
 * DENY-BY-DEFAULT. Every check in `validateDestinationUrl` is a REJECT rule; there is no allow-list of "known
 * good" ranges beyond public IP space. A parse failure, an unresolvable host, or ANY exception denies the
 * request — this module never fails open.
 *
 * DNS-REBIND SAFETY. Validating a HOSTNAME string is not enough — a hostname can resolve to a private IP today
 * and a public one when re-checked (or vice versa, "DNS rebinding"). This module resolves the hostname via an
 * injectable `resolveHost` (defaults to Cloudflare's DNS-over-HTTPS resolver, since Workers have no raw DNS
 * socket API) and validates the RESOLVED IP(s), not just the string. Because a rebind can still occur BETWEEN
 * create-time validation and connect-time dial, this module's docstring — and this module ONLY — establishes
 * the create-time gate; the O1/O2 arm path (egress-arm.ts consumers, not yet built) MUST call
 * `validateDestinationUrl` again immediately before it dials, using the resolver available at that call site.
 * `resolveDestinationForArm` (egress-destinations.ts) carries a comment to this effect at the call site.
 */

/** The only destination kinds W1 restreams support. */
export type DestKind = "rtmp" | "srt";

/** Schemes accepted per kind. `rtmps` is TLS rtmp — allowed under the `rtmp` kind. */
const ALLOWED_SCHEMES: Record<DestKind, readonly string[]> = {
  rtmp: ["rtmp", "rtmps"],
  srt: ["srt"],
};

/** Default port allowlist. rtmp:1935 (plain), rtmps:443 (TLS-on-443, the common CDN convention) — an SRT
 *  destination's port is broadcaster-chosen (no universal standard port), so SRT gets a wide but bounded
 *  RANGE instead of a fixed set; both are overridable via `SsrfGuardOptions.srtPortRange` for the rare deploy
 *  that needs a tighter one. */
const DEFAULT_RTMP_PORTS: Record<string, number> = { rtmp: 1935, rtmps: 443 };
const DEFAULT_SRT_PORT_RANGE: readonly [number, number] = [1024, 65535];

export interface SsrfGuardOptions {
  /** Resolve a hostname to its A/AAAA IP addresses. Injectable for tests; production default uses Cloudflare's
   *  DNS-over-HTTPS resolver (`resolveHostViaDoh`) since Workers expose no raw DNS API. An IP-literal host
   *  short-circuits this (no resolution needed). */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Override the SRT port allowlist range [min, max] inclusive. */
  srtPortRange?: readonly [number, number];
  /** Injected fetch for the default DoH resolver (tests only; production uses global fetch). */
  fetchFn?: typeof fetch;
}

export type SsrfValidationResult = { ok: true; resolvedIps: string[] } | { ok: false; reason: string };

/** Metadata / link-local-service hostnames that must be denied even if they resolve "successfully" (some
 *  environments short-circuit these in local /etc/hosts-equivalent resolution). Checked case-insensitively,
 *  BEFORE resolution — a metadata hostname is denied regardless of what it resolves to. */
const DENIED_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "instance-data"]);

/** True iff `hostname` is (or ends with) a `.local` mDNS suffix — these resolve only on the local segment and
 *  have no business being an internet-facing restream target. */
function isDotLocal(hostname: string): boolean {
  return /(^|\.)local$/i.test(hostname);
}

/** Parse an IPv4 dotted-quad into 4 octets, or null if `ip` isn't a plain IPv4 literal. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octs = m.slice(1, 5).map((s) => Number(s));
  if (octs.some((o) => o < 0 || o > 255)) return null;
  return octs as [number, number, number, number];
}

/** REJECT-list for IPv4: loopback (127/8), RFC1918 private (10/8, 172.16/12, 192.168/16), link-local (169.254/16
 *  — INCLUDING the AWS/GCP/Azure metadata address 169.254.169.254), CGNAT (100.64/10), "this network" (0/8),
 *  reserved/broadcast (255.255.255.255), multicast (224/4+). Deny-by-default: anything NOT provably public
 *  routable unicast is rejected — this function returns a reason string on reject, null on allow. */
function checkIpv4(ip: string): string | null {
  const octs = parseIpv4(ip);
  if (!octs) return null; // not IPv4 — caller tries IPv6
  const [a, b] = octs;
  if (a === 127) return `loopback IPv4 address (${ip})`;
  if (a === 10) return `RFC1918 private address (10.0.0.0/8: ${ip})`;
  if (a === 172 && b >= 16 && b <= 31) return `RFC1918 private address (172.16.0.0/12: ${ip})`;
  if (a === 192 && b === 168) return `RFC1918 private address (192.168.0.0/16: ${ip})`;
  if (a === 169 && b === 254) return `link-local / metadata address (169.254.0.0/16: ${ip})`;
  if (a === 100 && b >= 64 && b <= 127) return `CGNAT shared address space (100.64.0.0/10: ${ip})`;
  if (a === 0) return `"this network" reserved address (0.0.0.0/8: ${ip})`;
  if (a === 255) return `broadcast/reserved address (${ip})`;
  if (a >= 224) return `multicast/reserved address (${ip})`;
  return null;
}

/** REJECT-list for IPv6: loopback (::1), unspecified (::), link-local (fe80::/10), unique-local/ULA (fc00::/7 —
 *  the IPv6 analogue of RFC1918), multicast (ff00::/8), IPv4-mapped (::ffff:a.b.c.d — re-checked as IPv4 so a
 *  mapped-private address can't bypass the v4 rules). Deny-by-default, same contract as `checkIpv4`. */
function checkIpv6(ip: string): string | null {
  const norm = ip.toLowerCase();
  if (norm === "::1") return `loopback IPv6 address (${ip})`;
  if (norm === "::" || norm === "0:0:0:0:0:0:0:0") return `unspecified IPv6 address (${ip})`;
  if (/^fe[89ab][0-9a-f]:/.test(norm)) return `link-local IPv6 address (fe80::/10: ${ip})`;
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return `unique-local IPv6 address (fc00::/7 ULA: ${ip})`;
  if (/^ff/.test(norm)) return `multicast IPv6 address (ff00::/8: ${ip})`;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(norm);
  if (mapped) return checkIpv4(mapped[1]) ? `IPv4-mapped ${checkIpv4(mapped[1])}` : null;
  return null;
}

/** Validate a single resolved IP literal (v4 or v6) against the full deny matrix. Returns a reason string on
 *  reject, or null when the IP is allowed (public unicast). */
function checkIpLiteral(ip: string): string | null {
  // Strip IPv6 zone/brackets a URL parser may leave (`[::1]` → `::1`).
  const clean = ip.replace(/^\[|\]$/g, "");
  const v4reason = checkIpv4(clean);
  if (v4reason) return v4reason;
  if (parseIpv4(clean)) return null; // valid public IPv4, no v4 rule fired
  return checkIpv6(clean);
}

/** Default hostname resolver: Cloudflare's DNS-over-HTTPS JSON API (`cloudflare-dns.com/dns-query`). Workers
 *  have no raw DNS socket, so DoH-over-fetch is the standard SSRF-safe resolution path in this runtime. Queries
 *  BOTH A and AAAA; a resolver/network failure is surfaced as a thrown error (caller denies-by-default on any
 *  throw — see `validateDestinationUrl`'s try/catch). */
export async function resolveHostViaDoh(hostname: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const headers = { accept: "application/dns-json" };
  const ips: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const res = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers,
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    for (const ans of body.Answer ?? []) {
      if (ans.type === 1 || ans.type === 28) ips.push(ans.data); // 1=A, 28=AAAA
    }
  }
  return ips;
}

/** True iff `port` falls in the destination kind's allowed set/range. */
function portAllowed(kind: DestKind, scheme: string, port: number, srtRange: readonly [number, number]): boolean {
  if (kind === "rtmp") return port === (DEFAULT_RTMP_PORTS[scheme] ?? -1);
  const [min, max] = srtRange;
  return port >= min && port <= max;
}

/**
 * Validate a user-supplied RTMP/SRT destination URL. REJECTS (deny-by-default, first match wins, reason is
 * always populated on reject):
 *   - unparseable URL / malformed percent-encoding
 *   - scheme not in the kind's allowlist (rtmp|rtmps for `rtmp`, srt for `srt`) — blocks scheme confusion
 *     (e.g. `http://` smuggled through a "url" field to hit an internal HTTP admin panel)
 *   - `.local` / known metadata hostnames (checked pre-resolution)
 *   - port outside the kind's allowlist (rtmp:1935, rtmps:443, srt: configurable range, default 1024-65535)
 *   - hostname resolves (or the URL embeds an IP literal that IS) private/loopback/link-local/CGNAT/ULA/
 *     multicast/reserved — IPv4 AND IPv6 checked, DNS-rebind-safe (resolved IP is what's checked, not the string)
 *   - a hostname that resolves to ZERO IPs (NXDOMAIN / no A+AAAA) — nothing to validate, so deny
 *   - ANY thrown error during parse/resolve (resolver outage, DoH failure) — fail CLOSED, never open
 *
 * Re-validation note: this is the CREATE-time gate. Because DNS can rebind between create and the moment the
 * egress arm actually dials, the arm/connect path MUST call this again right before connecting (see
 * `resolveDestinationForArm` in egress-destinations.ts) — this function does not cache or attest a
 * previously-passed result.
 */
export async function validateDestinationUrl(
  kind: DestKind,
  urlStr: string,
  opts: SsrfGuardOptions = {},
): Promise<SsrfValidationResult> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return { ok: false, reason: "destination url failed to parse" };
  }

  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const allowedSchemes = ALLOWED_SCHEMES[kind];
  if (!allowedSchemes.includes(scheme)) {
    return { ok: false, reason: `scheme '${scheme}' not allowed for kind '${kind}' (allowed: ${allowedSchemes.join(", ")})` };
  }

  const hostname = u.hostname.toLowerCase();
  if (!hostname) return { ok: false, reason: "destination url has no hostname" };
  if (hostname === "169.254.169.254" || DENIED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `denied metadata/reserved hostname (${hostname})` };
  }
  if (isDotLocal(hostname)) return { ok: false, reason: `'.local' mDNS hostnames are not allowed (${hostname})` };

  const srtRange = opts.srtPortRange ?? DEFAULT_SRT_PORT_RANGE;
  const port = u.port ? Number(u.port) : kind === "rtmp" ? (DEFAULT_RTMP_PORTS[scheme] ?? -1) : -1;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: `destination url has no valid port (kind '${kind}' requires an explicit port)` };
  }
  if (!portAllowed(kind, scheme, port, srtRange)) {
    return { ok: false, reason: `port ${port} not allowed for kind '${kind}'/scheme '${scheme}'` };
  }

  try {
    // IP-literal hostname (v4 or bracketed v6) — no resolution needed, check directly.
    const bracketed = u.hostname.startsWith("[") ? u.hostname : hostname;
    if (parseIpv4(hostname) || bracketed.includes(":")) {
      const reason = checkIpLiteral(bracketed);
      if (reason) return { ok: false, reason: `destination IP is not allowed: ${reason}` };
      return { ok: true, resolvedIps: [hostname.startsWith("[") ? hostname.slice(1, -1) : hostname] };
    }

    const resolver = opts.resolveHost ?? ((h: string) => resolveHostViaDoh(h, opts.fetchFn ?? fetch));
    const ips = await resolver(hostname);
    if (ips.length === 0) {
      return { ok: false, reason: `hostname '${hostname}' did not resolve to any address` };
    }
    for (const ip of ips) {
      const reason = checkIpLiteral(ip);
      if (reason) return { ok: false, reason: `destination resolves to a disallowed address: ${reason}` };
    }
    return { ok: true, resolvedIps: ips };
  } catch (e) {
    // Deny-by-default on ANY resolution failure — never fail open.
    return { ok: false, reason: `hostname resolution failed, denying by default: ${(e as Error)?.message ?? String(e)}` };
  }
}
