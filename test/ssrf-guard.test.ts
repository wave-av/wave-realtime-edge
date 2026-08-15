// #17 SSRF guard — the highest-value security surface in W1 O3. Proves the DENY matrix (RFC1918/loopback/
// link-local incl. metadata/CGNAT/ULA/multicast/reserved), the ALLOW path for public addresses, scheme/port
// allowlisting per kind, `.local`/metadata hostname denial pre-resolution, DNS-rebind-safety (resolved IP is
// what's checked, not the string), zero-IP resolution denial, and fail-closed on a thrown resolver error.
import { describe, it, expect } from "vitest";
import { validateDestinationUrl } from "../src/ssrf-guard.js";

function resolver(map: Record<string, string[]>) {
  return async (hostname: string) => map[hostname] ?? [];
}

describe("validateDestinationUrl — deny matrix", () => {
  const denyCases: Array<[string, string, string, ("rtmp" | "srt")?]> = [
    ["loopback IPv4", "rtmp://127.0.0.1:1935/live", "loopback"],
    ["RFC1918 10/8", "rtmp://10.0.0.5:1935/live", "10.0.0.0/8"],
    ["RFC1918 172.16/12", "rtmp://172.16.5.5:1935/live", "172.16.0.0/12"],
    ["RFC1918 192.168/16", "rtmp://192.168.1.1:1935/live", "192.168.0.0/16"],
    ["link-local / metadata IP", "rtmp://169.254.169.254:1935/live", "metadata"],
    ["CGNAT 100.64/10", "rtmp://100.64.0.1:1935/live", "100.64.0.0/10"], // # guard:allow SSRF denylist test literal — CGNAT range is the block target, not a leaked fleet address
    ["0.0.0.0/8", "rtmp://0.0.0.1:1935/live", "this network"],
    ["broadcast", "rtmp://255.255.255.255:1935/live", "broadcast"],
    ["multicast v4", "rtmp://224.0.0.1:1935/live", "multicast"],
    ["loopback IPv6", "rtmp://[::1]:1935/live", "loopback"],
    ["link-local IPv6", "rtmp://[fe80::1]:1935/live", "link-local"],
    ["ULA IPv6", "rtmp://[fc00::1]:1935/live", "unique-local"],
    ["multicast IPv6", "rtmp://[ff02::1]:1935/live", "multicast"],
    ["IPv4-mapped private", "rtmp://[::ffff:10.0.0.5]:1935/live", "10.0.0.0/8"],
    // Non-special schemes (rtmp/srt) canonicalize a bracketed IPv4-mapped literal to HEX-GROUP form
    // (`::ffff:a.b.c.d` -> `::ffff:hi:lo`), not the dotted-quad textual form — these prove the guard catches
    // BOTH forms rather than only the textual one a naive regex would match.
    ["IPv4-mapped metadata, textual form", "srt://[::ffff:169.254.169.254]:5000", "169.254", "srt"],
    ["IPv4-mapped loopback, textual form", "srt://[::ffff:127.0.0.1]:5000", "loopback", "srt"],
    ["IPv4-mapped metadata, hex-group form (as URL parser canonicalizes it)", "srt://[::ffff:a9fe:a9fe]:5000", "169.254", "srt"],
    ["IPv4-mapped loopback, hex-group form (as URL parser canonicalizes it)", "srt://[::ffff:7f00:1]:5000", "loopback", "srt"],
    ["IPv4-mapped private 10/8, hex-group form", "rtmp://[::ffff:a00:5]:1935/live", "10.0.0.0/8"],
    // Trailing-dot FQDN fast-path bypass: a hostname with a trailing root-label "." must still hit the
    // metadata-literal and `.local` fast paths, not skip them and fall through to DNS resolution.
    ["metadata IP with trailing dot skips fast path", "rtmp://169.254.169.254.:1935/live", "metadata"],
  ];
  for (const [name, url, expectedFrag, kind] of denyCases) {
    it(`denies ${name} (${url})`, async () => {
      const res = await validateDestinationUrl(kind ?? "rtmp", url);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason.toLowerCase()).toContain(expectedFrag.toLowerCase());
    });
  }

  it("denies a '.local' hostname with a trailing dot ('foo.local.')", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://box.local.:1935/x", { resolveHost: resolver({}) });
    expect(res.ok).toBe(false);
  });

  it("denies metadata.google.internal by hostname pre-resolution", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://metadata.google.internal:1935/x", {
      resolveHost: resolver({}),
    });
    expect(res.ok).toBe(false);
  });

  it("denies a '.local' mDNS hostname", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://box.local:1935/x", { resolveHost: resolver({}) });
    expect(res.ok).toBe(false);
  });

  it("denies a hostname that resolves to a private IP (DNS-rebind-safe: checks resolved IP, not string)", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://evil.example.com:1935/live", {
      resolveHost: resolver({ "evil.example.com": ["10.1.2.3"] }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("10.0.0.0/8");
  });

  it("denies a hostname that resolves to zero addresses", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://nowhere.example.com:1935/live", {
      resolveHost: resolver({}),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("did not resolve");
  });

  it("fails CLOSED when the resolver throws (never fails open)", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://flaky.example.com:1935/live", {
      resolveHost: async () => {
        throw new Error("DoH network error");
      },
    });
    expect(res.ok).toBe(false);
  });

  it("denies an unparseable url", async () => {
    const res = await validateDestinationUrl("rtmp", "not a url", {});
    expect(res.ok).toBe(false);
  });

  it("denies scheme confusion (http smuggled into an rtmp field)", async () => {
    const res = await validateDestinationUrl("rtmp", "http://example.com/admin", { resolveHost: resolver({ "example.com": ["93.184.216.34"] }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("scheme");
  });

  it("denies srt scheme used against an rtmp destination", async () => {
    const res = await validateDestinationUrl("rtmp", "srt://example.com:1935/live", {});
    expect(res.ok).toBe(false);
  });

  it("denies a non-allowlisted port for rtmp", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://example.com:8080/live", {
      resolveHost: resolver({ "example.com": ["93.184.216.34"] }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("port");
  });
});

describe("validateDestinationUrl — allow path", () => {
  it("allows a public IPv4 rtmp destination on port 1935", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://93.184.216.34:1935/live/key");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resolvedIps).toEqual(["93.184.216.34"]);
  });

  it("allows rtmps on port 443", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmps://93.184.216.34:443/live/key");
    expect(res.ok).toBe(true);
  });

  it("allows a public hostname that resolves to a public IP", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://live.example.com:1935/app/key", {
      resolveHost: resolver({ "live.example.com": ["93.184.216.34"] }),
    });
    expect(res.ok).toBe(true);
  });

  it("allows srt within the configurable port range", async () => {
    const res = await validateDestinationUrl("srt", "srt://93.184.216.34:9710?streamid=x", {
      srtPortRange: [9000, 9999],
    });
    expect(res.ok).toBe(true);
  });

  it("denies srt outside a configured narrower port range", async () => {
    const res = await validateDestinationUrl("srt", "srt://93.184.216.34:20000?streamid=x", {
      srtPortRange: [9000, 9999],
    });
    expect(res.ok).toBe(false);
  });

  it("allows a public IPv4-mapped IPv6 literal, hex-group form (no over-blocking)", async () => {
    // 93.184.216.34 = 0x5db8d822 -> hi=0x5db8, lo=0xd822
    const res = await validateDestinationUrl("srt", "srt://[::ffff:5db8:d822]:5000");
    expect(res.ok).toBe(true);
  });

  it("allows a public IPv4-mapped IPv6 literal, dotted-quad textual form (no over-blocking)", async () => {
    const res = await validateDestinationUrl("srt", "srt://[::ffff:93.184.216.34]:5000");
    expect(res.ok).toBe(true);
  });

  it("a hostname resolving to BOTH a public and a private IP is denied (any bad IP denies the whole set)", async () => {
    const res = await validateDestinationUrl("rtmp", "rtmp://mixed.example.com:1935/live", {
      resolveHost: resolver({ "mixed.example.com": ["93.184.216.34", "10.0.0.1"] }),
    });
    expect(res.ok).toBe(false);
  });
});
