// P5.3 — realtime metering tap tests (TDD; written before the impl wiring was finalized).
//
// Covers the design §3.2/§4 invariants: fractional participant-minutes (no truncation), per-tier
// publish-gating (video/audio), egress OVERAGE-ONLY (the anti-double-bill rule), idempotent event_id,
// inert-until-provisioned, and fail-open emit (a metering failure never breaks the session). No network:
// the gateway fetch is injected.

import { describe, it, expect, vi, afterEach } from "vitest";
import { Signaling } from "../src/signaling.js";
import { RoomCore, type RoomStorage } from "../src/room.js";
import { SfuClient } from "../src/sfu.js";
import {
  METER_VIDEO_MINUTES,
  METER_AUDIO_MINUTES,
  METER_EGRESS_GB,
  connectedMinutes,
  egressOverageGb,
  buildMeterLines,
  isEmitProvisioned,
  emitParticipantUsage,
  type ParticipantSessionUsage,
  type MeterEmitEnv,
} from "../src/metering.js";

const MIN = 60_000;
const base: ParticipantSessionUsage = {
  org: "org_a",
  room: "room_1",
  participantId: "p1",
  sessionId: "sess_abc",
  joinedAt: 1_000_000,
  leftAt: 1_000_000 + 5 * MIN, // 5 minutes
  publishedAudio: true,
  publishedVideo: true,
};
const provisioned: MeterEmitEnv = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok" };

describe("connectedMinutes — fractional, never truncated, never negative", () => {
  it("converts ms → minutes without truncating (90s = 1.5 min)", () => {
    expect(connectedMinutes(0, 90_000)).toBe(1.5);
  });
  it("zero-length session = 0", () => {
    expect(connectedMinutes(500, 500)).toBe(0);
  });
  it("inverted clock (left < joined) = 0, never negative", () => {
    expect(connectedMinutes(2_000, 1_000)).toBe(0);
  });
});

describe("egressOverageGb — OVERAGE-ONLY, fail-closed to $0", () => {
  it("unmeasured egress (undefined) → 0 (fail-closed, never estimate)", () => {
    expect(egressOverageGb(undefined)).toBe(0);
  });
  it("under the included allotment → 0 (bandwidth is inside the per-minute COGS)", () => {
    expect(egressOverageGb(2e9, 5)).toBe(0); // 2 GB, allotment 5 GB
  });
  it("with the default (Infinity) allotment, any egress → 0 (normal use never bills egress)", () => {
    expect(egressOverageGb(50e9)).toBe(0);
  });
  it("only the overage beyond a finite allotment is billable", () => {
    expect(egressOverageGb(8e9, 5)).toBeCloseTo(3, 9); // 8 GB - 5 GB = 3 GB
  });
});

describe("buildMeterLines — publish-gated per-tier minutes + overage egress", () => {
  it("publisher of audio+video → both per-minute meters at fractional value, NO egress (default allotment)", () => {
    const lines = buildMeterLines(base);
    const byMeter = Object.fromEntries(lines.map((l) => [l.meter, l]));
    expect(lines).toHaveLength(2);
    expect(byMeter[METER_VIDEO_MINUTES].meter_value).toBe(5);
    expect(byMeter[METER_AUDIO_MINUTES].meter_value).toBe(5);
    expect(byMeter[METER_EGRESS_GB]).toBeUndefined(); // egress NOT emitted alongside minutes
  });

  it("audio-only publisher → audio meter only", () => {
    const lines = buildMeterLines({ ...base, publishedVideo: false });
    expect(lines.map((l) => l.meter)).toEqual([METER_AUDIO_MINUTES]);
  });

  it("video-only publisher → video meter only", () => {
    const lines = buildMeterLines({ ...base, publishedAudio: false });
    expect(lines.map((l) => l.meter)).toEqual([METER_VIDEO_MINUTES]);
  });

  it("pure viewer (published nothing) → NO per-minute meters", () => {
    const lines = buildMeterLines({ ...base, publishedAudio: false, publishedVideo: false });
    expect(lines).toHaveLength(0);
  });

  it("zero-duration session → no meters even if it published", () => {
    const lines = buildMeterLines({ ...base, leftAt: base.joinedAt });
    expect(lines).toHaveLength(0);
  });

  it("idempotent event_id is stable per (room, participant, session, meter)", () => {
    const a = buildMeterLines(base);
    const b = buildMeterLines(base);
    expect(a.map((l) => l.event_id)).toEqual(b.map((l) => l.event_id));
    const v = a.find((l) => l.meter === METER_VIDEO_MINUTES)!;
    expect(v.event_id).toBe(`room_1:p1:sess_abc:${METER_VIDEO_MINUTES}`);
  });

  it("egress overage IS emitted when egress exceeds a finite allotment — alongside minutes only as true overage", () => {
    const lines = buildMeterLines({ ...base, egressBytes: 8e9 }, 5);
    const byMeter = Object.fromEntries(lines.map((l) => [l.meter, l]));
    expect(byMeter[METER_EGRESS_GB].meter_value).toBeCloseTo(3, 9);
    expect(byMeter[METER_EGRESS_GB].event_id).toBe(`room_1:p1:sess_abc:${METER_EGRESS_GB}`);
  });
});

describe("isEmitProvisioned — INERT until BOTH url and token", () => {
  it("both set → provisioned", () => {
    expect(isEmitProvisioned(provisioned)).toBe(true);
  });
  it("missing token → inert", () => {
    expect(isEmitProvisioned({ GATEWAY_BASE_URL: "https://api.wave.online" })).toBe(false);
  });
  it("missing url → inert", () => {
    expect(isEmitProvisioned({ WAVE_SERVICE_TOKEN: "x" })).toBe(false);
  });
  it("empty env → inert", () => {
    expect(isEmitProvisioned({})).toBe(false);
  });
});

describe("emitParticipantUsage — server-to-server /v1/internal/usage, per-line, fail-open", () => {
  it("INERT: no fetch when not provisioned", async () => {
    const fetchFn = vi.fn();
    await emitParticipantUsage({}, base, undefined, fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("no fetch when nothing billable (pure viewer)", async () => {
    const fetchFn = vi.fn();
    await emitParticipantUsage(provisioned, { ...base, publishedAudio: false, publishedVideo: false }, undefined, fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs one /v1/internal/usage per meter line with the meter_value envelope + Bearer token", async () => {
    const calls: { url: string; body: any; auth: string | null }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(null, { status: 200 });
    });
    await emitParticipantUsage(provisioned, base, undefined, fetchFn as unknown as typeof fetch);

    expect(calls).toHaveLength(2); // video + audio
    for (const c of calls) {
      expect(c.url).toBe("https://api.wave.online/v1/internal/usage");
      expect(c.auth).toBe("Bearer svc-tok");
      expect(c.body.org).toBe("org_a");
      expect(c.body.usage.meter_value).toBe(5);
      expect(typeof c.body.usage.event_id).toBe("string");
    }
    expect(calls.map((c) => c.body.usage.meter).sort()).toEqual([METER_AUDIO_MINUTES, METER_VIDEO_MINUTES]);
  });

  it("FAIL-OPEN: a throwing fetch never propagates (media safety)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      emitParticipantUsage(provisioned, base, undefined, fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("FAIL-OPEN: a non-2xx gateway response never throws", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      emitParticipantUsage(provisioned, base, undefined, fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("one meter's failure does not suppress the other (independent POSTs)", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("first fails");
      return new Response(null, { status: 200 });
    });
    await emitParticipantUsage(provisioned, base, undefined, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the signaling layer: join → publish (audio+video) → leave → gateway emits.
// emitParticipantUsage uses the global fetch inside Signaling.leave, so we stub globalThis.fetch for
// the gateway and inject the SFU's fetch separately. Proves the tap fires on a real leave.
// ---------------------------------------------------------------------------
describe("Signaling.leave → metering tap (integration)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function memStorage(): RoomStorage {
    const map = new Map<string, unknown>();
    return {
      async get<T>(k: string) {
        return map.get(k) as T | undefined;
      },
      async put<T>(k: string, v: T) {
        map.set(k, v);
      },
    };
  }

  it("emits video+audio minutes once on leave with the gateway envelope", async () => {
    const SESS = "sess-AAAAAAAA";
    const sfuFetch = vi.fn(async (url: string) => {
      if (url.includes("/sessions/new")) return new Response(JSON.stringify({ sessionId: SESS }), { status: 200 });
      if (url.includes("/tracks/new")) return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
      throw new Error(`unexpected sfu url ${url}`);
    });
    const gatewayCalls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      gatewayCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    let t = 1_000_000;
    const core = new RoomCore(memStorage(), () => t);
    const sfu = new SfuClient({ appId: "0123456789abcdef0123456789abcdef", appSecret: "s" }, sfuFetch as never);
    const sig = new Signaling(core, sfu, provisioned);
    const ctx = { org: "org_a", room: "room-1", participantId: "p_alice" };

    await sig.join(ctx);
    await sig.publishTrack(ctx, {
      tracks: [
        { mid: "0", trackName: "cam", kind: "video" },
        { mid: "1", trackName: "mic", kind: "audio" },
      ],
      offer: { type: "offer", sdp: "x" },
    });
    t = 1_000_000 + 3 * MIN; // 3 minutes in-room
    await sig.leave(ctx);

    expect(gatewayCalls).toHaveLength(2);
    const meters = gatewayCalls.map((c) => c.body.usage.meter).sort();
    expect(meters).toEqual([METER_AUDIO_MINUTES, METER_VIDEO_MINUTES]);
    for (const c of gatewayCalls) {
      expect(c.url).toBe("https://api.wave.online/v1/internal/usage");
      expect(c.body.org).toBe("org_a");
      expect(c.body.usage.meter_value).toBe(3);
      expect(c.body.usage.event_id).toContain("room-1:p_alice:");
    }
  });

  it("idempotent: a second leave (retry) emits nothing more", async () => {
    const sfuFetch = vi.fn(async (url: string) => {
      if (url.includes("/sessions/new")) return new Response(JSON.stringify({ sessionId: "sess-AAAAAAAA" }), { status: 200 });
      if (url.includes("/tracks/new")) return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
      throw new Error(`unexpected sfu url ${url}`);
    });
    const gw = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = gw as unknown as typeof fetch;

    const core = new RoomCore(memStorage());
    const sfu = new SfuClient({ appId: "0123456789abcdef0123456789abcdef", appSecret: "s" }, sfuFetch as never);
    const sig = new Signaling(core, sfu, provisioned);
    const ctx = { org: "org_a", room: "room-1", participantId: "p_alice" };

    await sig.join(ctx);
    await sig.publishTrack(ctx, { tracks: [{ mid: "1", trackName: "mic", kind: "audio" }], offer: { type: "offer", sdp: "x" } });
    await sig.leave(ctx);
    const after = gw.mock.calls.length;
    await sig.leave(ctx); // retry / duplicate teardown
    expect(gw.mock.calls.length).toBe(after); // no extra emit
  });
});
