// E-EGRESS-ROUTER P3 (#75) — the RunPod NVENC egress backend. Proves the backend OWNS EXACTLY the `runpodNvenc` GPU
// tier: it encodes (composite + NVENC) when the router routes there, DEFERS every other verdict (never encoding a job
// routed to wave-render or cfStream passthrough), refuses a malformed job, stays inert until the flag is armed, and
// attaches GROUNDED COGS computed from the worker's measured gpuSeconds × the grounded flex rate — never a fabricated
// price. Pure engine + an injected fake client — no RunPod endpoint, no network, no clock.
import { describe, it, expect } from "vitest";
import {
  RunpodNvencEgressBackend,
  DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG,
  DEFAULT_RUNPOD_NVENC_COST,
  buildEncodeJob,
  cogsUsd,
  egressRouterEnabled,
  RUNPOD_NVENC_EGRESS_ID,
  type RunpodNvencClient,
  type RunpodNvencEgressConfig,
  type RunpodNvencEncodeRequest,
  type RunpodNvencResult,
} from "../src/egress-runpod-nvenc.js";
import type { TapFrame } from "../src/media-tap.js";

/** A fake origin: records the encode requests it received and returns a canned result (artifact + gpuSeconds, or a
 *  canned non-2xx). Default reply spends 12 GPU-seconds. */
function fakeClient(
  reply: RunpodNvencResult = { ok: true, artifactKey: "r2://egress/seg-abc.mp4", codec: "hevc", gpuSeconds: 12 },
): RunpodNvencClient & { calls: RunpodNvencEncodeRequest[] } {
  const calls: RunpodNvencEncodeRequest[] = [];
  return {
    calls,
    async encode(req) {
      calls.push(req);
      return reply;
    },
  };
}

/** A video TapFrame for a given track. */
function frame(trackName: string, participantId = "p1", ts = 1000): TapFrame {
  return { sessionId: "s1", trackName, kind: "video", participantId, seq: 1, ts, bytes: new Uint8Array([1, 2, 3]) };
}

describe("RunpodNvencEgressBackend — owns the runpodNvenc tier, defers the rest", () => {
  it("encodes the heavy default profile, passing sources + geometry/codec, and attaches grounded COGS", async () => {
    const client = fakeClient();
    const be = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, client);
    be.onFrame(frame("cam-1"));
    be.onFrame(frame("cam-2", "p2"));
    const outcome = await be.encode();
    expect(outcome.status).toBe("encoded");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.codec).toBe("hevc");
    expect(client.calls[0]!.width).toBe(3840);
    expect(client.calls[0]!.sources).toHaveLength(2);
    // COGS = 12 measured GPU-seconds × $0.000528/s grounded flex rate.
    if (outcome.status === "encoded") expect(outcome.cogsUsd).toBeCloseTo(12 * 0.000528, 10);
  });

  it("DEFERS a within-envelope profile to waveRender — never encodes it on the GPU", async () => {
    const client = fakeClient();
    // 1080p H.264 near-real-time composite is inside WAVE_RENDER_CAPS → routes to waveRender, not us.
    const lightConfig: RunpodNvencEgressConfig = {
      width: 1920, height: 1080, output: "record", latency: "nearRealTime", codec: "h264", needsCompositing: true,
    };
    const be = new RunpodNvencEgressBackend(lightConfig, client);
    be.onFrame(frame("cam-1"));
    expect(await be.encode()).toEqual({ status: "deferred", backend: "waveRender" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS a passthrough (no-composite) profile to cfStream — never encodes it", async () => {
    const client = fakeClient();
    const passConfig: RunpodNvencEgressConfig = { ...DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, needsCompositing: false };
    const be = new RunpodNvencEgressBackend(passConfig, client);
    be.onFrame(frame("cam-1"));
    expect(await be.encode()).toEqual({ status: "deferred", backend: "cfStream" });
    expect(client.calls).toHaveLength(0);
  });

  it("surfaces a non-2xx origin reply (e.g. endpoint 503) without mistaking it for an artifact; COGS is null", async () => {
    const client = fakeClient({ ok: false, status: 503, reason: "runpod endpoint unavailable" });
    const be = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, client);
    be.onFrame(frame("cam-1"));
    const outcome = await be.encode();
    expect(outcome.status).toBe("encoded");
    if (outcome.status === "encoded") {
      expect(outcome.result.ok).toBe(false);
      expect(outcome.cogsUsd).toBeNull();
      if (!outcome.result.ok) expect(outcome.result.status).toBe(503);
    }
  });

  it("is `empty` when the tap has delivered no frames yet — never calls the client", async () => {
    const client = fakeClient();
    const be = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, client);
    expect(await be.encode()).toEqual({ status: "empty" });
    expect(client.calls).toHaveLength(0);
  });

  it("is `unroutable` for a malformed job (width 0) — never encodes on garbage", async () => {
    const client = fakeClient();
    const badConfig: RunpodNvencEgressConfig = { ...DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, width: 0 };
    const be = new RunpodNvencEgressBackend(badConfig, client);
    be.onFrame(frame("cam-1"));
    const outcome = await be.encode();
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/width/);
    expect(client.calls).toHaveLength(0);
  });
});

describe("RunpodNvencEgressBackend — frame tracking", () => {
  it("keeps the latest frame per track (newest wins) and reports sourceCount", async () => {
    const be = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, fakeClient());
    be.onFrame(frame("cam-1", "p1", 1000));
    be.onFrame(frame("cam-1", "p1", 2000)); // same track, newer → replaces
    be.onFrame(frame("cam-2", "p2", 1500));
    expect(be.sourceCount()).toBe(2);
  });

  it("onClose drops all held frames (nothing leaks past the room)", async () => {
    const be = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, fakeClient());
    be.onFrame(frame("cam-1"));
    be.onClose();
    expect(be.sourceCount()).toBe(0);
  });
});

describe("cogsUsd — grounded, measured, never fabricated", () => {
  it("computes measured GPU-seconds × the grounded L40S flex rate", () => {
    expect(cogsUsd(100, DEFAULT_RUNPOD_NVENC_COST)).toBeCloseTo(0.0528, 10);
    expect(DEFAULT_RUNPOD_NVENC_COST.gpuFlexUsdPerSecond).toBe(0.000528);
  });

  it("returns null for a non-finite/negative gpuSeconds (malformed readback) — never a bogus cost", () => {
    expect(cogsUsd(Number.NaN)).toBeNull();
    expect(cogsUsd(-1)).toBeNull();
    expect(cogsUsd(Infinity)).toBeNull();
  });

  it("zero GPU-seconds is a real (zero) cost, not null", () => {
    expect(cogsUsd(0)).toBe(0);
  });
});

describe("buildEncodeJob + egressRouterEnabled + defaults", () => {
  it("buildEncodeJob maps the config + live sourceCount into an EgressJob", () => {
    expect(buildEncodeJob(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, 5)).toEqual({
      needsCompositing: true, sourceCount: 5, width: 3840, height: 2160,
      output: "simulcast", latency: "realTime", codec: "hevc",
    });
  });

  it("uses the canonical id by default", () => {
    expect(new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, fakeClient()).id).toBe(RUNPOD_NVENC_EGRESS_ID);
  });

  it("egressRouterEnabled is strict: only true / '1' / 'true' arm it; absent / '0' / other → OFF (inert)", () => {
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: "1" })).toBe(true);
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: "true" })).toBe(true);
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: true })).toBe(true);
    expect(egressRouterEnabled({})).toBe(false);
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: "0" })).toBe(false);
    expect(egressRouterEnabled({ EGRESS_ROUTER_ENABLED: "yes" })).toBe(false);
  });
});
