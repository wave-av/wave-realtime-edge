/**
 * RunpodNvencEgressBackend tests, focused on the #278 (W0) COGS circuit-breaker hook wired into `encode()`.
 * Baseline routing/COGS behavior is covered incidentally; the dedicated coverage for cap/kill-switch/duration
 * mechanisms lives in egress-killswitch.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  RunpodNvencEgressBackend,
  DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG,
  cogsUsd,
  type RunpodNvencClient,
  type RunpodNvencResult,
} from "./egress-runpod-nvenc.js";
import { MemoryKillswitchStore } from "./egress-killswitch.js";
import type { TapFrame } from "./media-tap.js";

function frame(trackName: string): TapFrame {
  return { sessionId: "s1", trackName, kind: "video", participantId: "p1", seq: 1, ts: 0, bytes: new Uint8Array([1]) };
}

function okClient(gpuSeconds: number): RunpodNvencClient {
  return {
    encode: vi.fn(async (): Promise<RunpodNvencResult> => ({ ok: true, artifactKey: "k", codec: "hevc", gpuSeconds })),
  };
}

describe("cogsUsd", () => {
  it("multiplies measured gpuSeconds by the grounded flex rate", () => {
    expect(cogsUsd(100)).toBeCloseTo(0.0528, 6);
  });
  it("guards non-finite/negative input to null", () => {
    expect(cogsUsd(NaN)).toBeNull();
    expect(cogsUsd(-1)).toBeNull();
  });
});

describe("RunpodNvencEgressBackend circuit breaker (#278)", () => {
  it("encodes normally with no budgetGuard configured (unchanged baseline behavior)", async () => {
    const backend = new RunpodNvencEgressBackend(DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG, okClient(100));
    backend.onFrame(frame("cam0"));
    const outcome = await backend.encode();
    expect(outcome.status).toBe("encoded");
  });

  it("trips the breaker once accumulated cost crosses budget, then short-circuits further encodes", async () => {
    const store = new MemoryKillswitchStore();
    const alertSink = vi.fn();
    // gpuSeconds chosen so cogsUsd(gpuSeconds) alone exceeds a tiny budget on the first encode.
    const client = okClient(1000); // cogsUsd = 1000 * 0.000528 = 0.528
    const backend = new RunpodNvencEgressBackend(
      DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG,
      client,
      undefined,
      {},
      { store, orgId: "org1", limits: { budgetUsd: 0.1, windowMs: 60_000 }, alertSink },
    );
    backend.onFrame(frame("cam0"));

    const first = await backend.encode();
    expect(first.status).toBe("encoded");
    expect(alertSink).toHaveBeenCalledTimes(1);
    expect(alertSink.mock.calls[0]?.[0]).toMatchObject({ orgId: "org1", budgetUsd: 0.1 });
    expect(backend.isCircuitOpen()).toBe(true);

    backend.onFrame(frame("cam0"));
    const second = await backend.encode();
    expect(second).toEqual({ status: "circuitOpen", orgId: "org1" });
    // no second RunPod client call once the circuit is open
    expect(client.encode).toHaveBeenCalledTimes(1);
  });

  it("does not trip while accumulated cost stays under budget", async () => {
    const store = new MemoryKillswitchStore();
    const alertSink = vi.fn();
    const client = okClient(10); // cogsUsd ≈ 0.00528
    const backend = new RunpodNvencEgressBackend(
      DEFAULT_RUNPOD_NVENC_EGRESS_CONFIG,
      client,
      undefined,
      {},
      { store, orgId: "org1", limits: { budgetUsd: 50, windowMs: 60_000 }, alertSink },
    );
    backend.onFrame(frame("cam0"));
    await backend.encode();
    expect(alertSink).not.toHaveBeenCalled();
    expect(backend.isCircuitOpen()).toBe(false);
  });
});
