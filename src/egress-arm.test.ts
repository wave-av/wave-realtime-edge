/**
 * E-EGRESS-ROUTER ARM SLICE (#75) — test for `buildRoutedEgressConsumer`, the RoomDO routed-egress
 * MediaConsumer factory (src/egress-arm.ts). This is the one genuine build in the integration-arming plan:
 * everything else activates already-built logic; this ADDS a new, INERT-by-default factory.
 *
 * Inert-by-default contract under test: the consumer must do nothing (no fetch call) unless BOTH
 * `EGRESS_ROUTER_ENABLED` and `MEDIA_TAP_ENABLED` read armed (mirroring `egressRouterEnabled` /
 * `mediaTapEnabled`'s strict true/"1"/"true" predicates) — so merely constructing/wiring this consumer does
 * NOT change prod behavior. `fetch` is injected for testability; nothing here touches the real network.
 *
 * The plan's illustrative test called `buildRoutedEgressConsumer({ kind: "composite" }, env, fetchSpy)` and
 * `consumer.onFrame(new Uint8Array(...))` directly. Adapted to reality: `EgressJob` has no `kind` field (see
 * egress-router.ts), and `MediaConsumer.onFrame` (media-tap.ts) takes a `TapFrame`, not raw bytes — the bytes
 * are `frame.bytes`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildRoutedEgressConsumer,
  routedEgressArmed,
  startRoutedEgressGuarded,
  type RoutedEgressArmEnv,
} from "./egress-arm.js";
import type { EgressJob } from "./egress-router.js";
import { MediaTap, type TapFrame } from "./media-tap.js";
import { MemoryKillswitchStore, activateKillSwitch, listArmed, registerArmed } from "./egress-killswitch.js";

const COMPOSITE_JOB: EgressJob = {
  needsCompositing: true,
  sourceCount: 2,
  width: 1920,
  height: 1080,
  output: "record",
  latency: "nearRealTime",
  codec: "h264",
};

const HEAVY_JOB: EgressJob = {
  needsCompositing: true,
  sourceCount: 2,
  width: 3840,
  height: 2160,
  output: "simulcast",
  latency: "realTime",
  codec: "hevc",
};

const PASSTHROUGH_JOB: EgressJob = {
  needsCompositing: false,
  sourceCount: 1,
  width: 1920,
  height: 1080,
  output: "record",
  latency: "nearRealTime",
  codec: "h264",
};

function frame(bytes: Uint8Array): TapFrame {
  return { sessionId: "s1", trackName: "cam0", kind: "video", participantId: "p1", seq: 1, ts: 0, bytes };
}

const ARMED_ENV: RoutedEgressArmEnv = {
  EGRESS_ROUTER_ENABLED: "1",
  MEDIA_TAP_ENABLED: "1",
  WAVE_RENDER_URL: "https://render.wave.online",
  WAVE_INTERNAL_RENDER_TOKEN: "render-token",
  RUNPOD_NVENC_ENDPOINT: "https://runpod.wave.online",
  RUNPOD_API_TOKEN: "runpod-token",
};

describe("routedEgressArmed", () => {
  it("requires BOTH EGRESS_ROUTER_ENABLED and MEDIA_TAP_ENABLED armed", () => {
    expect(routedEgressArmed({})).toBe(false);
    expect(routedEgressArmed({ EGRESS_ROUTER_ENABLED: "1" })).toBe(false);
    expect(routedEgressArmed({ MEDIA_TAP_ENABLED: "1" })).toBe(false);
    expect(routedEgressArmed({ EGRESS_ROUTER_ENABLED: "1", MEDIA_TAP_ENABLED: "1" })).toBe(true);
  });
});

describe("buildRoutedEgressConsumer (inert until flag+tap armed)", () => {
  it("instantiates a wave-render consumer for a within-envelope composite egress job", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    const consumer = buildRoutedEgressConsumer(COMPOSITE_JOB, ARMED_ENV, fetchSpy as unknown as typeof fetch);
    await consumer.onFrame(frame(new Uint8Array([1, 2, 3])));
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("render.wave.online"),
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ authorization: "Bearer render-token" });
  });

  it("instantiates a RunPod NVENC consumer for a heavy/4K/HEVC egress job", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const consumer = buildRoutedEgressConsumer(HEAVY_JOB, ARMED_ENV, fetchSpy);
    await consumer.onFrame(frame(new Uint8Array([4, 5, 6])));
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("runpod.wave.online"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stays inert (no fetch) for a cfStream passthrough verdict — passthrough is a one-shot provisioner, not a frame consumer", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const consumer = buildRoutedEgressConsumer(PASSTHROUGH_JOB, ARMED_ENV, fetchSpy);
    await consumer.onFrame(frame(new Uint8Array([7])));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays inert when EGRESS_ROUTER_ENABLED is off, even with a fully wired env otherwise", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const env: RoutedEgressArmEnv = { ...ARMED_ENV, EGRESS_ROUTER_ENABLED: "0" };
    const consumer = buildRoutedEgressConsumer(COMPOSITE_JOB, env, fetchSpy);
    await consumer.onFrame(frame(new Uint8Array([1])));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays inert when MEDIA_TAP_ENABLED is off, even with a fully wired env otherwise", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const env: RoutedEgressArmEnv = { ...ARMED_ENV, MEDIA_TAP_ENABLED: "0" };
    const consumer = buildRoutedEgressConsumer(COMPOSITE_JOB, env, fetchSpy);
    await consumer.onFrame(frame(new Uint8Array([1])));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exposes a video-only selector by default (least-privilege, mirrors the other egress backends)", () => {
    const consumer = buildRoutedEgressConsumer(COMPOSITE_JOB, ARMED_ENV, vi.fn());
    expect(consumer.selector).toEqual({ kinds: ["video"] });
    expect(consumer.id).toBe("egress:routed-arm");
  });
});

// ── #278 cost-governance: startRoutedEgressGuarded ──────────────────────────────────────────────────────────

describe("startRoutedEgressGuarded (#278 cap + kill-switch gate)", () => {
  it("returns null (not armed) when the router/tap flags are off, without touching the store", async () => {
    const store = new MemoryKillswitchStore();
    const tap = new MediaTap();
    const handle = await startRoutedEgressGuarded(tap, COMPOSITE_JOB, {}, vi.fn(), {
      store,
      orgId: "org1",
      streamId: "s1",
    });
    expect(handle).toBeNull();
    expect(await listArmed(store)).toHaveLength(0);
  });

  it("arms, registers the stream, and returns a live handle under the cap", async () => {
    const store = new MemoryKillswitchStore();
    const tap = new MediaTap();
    const handle = await startRoutedEgressGuarded(tap, COMPOSITE_JOB, ARMED_ENV, vi.fn(async () => new Response()), {
      store,
      orgId: "org1",
      streamId: "s1",
      limits: { perOrg: 1, global: 1 },
    });
    expect(handle).not.toBeNull();
    const armed = await listArmed(store);
    expect(armed).toEqual([{ streamId: "s1", orgId: "org1", armedAt: expect.any(Number) }]);
  });

  it("rejects a new arm once the per-org cap is reached", async () => {
    const store = new MemoryKillswitchStore();
    await registerArmed(store, "org1", "existing");
    const tap = new MediaTap();
    const handle = await startRoutedEgressGuarded(tap, COMPOSITE_JOB, ARMED_ENV, vi.fn(), {
      store,
      orgId: "org1",
      streamId: "s2",
      limits: { perOrg: 1, global: 10 },
    });
    expect(handle).toBeNull();
    expect(await listArmed(store)).toHaveLength(1); // rejected arm never registers
  });

  it("rejects every new arm once the kill switch is active", async () => {
    const store = new MemoryKillswitchStore();
    await activateKillSwitch(store, vi.fn());
    const tap = new MediaTap();
    const handle = await startRoutedEgressGuarded(tap, COMPOSITE_JOB, ARMED_ENV, vi.fn(), {
      store,
      orgId: "org1",
      streamId: "s1",
    });
    expect(handle).toBeNull();
  });

  it("closing the returned handle deregisters the stream from the armed registry", async () => {
    const store = new MemoryKillswitchStore();
    const tap = new MediaTap();
    const handle = await startRoutedEgressGuarded(tap, COMPOSITE_JOB, ARMED_ENV, vi.fn(async () => new Response()), {
      store,
      orgId: "org1",
      streamId: "s1",
    });
    expect(await listArmed(store)).toHaveLength(1);
    handle?.close();
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget registerDisarmed settle
    expect(await listArmed(store)).toHaveLength(0);
  });
});
