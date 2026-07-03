// E-EGRESS-ROUTER P2 (#75) — the wave-render egress backend. Proves the backend OWNS EXACTLY the `waveRender` tier:
// it renders a room view when the router routes there, DEFERS every other verdict (never rendering a job sent to
// cfStream/RunPod), tracks the latest frame per track for the composite source count, isolates through the tap's
// MediaConsumer contract, and stays inert until the flag is armed. Pure engine + an injected fake client — no
// network, no clock.
import { describe, it, expect } from "vitest";
import {
  WaveRenderEgressBackend,
  buildEgressJob,
  egressRouterEnabled,
  DEFAULT_WAVE_RENDER_EGRESS_CONFIG,
  WAVE_RENDER_EGRESS_ID,
  type WaveRenderClient,
  type WaveRenderStillRequest,
  type WaveRenderStillResult,
  type WaveRenderEgressConfig,
} from "../src/egress-wave-render.js";
import { pumpConsumer, MediaTap, type TapFrame } from "../src/media-tap.js";
import { WAVE_RENDER_CAPS } from "../src/egress-router.js";

/** A fake origin: records the requests it received and returns a canned PNG (or a canned non-2xx). */
function fakeClient(
  reply: WaveRenderStillResult = { ok: true, image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" },
): WaveRenderClient & { calls: WaveRenderStillRequest[] } {
  const calls: WaveRenderStillRequest[] = [];
  return {
    calls,
    async renderStill(req) {
      calls.push(req);
      return reply;
    },
  };
}

/** A decoded video frame flowing through the tap, with sensible defaults. */
function frame(overrides: Partial<TapFrame> = {}): TapFrame {
  return {
    sessionId: "sess-1",
    trackName: "cam-a",
    kind: "video",
    participantId: "p-a",
    seq: 1,
    ts: 1000,
    bytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

describe("WaveRenderEgressBackend — owns the waveRender tier, defers the rest", () => {
  it("renders the composite via the client when the router routes to waveRender", async () => {
    const client = fakeClient();
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, client);
    be.onFrame(frame({ trackName: "cam-a", participantId: "p-a" }));
    be.onFrame(frame({ trackName: "cam-b", participantId: "p-b" }));

    const outcome = await be.render();
    expect(outcome.status).toBe("rendered");
    // The request carries the current source set at the configured geometry.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.width).toBe(1920);
    expect(client.calls[0]!.height).toBe(1080);
    expect(client.calls[0]!.sources.map((s) => s.trackName).sort()).toEqual(["cam-a", "cam-b"]);
    if (outcome.status === "rendered" && outcome.result.ok) expect(outcome.result.contentType).toBe("image/png");
  });

  it("surfaces a non-2xx origin reply (e.g. UNTRUSTED → 402) without mistaking it for image bytes", async () => {
    const client = fakeClient({ ok: false, status: 402, reason: "untrusted" });
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, client);
    be.onFrame(frame());
    const outcome = await be.render();
    expect(outcome.status).toBe("rendered");
    if (outcome.status === "rendered") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(402);
    }
  });

  it("DEFERS a passthrough (needsCompositing:false) config to cfStream — never renders a job the router sent elsewhere", async () => {
    const client = fakeClient();
    const passthrough: WaveRenderEgressConfig = { ...DEFAULT_WAVE_RENDER_EGRESS_CONFIG, needsCompositing: false };
    const be = new WaveRenderEgressBackend(passthrough, client);
    be.onFrame(frame());
    const outcome = await be.render();
    expect(outcome).toEqual({ status: "deferred", backend: "cfStream" });
    expect(client.calls).toHaveLength(0); // the client is NEVER touched for a non-waveRender verdict
  });

  it("DEFERS an over-envelope composite (too many sources) to the runpodNvenc backstop", async () => {
    const client = fakeClient();
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, client);
    // One more source than wave-render can composite → the router escalates to GPU, which this backend does not own.
    for (let i = 0; i <= WAVE_RENDER_CAPS.maxSources; i++) be.onFrame(frame({ trackName: `cam-${i}`, participantId: `p-${i}` }));
    const outcome = await be.render();
    expect(outcome).toEqual({ status: "deferred", backend: "runpodNvenc" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS an over-envelope composite (4K) to runpodNvenc", async () => {
    const client = fakeClient();
    const uhd: WaveRenderEgressConfig = { ...DEFAULT_WAVE_RENDER_EGRESS_CONFIG, width: 3840, height: 2160 };
    const be = new WaveRenderEgressBackend(uhd, client);
    be.onFrame(frame());
    expect(await be.render()).toEqual({ status: "deferred", backend: "runpodNvenc" });
  });

  it("reports `empty` before any frame arrives — never calls the client with zero sources", async () => {
    const client = fakeClient();
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, client);
    expect(await be.render()).toEqual({ status: "empty" });
    expect(client.calls).toHaveLength(0);
  });

  it("surfaces a misconfigured backend as `unroutable` (bad geometry → router rejects) — never renders on garbage", async () => {
    const client = fakeClient();
    // A width:0 config is type-valid but egress-INVALID; buildEgressJob → validateEgressJob rejects → egressRoute
    // returns ok:false, so render() must report `unroutable` with the router's reason, not call the client or crash.
    const badGeometry: WaveRenderEgressConfig = { ...DEFAULT_WAVE_RENDER_EGRESS_CONFIG, width: 0 };
    const be = new WaveRenderEgressBackend(badGeometry, client);
    be.onFrame(frame());
    const outcome = await be.render();
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/width/);
    expect(client.calls).toHaveLength(0);
  });
});

describe("WaveRenderEgressBackend — frame tracking (latest-per-track composite inputs)", () => {
  it("keeps the LATEST frame per track and counts distinct tracks as sources", async () => {
    const client = fakeClient();
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, client);
    be.onFrame(frame({ trackName: "cam-a", ts: 1000, bytes: new Uint8Array([1]) }));
    be.onFrame(frame({ trackName: "cam-a", ts: 2000, bytes: new Uint8Array([9]) })); // same track, newer frame
    be.onFrame(frame({ trackName: "cam-b", ts: 1500 }));
    expect(be.sourceCount()).toBe(2); // two distinct tracks, not three frames

    await be.render();
    const camA = client.calls[0]!.sources.find((s) => s.trackName === "cam-a")!;
    expect(camA.ts).toBe(2000); // newest wins
    expect(camA.bytes).toEqual(new Uint8Array([9]));
  });

  it("onClose drops all held frames (nothing leaks past the room)", async () => {
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, fakeClient());
    be.onFrame(frame());
    expect(be.sourceCount()).toBe(1);
    be.onClose();
    expect(be.sourceCount()).toBe(0);
    expect(await be.render()).toEqual({ status: "empty" });
  });
});

describe("WaveRenderEgressBackend — attaches as a real MediaConsumer off the one tap (#74 contract)", () => {
  it("drains video frames from a live MediaTap via pumpConsumer and composites them", async () => {
    const client = fakeClient();
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, client);
    const tap = new MediaTap();
    const handle = tap.subscribe(be.id, be.selector);
    const pump = pumpConsumer(handle, be); // starts draining

    tap.publish({ sessionId: "s", trackName: "cam-a", kind: "video", participantId: "p-a", bytes: new Uint8Array([1]), ts: 10 });
    tap.publish({ sessionId: "s", trackName: "cam-b", kind: "video", participantId: "p-b", bytes: new Uint8Array([2]), ts: 20 });
    // audio must NOT reach a video-only egress consumer (selector least-privilege)
    tap.publish({ sessionId: "s", trackName: "mic-a", kind: "audio", participantId: "p-a", bytes: new Uint8Array([3]), ts: 30 });

    await new Promise((r) => setTimeout(r, 0)); // let the pump drain the queue
    expect(be.sourceCount()).toBe(2); // cam-a + cam-b, audio filtered out
    handle.close();
    await pump;
  });

  it("uses the least-privilege video-only selector and the canonical id by default", () => {
    const be = new WaveRenderEgressBackend(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, fakeClient());
    expect(be.id).toBe(WAVE_RENDER_EGRESS_ID);
    expect(be.selector).toEqual({ kinds: ["video"] });
  });
});

describe("buildEgressJob + egressRouterEnabled", () => {
  it("buildEgressJob is a pure projection of config + sourceCount", () => {
    expect(buildEgressJob(DEFAULT_WAVE_RENDER_EGRESS_CONFIG, 3)).toEqual({
      needsCompositing: true,
      sourceCount: 3,
      width: 1920,
      height: 1080,
      output: "record",
      latency: "nearRealTime",
      codec: "h264",
    });
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
