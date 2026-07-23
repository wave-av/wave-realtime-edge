// E-EGRESS-ROUTER P4 (#75) — the CF Stream passthrough egress backend. Proves the backend OWNS EXACTLY the `cfStream`
// tier: it provisions a passthrough output (record or RTMP simulcast) when the router routes there, DEFERS every
// compositing verdict (never provisioning a job routed to wave-render or the GPU tier), validates the simulcast
// destination scheme, and refuses a malformed job. Pure engine + an injected fake client — no CF Stream API, no clock.
import { describe, it, expect } from "vitest";
import {
  CfStreamPassthroughEgressBackend,
  DEFAULT_CF_STREAM_EGRESS_CONFIG,
  buildPassthroughJob,
  isValidRtmpDestination,
  egressRouterEnabled,
  CF_STREAM_EGRESS_ID,
  type CfStreamEgressClient,
  type CfStreamEgressRequest,
  type CfStreamEgressResult,
  type CfStreamEgressTarget,
} from "../src/egress-cf-stream-passthrough.js";
import type { EgressJob } from "../src/egress-router.js";
import { CfStreamEgressLiveOutputClient } from "../src/egress-cf-stream-live-output-client.js";

/** A fake origin: records the create-output requests it received and returns a canned output id (or a canned non-2xx). */
function fakeClient(
  reply: CfStreamEgressResult = { ok: true, outputId: "lo-xyz789" },
): CfStreamEgressClient & { calls: CfStreamEgressRequest[] } {
  const calls: CfStreamEgressRequest[] = [];
  return {
    calls,
    async provisionOutput(req) {
      calls.push(req);
      return reply;
    },
  };
}

const TARGET: CfStreamEgressTarget = { sessionId: "sess-1", trackName: "cam-1", participantId: "p1" };

/** A compositing job (needsCompositing:true) that the router sends to a compositing tier — never to cfStream. */
function compositingJob(over = false): EgressJob {
  return over
    ? { needsCompositing: true, sourceCount: 1, width: 3840, height: 2160, output: "record", latency: "realTime", codec: "hevc" }
    : { needsCompositing: true, sourceCount: 1, width: 1920, height: 1080, output: "record", latency: "nearRealTime", codec: "h264" };
}

describe("CfStreamPassthroughEgressBackend — owns the cfStream tier, defers the rest", () => {
  it("provisions a record passthrough, passing session + track + record output (no destination)", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    const outcome = await be.provision(buildPassthroughJob(DEFAULT_CF_STREAM_EGRESS_CONFIG, 1), TARGET);
    expect(outcome.status).toBe("provisioned");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({ sessionId: "sess-1", trackName: "cam-1", output: "record" });
    if (outcome.status === "provisioned" && outcome.result.ok) expect(outcome.result.outputId).toBe("lo-xyz789");
  });

  it("provisions a simulcast to a valid rtmp destination, forwarding it to the client", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    const job = buildPassthroughJob({ ...DEFAULT_CF_STREAM_EGRESS_CONFIG, output: "simulcast" }, 1);
    const outcome = await be.provision(job, { ...TARGET, rtmpDestination: "rtmp://live.example/app/key" });
    expect(outcome.status).toBe("provisioned");
    expect(client.calls[0]).toEqual({
      sessionId: "sess-1", trackName: "cam-1", output: "simulcast", rtmpDestination: "rtmp://live.example/app/key",
    });
  });

  it("accepts an rtmps destination too", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    const job = buildPassthroughJob({ ...DEFAULT_CF_STREAM_EGRESS_CONFIG, output: "simulcast" }, 1);
    expect((await be.provision(job, { ...TARGET, rtmpDestination: "rtmps://live.example/app/key" })).status).toBe("provisioned");
  });

  it("is `unroutable` for a simulcast with NO destination — never provisions to an unvalidated sink", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    const job = buildPassthroughJob({ ...DEFAULT_CF_STREAM_EGRESS_CONFIG, output: "simulcast" }, 1);
    const outcome = await be.provision(job, TARGET);
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/rtmp/);
    expect(client.calls).toHaveLength(0);
  });

  it("is `unroutable` for a simulcast to a non-RTMP scheme (http) — scheme is validated before the sink", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    const job = buildPassthroughJob({ ...DEFAULT_CF_STREAM_EGRESS_CONFIG, output: "simulcast" }, 1);
    const outcome = await be.provision(job, { ...TARGET, rtmpDestination: "http://evil.example/steal" });
    expect(outcome.status).toBe("unroutable");
    expect(client.calls).toHaveLength(0);
  });

  // wre#320 sec-review MEDIUM fix: the passthrough backend gated only on `isValidRtmpDestination` (scheme-only)
  // and called `client.provisionOutput` directly with NO SSRF-at-connect re-check of its own. Prove the gap is
  // now closed at the SHARED chokepoint (`CfStreamEgressLiveOutputClient.provisionOutput`) — wiring the backend
  // to the REAL concrete client (not a bare fake) shows this provision path ALSO refuses a destination whose
  // resolved IP is private/metadata, exactly like the O1 arm path already did.
  it("refuses a simulcast whose rtmpDestination resolves to a private/metadata IP — SSRF-at-connect chokepoint", async () => {
    const rebindResolver = async (h: string) => (h === "internal.example" ? ["169.254.169.254"] : []);
    const realClient = new CfStreamEgressLiveOutputClient({
      accountId: "acct123",
      apiToken: "tok",
      fetchFn: (async () => new Response(JSON.stringify({ success: true, result: { uid: "should-not-be-called" } }))) as typeof fetch,
      resolveHost: rebindResolver,
    });
    const be = new CfStreamPassthroughEgressBackend(realClient);
    const job = buildPassthroughJob({ ...DEFAULT_CF_STREAM_EGRESS_CONFIG, output: "simulcast" }, 1);
    const outcome = await be.provision(job, {
      sessionId: "cfstream:28064cd43cee30dd62c728da2152c61d",
      trackName: "cam-1",
      participantId: "p1",
      rtmpDestination: "rtmp://internal.example:1935/app/key",
    });
    expect(outcome.status).toBe("provisioned");
    if (outcome.status === "provisioned") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) {
        expect(outcome.result.status).toBe(403);
        expect(outcome.result.reason).toMatch(/SSRF-at-connect/);
      }
    }
  });

  it("DEFERS a within-envelope compositing job to waveRender — never provisions a passthrough for it", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    expect(await be.provision(compositingJob(false), TARGET)).toEqual({ status: "deferred", backend: "waveRender" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS an over-envelope compositing job to runpodNvenc", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    expect(await be.provision(compositingJob(true), TARGET)).toEqual({ status: "deferred", backend: "runpodNvenc" });
    expect(client.calls).toHaveLength(0);
  });

  it("surfaces a non-2xx origin reply (e.g. CF API 401) without mistaking it for a provisioned output", async () => {
    const client = fakeClient({ ok: false, status: 401, reason: "cf api unauthorized" });
    const be = new CfStreamPassthroughEgressBackend(client);
    const outcome = await be.provision(buildPassthroughJob(DEFAULT_CF_STREAM_EGRESS_CONFIG, 1), TARGET);
    expect(outcome.status).toBe("provisioned");
    if (outcome.status === "provisioned") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(401);
    }
  });

  it("is `unroutable` for a malformed job (width 0) — never provisions on garbage", async () => {
    const client = fakeClient();
    const be = new CfStreamPassthroughEgressBackend(client);
    const outcome = await be.provision({ ...buildPassthroughJob(DEFAULT_CF_STREAM_EGRESS_CONFIG, 1), width: 0 }, TARGET);
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/width/);
    expect(client.calls).toHaveLength(0);
  });
});

describe("isValidRtmpDestination + buildPassthroughJob + defaults", () => {
  it("accepts rtmp/rtmps only; rejects other schemes, non-URLs, and empty", () => {
    expect(isValidRtmpDestination("rtmp://a/b")).toBe(true);
    expect(isValidRtmpDestination("rtmps://a/b")).toBe(true);
    expect(isValidRtmpDestination("http://a/b")).toBe(false);
    expect(isValidRtmpDestination("file:///etc/passwd")).toBe(false);
    expect(isValidRtmpDestination("not a url")).toBe(false);
    expect(isValidRtmpDestination("")).toBe(false);
    expect(isValidRtmpDestination(undefined)).toBe(false);
    // Hostless opaque rtmp: URLs parse with protocol rtmp: but an empty hostname — must be rejected.
    expect(isValidRtmpDestination("rtmp:foo")).toBe(false);
    expect(isValidRtmpDestination("rtmp:")).toBe(false);
    expect(isValidRtmpDestination("rtmp:///nohost")).toBe(false);
  });

  it("buildPassthroughJob is always needsCompositing:false (passthrough), carrying config + sourceCount", () => {
    expect(buildPassthroughJob(DEFAULT_CF_STREAM_EGRESS_CONFIG, 2)).toEqual({
      needsCompositing: false, sourceCount: 2, width: 1920, height: 1080,
      output: "record", latency: "nearRealTime", codec: "h264",
    });
  });

  it("uses the canonical id by default", () => {
    expect(new CfStreamPassthroughEgressBackend(fakeClient()).id).toBe(CF_STREAM_EGRESS_ID);
  });

  it("egressRouterEnabled is strict: only true / '1' / 'true' arm it; absent / '0' / other → OFF (inert)", () => {
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: "1" })).toBe(true);
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: true })).toBe(true);
    expect(egressRouterEnabled({})).toBe(false);
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: "0" })).toBe(false);
  });
});
