// #75 routed-egress arm — the RoomDO `egress-bind` intent + `armRoutedEgress` method: the missing TRIGGER that
// arms a routed-egress MediaConsumer off the room's SINGLE MediaTap (buildRoutedEgressConsumer → egressRoute).
// Mirrors the proven `agent-bind` fold: ONE subscribe, NO 2nd SFU subscription. Proves it drains a tapped video
// frame to the decided backend WHEN ARMED, is byte-identically INERT unless BOTH EGRESS_ROUTER_ENABLED and
// MEDIA_TAP_ENABLED are armed (routedEgressArmed), the intent wires to the method, and re-arm is idempotent.
import { describe, it, expect, vi } from "vitest";
import { RoomDO } from "../src/room.js";
import type { RoomDOEnv } from "../src/room.js";
import type { EgressJob } from "../src/egress-router.js";

function memStorage() {
  const map = new Map<string, unknown>();
  return { get: async <T>(k: string) => map.get(k) as T | undefined, put: async <T>(k: string, v: T) => void map.set(k, v) };
}

const ORG = "org-A";
const FRAME = new Uint8Array([1, 2, 3]);

// A within-envelope composite job → routes to waveRender (WAVE_RENDER_URL below).
const COMPOSITE_JOB: EgressJob = {
  needsCompositing: true,
  sourceCount: 2,
  width: 1920,
  height: 1080,
  output: "record",
  latency: "nearRealTime",
  codec: "h264",
};

function armedEnv(extra: Partial<RoomDOEnv> = {}): RoomDOEnv {
  return {
    EGRESS_ROUTER_ENABLED: "1",
    MEDIA_TAP_ENABLED: "1",
    WAVE_RENDER_URL: "https://render.wave.online",
    WAVE_INTERNAL_RENDER_TOKEN: "render-token",
    ...extra,
  };
}

async function seededRoom(env: RoomDOEnv) {
  const do_ = new RoomDO({ storage: memStorage() }, env);
  await do_.ensureRoom({ roomId: "room-1", org: ORG });
  await do_.joinRoom(ORG, { participantId: "p1", sessionId: "sess-1", role: "host" });
  // A VIDEO track — the routed-egress consumer's default selector is { kinds: ["video"] }.
  await do_.registerTrack(ORG, { trackName: "cam", sessionId: "sess-1", participantId: "p1", kind: "video" });
  return do_;
}

describe("#75 — RoomDO routed-egress arm", () => {
  it("armRoutedEgress drains a tapped video frame to the decided backend WHEN ARMED (one subscribe, fanned)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const do_ = await seededRoom(armedEnv());
    expect(do_.armRoutedEgress(COMPOSITE_JOB, fetchSpy as unknown as typeof fetch)).toBe(true);
    await do_.feedRecorderFrame("sess-1", "cam", FRAME);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("render.wave.online"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("is byte-identically INERT when EGRESS_ROUTER_ENABLED is off (no consumer, no fetch)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const do_ = await seededRoom(armedEnv({ EGRESS_ROUTER_ENABLED: "0" }));
    expect(do_.armRoutedEgress(COMPOSITE_JOB, fetchSpy as unknown as typeof fetch)).toBe(false);
    expect(do_.mediaTap.consumerCount).toBe(0);
    await do_.feedRecorderFrame("sess-1", "cam", FRAME);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is byte-identically INERT when MEDIA_TAP_ENABLED is off (no consumer, no fetch)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const do_ = await seededRoom(armedEnv({ MEDIA_TAP_ENABLED: "0" }));
    expect(do_.armRoutedEgress(COMPOSITE_JOB, fetchSpy as unknown as typeof fetch)).toBe(false);
    expect(do_.mediaTap.consumerCount).toBe(0);
    await do_.feedRecorderFrame("sess-1", "cam", FRAME);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the egress-bind fetch intent arms routed egress (armed:true) and validates the job body", async () => {
    const do_ = await seededRoom(armedEnv({ __egressFetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch }));
    const ok = await do_.fetch(new Request("https://room/egress-bind", { method: "POST", body: JSON.stringify(COMPOSITE_JOB) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, armed: true });
    expect(do_.mediaTap.consumerCount).toBe(1);

    const bad = await do_.fetch(new Request("https://room/egress-bind", { method: "POST", body: JSON.stringify({ needsCompositing: true }) }));
    expect(bad.status).toBe(400);
    const empty = await do_.fetch(new Request("https://room/egress-bind", { method: "POST" }));
    expect(empty.status).toBe(400);
  });

  it("the egress-bind intent stays INERT (armed:false) when flags are off — 200, no consumer", async () => {
    const do_ = await seededRoom({}); // no flags → routedEgressArmed false
    const res = await do_.fetch(new Request("https://room/egress-bind", { method: "POST", body: JSON.stringify(COMPOSITE_JOB) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, armed: false });
    expect(do_.mediaTap.consumerCount).toBe(0);
  });

  it("re-arm is idempotent (only one routed-egress drain across the same tap)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const do_ = await seededRoom(armedEnv());
    do_.armRoutedEgress(COMPOSITE_JOB, fetchSpy as unknown as typeof fetch);
    do_.armRoutedEgress(COMPOSITE_JOB, fetchSpy as unknown as typeof fetch);
    expect(do_.mediaTap.consumerCount).toBe(1);
  });
});
