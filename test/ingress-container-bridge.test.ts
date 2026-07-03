// E-INGRESS P4 (#77) — the container-bridge ingest backend. Proves the backend OWNS EXACTLY the `containerBridge`
// plane: it starts the per-protocol container leg when the router routes there (rist/moq), DEFERS every other verdict
// (never starting a leg for a source routed to the SFU or CF Stream Live), refuses a job with no org, and — the P4
// security value — SSRF-guards the untrusted inbound host so the container never dials an internal/loopback/metadata
// target. Plus the reusable host/URL guard the router deferred to "the backend in P4". Pure engine + injected fake
// client — no container, no CF, no clock.
import { describe, it, expect } from "vitest";
import {
  ContainerBridgeIngestBackend,
  guardIngestHost,
  isSafeRemoteHost,
  guardPullUrl,
  ingressRouterEnabled,
  CONTAINER_BRIDGE_INGEST_ID,
  type ContainerBridgeClient,
  type ContainerBridgeStartRequest,
  type ContainerBridgeResult,
} from "../src/ingress-container-bridge.js";
import type { IngestJob, IngestSourceKind } from "../src/ingress-router.js";

/** A fake container control plane: records the start requests it received and returns a canned live leg (or non-2xx). */
function fakeClient(
  reply: ContainerBridgeResult = { ok: true, leg: { protocol: "rist", room: "room-1" } },
): ContainerBridgeClient & { calls: ContainerBridgeStartRequest[] } {
  const calls: ContainerBridgeStartRequest[] = [];
  return {
    calls,
    async startBridge(req) {
      calls.push(req);
      return reply;
    },
  };
}

/** An ingest job for a given source kind into a valid room (pull URL auto-supplied for urlPull). */
function job(sourceKind: IngestSourceKind, overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    sourceKind,
    room: "room-1",
    ...(sourceKind === "urlPull" ? { sourceUrl: "https://src.example/live.m3u8" } : {}),
    ...overrides,
  };
}

const CTX = { org: "org-acme" };

describe("ContainerBridgeIngestBackend — owns the containerBridge plane, defers the rest", () => {
  it("starts a rist container leg, passing protocol + room + org + the guarded inbound", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("ristPush"), { ...CTX, inbound: { host: "push.customer.example", port: 5000 } });
    expect(outcome.status).toBe("admitted");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      protocol: "rist",
      room: "room-1",
      org: "org-acme",
      inbound: { host: "push.customer.example", port: 5000 },
    });
    if (outcome.status === "admitted" && outcome.result.ok) expect(outcome.result.leg.protocol).toBe("rist");
  });

  it("starts a moq container leg (the other CF-Stream-can't-carry backstop protocol)", async () => {
    const client = fakeClient({ ok: true, leg: { protocol: "moq", room: "room-1" } });
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("moqPush"), CTX);
    expect(outcome.status).toBe("admitted");
    expect(client.calls[0]?.protocol).toBe("moq");
    // No inbound host supplied → a listener the container binds itself → empty inbound, no SSRF rejection.
    expect(client.calls[0]?.inbound).toEqual({});
  });

  it("surfaces a non-2xx container reply (binding absent 501 / at-capacity 503) without mistaking it for a live leg", async () => {
    const client = fakeClient({ ok: false, status: 503, reason: "container plane at capacity" });
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("ristPush"), CTX);
    expect(outcome.status).toBe("admitted");
    if (outcome.status === "admitted") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(503);
    }
  });

  it("DEFERS a native WHIP source to cfCallsSfu — never starts a container for it", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    expect(await be.admit(job("whip"), CTX)).toEqual({ status: "deferred", backend: "cfCallsSfu" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS an rtmp push to cfStreamLive (the free managed path wins cost-ascending)", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    expect(await be.admit(job("rtmpPush"), CTX)).toEqual({ status: "deferred", backend: "cfStreamLive" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS a URL pull to cfStreamLive", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    expect((await be.admit(job("urlPull"), CTX)).status).toBe("deferred");
    expect(client.calls).toHaveLength(0);
  });
});

describe("ContainerBridgeIngestBackend — refuses a source that can't be admitted", () => {
  it("is `unroutable` for a malformed job (unsafe room) — never starts a leg on garbage", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("ristPush", { room: "bad:room" }), CTX);
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/room/);
    expect(client.calls).toHaveLength(0);
  });

  it("is `unroutable` when the org is missing — no anonymous container leg", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("ristPush"), { org: "" });
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/org/);
    expect(client.calls).toHaveLength(0);
  });

  it("SSRF: is `unroutable` for an inbound host on the cloud metadata IP — the container never dials it", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("ristPush"), { ...CTX, inbound: { host: "169.254.169.254" } });
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/internal|reserved/);
    expect(client.calls).toHaveLength(0);
  });

  it("SSRF: is `unroutable` for an inbound host in the CGNAT 100.64/10 range (tailnet space)", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("moqPush"), { ...CTX, inbound: { host: "100.100.100.100" } }); // # guard:allow CGNAT 100.64/10 SSRF fixture, not a fleet address
    expect(outcome.status).toBe("unroutable");
    expect(client.calls).toHaveLength(0);
  });

  it("SSRF: is `unroutable` for an internal name (localhost / *.internal)", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    expect((await be.admit(job("ristPush"), { ...CTX, inbound: { host: "localhost" } })).status).toBe("unroutable");
    expect((await be.admit(job("ristPush"), { ...CTX, inbound: { host: "cache.internal" } })).status).toBe("unroutable");
    expect(client.calls).toHaveLength(0);
  });

  it("allows a public inbound host through the guard", async () => {
    const client = fakeClient();
    const be = new ContainerBridgeIngestBackend(client);
    const outcome = await be.admit(job("ristPush"), { ...CTX, inbound: { host: "203.0.114.9" } });
    expect(outcome.status).toBe("admitted");
    expect(client.calls).toHaveLength(1);
  });
});

describe("guardIngestHost / isSafeRemoteHost — the SSRF host guard", () => {
  it("blocks IPv4 private / loopback / link-local / CGNAT / reserved ranges", () => {
    for (const bad of ["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.100.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5", "203.0.113.7"]) // # guard:allow reserved/private/CGNAT SSRF fixtures, no fleet address
      expect(isSafeRemoteHost(bad)).toBe(false);
  });

  it("blocks IPv6 loopback / ULA / link-local / multicast + mapped-IPv4-internal", () => {
    for (const bad of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "[fd00::1]"])
      expect(isSafeRemoteHost(bad)).toBe(false);
  });

  it("blocks NON-CANONICAL / expanded IPv6 forms — de-compression cannot bypass the range check", () => {
    // Fully-expanded loopback/unspecified, zero-padded hextets, uppercase, zone id, and mapped-v4 to a private addr.
    for (const bad of [
      "0:0:0:0:0:0:0:1", // expanded ::1 (the reviewed bypass)
      "0000:0000:0000:0000:0000:0000:0000:0001", // zero-padded ::1
      "0:0:0:0:0:0:0:0", // expanded ::
      "FE80:0000:0000:0000:0000:0000:0000:0001", // uppercase expanded link-local
      "fe80::1%eth0", // link-local with a zone id
      "::ffff:10.0.0.1", // mapped IPv4 → private
      "::ffff:169.254.169.254", // mapped IPv4 → cloud metadata
    ])
      expect(isSafeRemoteHost(bad)).toBe(false);
  });

  it("rejects a malformed IPv6 literal (can't prove it safe → refuse)", () => {
    expect(guardIngestHost("1::2::3")).toMatch(/not a valid IPv6/);
    expect(guardIngestHost("fe80:::1")).toMatch(/not a valid IPv6/);
  });

  it("allows public IPv4 / IPv6 / DNS names (rebinding recheck is the ARM slice's job)", () => {
    for (const ok of ["203.0.114.9", "8.8.8.8", "2606:4700:4700::1111", "push.customer.example", "ingest.example.com"])
      expect(isSafeRemoteHost(ok)).toBe(true);
  });

  it("returns an explaining reason (never a bare false) and rejects an empty host", () => {
    expect(guardIngestHost("10.0.0.1")).toMatch(/internal|reserved/);
    expect(guardIngestHost("")).toMatch(/empty/);
  });
});

describe("guardPullUrl — the reusable pull-URL SSRF guard (cfStreamLive urlPull arm)", () => {
  it("allows a public http(s) pull URL", () => {
    expect(guardPullUrl("https://cdn.example/live.m3u8")).toBeNull();
    expect(guardPullUrl("rtmps://ingest.example.com/app/key")).toBeNull();
  });

  it("blocks a pull URL whose host is internal (SSRF via the pull path)", () => {
    expect(guardPullUrl("http://169.254.169.254/latest/meta-data/")).toMatch(/internal|reserved/);
    expect(guardPullUrl("https://localhost/steal")).toMatch(/private|loopback|internal/);
  });

  it("rejects a non-URL, a disallowed scheme, and an empty input", () => {
    expect(guardPullUrl("not a url")).toMatch(/valid absolute URL/);
    expect(guardPullUrl("file:///etc/passwd")).toMatch(/scheme/);
    expect(guardPullUrl("")).toMatch(/empty/);
  });
});

describe("ids + ingressRouterEnabled", () => {
  it("uses the canonical id by default", () => {
    expect(new ContainerBridgeIngestBackend(fakeClient()).id).toBe(CONTAINER_BRIDGE_INGEST_ID);
  });

  it("ingressRouterEnabled is strict: only true / '1' / 'true' arm it; absent / '0' / other → OFF (inert)", () => {
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "1" })).toBe(true);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: true })).toBe(true);
    expect(ingressRouterEnabled({})).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "0" })).toBe(false);
  });
});
