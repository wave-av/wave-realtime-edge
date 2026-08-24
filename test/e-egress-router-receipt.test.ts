// E-EGRESS-ROUTER (#75) receipt test — proves the routed-egress lifecycle through the real router state machine:
//   route selection across all 3 backends (cfStream / waveRender / runpodNvenc) with mocked upstreams —
//   recording via cfStream passthrough, branded composite via waveRender, heavy GPU encode via runpodNvenc,
//   cost-ceiling enforcement, deferred outcomes, and the full MediaTap→backend lifecycle.
// Arming: EGRESS_ROUTER_ENABLED="1" (test path only). Headless — uses the real egressRoute + all three
// backend classes with mocked client seams (no CF Stream API, no wave-render origin, no RunPod endpoint).
import { describe, it, expect } from "vitest";
import {
  egressRoute,
  WAVE_RENDER_CAPS,
  type EgressJob,
} from "../src/egress-router.js";
import {
  WaveRenderEgressBackend,
  DEFAULT_WAVE_RENDER_EGRESS_CONFIG,
  type WaveRenderClient,
  type WaveRenderEgressConfig,
} from "../src/egress-wave-render.js";
import {
  RunpodNvencEgressBackend,
  DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG,
  cogsUsd,
  type RunpodNvencClient,
  type RunpodNvencEgressConfig,
} from "../src/egress-runpod-nvenc.js";
import {
  CfStreamPassthroughEgressBackend,
  type CfStreamEgressClient,
  type CfStreamEgressTarget,
  isValidRtmpDestination,
} from "../src/egress-cf-stream-passthrough.js";
import type { TapFrame } from "../src/media-tap.js";

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

const VIDEO_BYTES = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
let seqCounter = 0;

/** Build a TapFrame with a unique monotonic seq (satisfies the TapFrame interface). */
function frame(overrides: Partial<TapFrame> = {}): TapFrame {
  return {
    sessionId: "sfu-A",
    trackName: "cam",
    kind: "video",
    participantId: "alice",
    seq: ++seqCounter,
    ts: 1000,
    bytes: VIDEO_BYTES,
    ...overrides,
  };
}

/** Stub wave-render client — returns a fixed still image. */
function stubWaveRenderClient(ok = true): WaveRenderClient {
  return {
    async renderStill() {
      return ok
        ? { ok: true, image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }
        : { ok: false, status: 503, reason: "wave-render unavailable" };
    },
  };
}

/** Stub RunPod NVENC client — returns a fixed artifact with measured GPU seconds. */
function stubRunpodNvencClient(ok = true, gpuSeconds = 4.2): RunpodNvencClient {
  return {
    async encode() {
      return ok
        ? { ok: true, artifactKey: "nvenc-artifact-001", codec: "hevc", gpuSeconds }
        : { ok: false, status: 500, reason: "RunPod encode failed" };
    },
  };
}

/** Stub CF Stream client — returns a fixed output id. */
function stubCfStreamClient(ok = true): CfStreamEgressClient {
  return {
    async provisionOutput() {
      return ok
        ? { ok: true, outputId: "cf-stream-output-001" }
        : { ok: false, status: 401, reason: "CF Stream auth failed" };
    },
  };
}

/** Build a passthrough (no-composite) job. */
function passthroughJob(overrides: Partial<EgressJob> = {}): EgressJob {
  return {
    needsCompositing: false,
    sourceCount: 1,
    width: 1920,
    height: 1080,
    output: "record",
    latency: "nearRealTime",
    codec: "h264",
    ...overrides,
  };
}

/** Build a composite job that routes to waveRender. */
function waveRenderJob(overrides: Partial<EgressJob> = {}): EgressJob {
  return {
    needsCompositing: true,
    sourceCount: 2,
    width: 1920,
    height: 1080,
    output: "record",
    latency: "nearRealTime",
    codec: "h264",
    ...overrides,
  };
}

/** Build a composite job that exceeds waveRender envelope → routes to runpodNvenc. */
function runpodJob(overrides: Partial<EgressJob> = {}): EgressJob {
  return {
    needsCompositing: true,
    sourceCount: 2,
    width: 3840,
    height: 2160,
    output: "simulcast",
    latency: "realTime",
    codec: "hevc",
    ...overrides,
  };
}

// ── receipt: full lifecycle ──────────────────────────────────────────────────────────────────────────────────

describe("E-EGRESS-ROUTER receipt — routed-egress lifecycle across all 3 backends", () => {
  it("1. route selection: cfStream for passthrough recording (cheapest tier)", () => {
    const decision = egressRoute(passthroughJob());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("cfStream");
      expect(decision.costRank).toBe(0);
    }
  });

  it("2. route selection: waveRender for within-envelope branded composite (default tier)", () => {
    const decision = egressRoute(waveRenderJob());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("waveRender");
      expect(decision.costRank).toBe(1);
    }
  });

  it("3. route selection: runpodNvenc for heavy GPU composite exceeding waveRender envelope", () => {
    const decision = egressRoute(runpodJob());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("runpodNvenc");
      expect(decision.costRank).toBe(2);
    }
  });

  it("4. cfStream passthrough: provisions a recording via mocked CF Stream upstream", async () => {
    const backend = new CfStreamPassthroughEgressBackend(stubCfStreamClient());
    const target: CfStreamEgressTarget = { sessionId: "sess-001", trackName: "cam", participantId: "alice" };
    const outcome = await backend.provision(passthroughJob(), target);
    expect(outcome.status).toBe("provisioned");
    if (outcome.status === "provisioned") {
      expect(outcome.result.ok).toBe(true);
      if (outcome.result.ok) expect(outcome.result.outputId).toBe("cf-stream-output-001");
    }
  });

  it("5. cfStream passthrough: provisions an RTMP simulcast with valid destination", async () => {
    const backend = new CfStreamPassthroughEgressBackend(stubCfStreamClient());
    const target: CfStreamEgressTarget = {
      sessionId: "sess-002",
      trackName: "cam",
      participantId: "alice",
      rtmpDestination: "rtmp://live.twitch.tv/app/stream-key",
    };
    const outcome = await backend.provision(passthroughJob({ output: "simulcast" }), target);
    expect(outcome.status).toBe("provisioned");
    if (outcome.status === "provisioned") expect(outcome.result.ok).toBe(true);
  });

  it("6. cfStream passthrough: refuses simulcast without valid RTMP destination", async () => {
    const backend = new CfStreamPassthroughEgressBackend(stubCfStreamClient());
    const target: CfStreamEgressTarget = { sessionId: "sess-003", trackName: "cam", participantId: "alice" };
    const outcome = await backend.provision(passthroughJob({ output: "simulcast" }), target);
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/valid rtmp\/rtmps destination/);
  });

  it("7. waveRender: renders a branded composite still via mocked wave-render upstream", async () => {
    const backend = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, stubWaveRenderClient());
    backend.onFrame(frame({ trackName: "cam-alice", participantId: "alice" }));
    backend.onFrame(frame({ trackName: "cam-bob", participantId: "bob" }));
    expect(backend.sourceCount()).toBe(2);
    const outcome = await backend.render();
    expect(outcome.status).toBe("rendered");
    if (outcome.status === "rendered") {
      expect(outcome.result.ok).toBe(true);
      if (outcome.result.ok) expect(outcome.result.contentType).toBe("image/png");
    }
  });

  it("8. waveRender: defers when config routes to a different tier (passthrough profile)", async () => {
    const cfg: WaveRenderEgressConfig = { ...DEFAULT_WAVE_RENDER_EGRESS_CONFIG, needsCompositing: false };
    const backend = new WaveRenderEgressBackend(cfg, stubWaveRenderClient());
    backend.onFrame(frame());
    const outcome = await backend.render();
    expect(outcome.status).toBe("deferred");
    if (outcome.status === "deferred") expect(outcome.backend).toBe("cfStream");
  });

  it("9. runpodNvenc: encodes a heavy GPU composite via mocked RunPod upstream + grounded COGS", async () => {
    const gpuSeconds = 4.2;
    const backend = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, stubRunpodNvencClient(true, gpuSeconds));
    backend.onFrame(frame({ trackName: "cam-alice", participantId: "alice" }));
    backend.onFrame(frame({ trackName: "cam-bob", participantId: "bob" }));
    expect(backend.sourceCount()).toBe(2);
    const outcome = await backend.encode();
    expect(outcome.status).toBe("encoded");
    if (outcome.status === "encoded") {
      expect(outcome.result.ok).toBe(true);
      // RunpodNvencResult is a union — narrow to the artifactKey variant
      if (outcome.result.ok && "artifactKey" in outcome.result) {
        expect(outcome.result.artifactKey).toBe("nvenc-artifact-001");
      }
      // Grounded COGS: measured gpuSeconds × flex rate
      expect(outcome.cogsUsd).toBe(cogsUsd(gpuSeconds));
      expect(outcome.cogsUsd).toBeCloseTo(0.0022176, 6);
    }
  });

  it("10. runpodNvenc: defers when config routes to a different tier (wave-render envelope)", async () => {
    const cfg: RunpodNvencEgressConfig = {
      ...DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG,
      width: 1920, height: 1080, codec: "h264", latency: "nearRealTime",
    };
    const backend = new RunpodNvencEgressBackend(cfg, stubRunpodNvencClient());
    backend.onFrame(frame());
    const outcome = await backend.encode();
    expect(outcome.status).toBe("deferred");
    if (outcome.status === "deferred") expect(outcome.backend).toBe("waveRender");
  });

  it("11. runpodNvenc: returns empty when no frames received yet", async () => {
    const backend = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, stubRunpodNvencClient());
    const outcome = await backend.encode();
    expect(outcome.status).toBe("empty");
  });

  it("12. cost-ceiling enforcement: maxCostRank=0 rejects a composite job (no GPU, no wave-render)", () => {
    const decision = egressRoute(waveRenderJob({ maxCostRank: 0 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/no capable egress backend/);
  });

  it("13. cost-ceiling enforcement: maxCostRank=1 — heavy job rejected (waveRender envelope exceeded, runpodNvenc above ceiling)", () => {
    const decision = egressRoute(runpodJob({ maxCostRank: 1 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/no capable egress backend/);
  });

  it("14. cheapest-tier-first invariant: within-envelope composite always picks waveRender over runpodNvenc", () => {
    const decision = egressRoute(waveRenderJob());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("waveRender");
      expect(decision.costRank).toBe(1);
    }
  });

  it("15. fallback escalation: 10 sources (over waveRender max 9) escalates to runpodNvenc", () => {
    const decision = egressRoute(waveRenderJob({ sourceCount: WAVE_RENDER_CAPS.maxSources + 1 }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("16. HEVC codec escalates to runpodNvenc (waveRender only supports h264)", () => {
    const decision = egressRoute(waveRenderJob({ codec: "hevc" }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("17. real-time latency escalates to runpodNvenc (waveRender only supports batch/nearRealTime)", () => {
    const decision = egressRoute(waveRenderJob({ latency: "realTime" }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("18. 4K resolution exceeds waveRender envelope → escalates to runpodNvenc", () => {
    const decision = egressRoute(waveRenderJob({ width: 3840, height: 2160 }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("19. malformed job carries a stable reason (no-throw boundary)", () => {
    const decision = egressRoute({} as unknown as EgressJob);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(typeof decision.reason).toBe("string");
  });

  it("20. waveRender: returns empty when no frames received yet", async () => {
    const backend = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, stubWaveRenderClient());
    const outcome = await backend.render();
    expect(outcome.status).toBe("empty");
  });

  it("21. waveRender: clears frames on close (GC after room ends)", async () => {
    const backend = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, stubWaveRenderClient());
    backend.onFrame(frame());
    expect(backend.sourceCount()).toBe(1);
    backend.onClose();
    expect(backend.sourceCount()).toBe(0);
    const outcome = await backend.render();
    expect(outcome.status).toBe("empty");
  });

  it("22. runpodNvenc: clears frames on close (GC after room ends)", async () => {
    const backend = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, stubRunpodNvencClient());
    backend.onFrame(frame());
    expect(backend.sourceCount()).toBe(1);
    backend.onClose();
    expect(backend.sourceCount()).toBe(0);
    const outcome = await backend.encode();
    expect(outcome.status).toBe("empty");
  });

  it("23. isValidRtmpDestination: validates rtmp/rtmps scheme + hostname", () => {
    expect(isValidRtmpDestination("rtmp://live.twitch.tv/app/key")).toBe(true);
    expect(isValidRtmpDestination("rtmps://live.youtube.com/push/stream")).toBe(true);
    expect(isValidRtmpDestination("http://example.com/live")).toBe(false);
    expect(isValidRtmpDestination("rtmp:")).toBe(false);
    expect(isValidRtmpDestination("rtmp:foo")).toBe(false);
    expect(isValidRtmpDestination(undefined)).toBe(false);
    expect(isValidRtmpDestination("")).toBe(false);
  });

  it("24. grounded COGS: null for non-finite gpuSeconds", () => {
    expect(cogsUsd(NaN)).toBeNull();
    expect(cogsUsd(Infinity)).toBeNull();
    expect(cogsUsd(-1)).toBeNull();
  });

  it("25. grounded COGS: correct arithmetic for measured gpuSeconds", () => {
    expect(cogsUsd(10.0)).toBeCloseTo(0.00528, 6);
  });

  it("26. AV1 codec escalates to runpodNvenc (waveRender h264 only)", () => {
    const decision = egressRoute(waveRenderJob({ codec: "av1" }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("27. VP8 codec escalates to runpodNvenc (waveRender h264 only)", () => {
    const decision = egressRoute(waveRenderJob({ codec: "vp8" }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("28. VP9 codec escalates to runpodNvenc (waveRender h264 only)", () => {
    const decision = egressRoute(waveRenderJob({ codec: "vp9" }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("29. cfStream: outcome carries upstream error when client fails", async () => {
    const backend = new CfStreamPassthroughEgressBackend(stubCfStreamClient(false));
    const outcome = await backend.provision(passthroughJob(), { sessionId: "s", trackName: "c", participantId: "a" });
    expect(outcome.status).toBe("provisioned");
    if (outcome.status === "provisioned") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(401);
    }
  });

  it("30. waveRender: outcome carries upstream error when client fails", async () => {
    const backend = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, stubWaveRenderClient(false));
    backend.onFrame(frame());
    const outcome = await backend.render();
    expect(outcome.status).toBe("rendered");
    if (outcome.status === "rendered") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(503);
    }
  });

  it("31. runpodNvenc: outcome carries upstream error + null COGS when client fails", async () => {
    const backend = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, stubRunpodNvencClient(false));
    backend.onFrame(frame());
    const outcome = await backend.encode();
    expect(outcome.status).toBe("encoded");
    if (outcome.status === "encoded") {
      expect(outcome.result.ok).toBe(false);
      expect(outcome.cogsUsd).toBeNull();
    }
  });
});
