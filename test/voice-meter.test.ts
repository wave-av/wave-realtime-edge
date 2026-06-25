// Task #81 step 7 — voice-meter: the real voice_agent_minutes gateway usage emit. Mirrors metering.test.ts.
// Pure accounting + fail-open I/O, every fetch a FAKE (no live network).
import { describe, it, expect, vi } from "vitest";
import {
  turnMinutes,
  buildVoiceMeterLines,
  isVoiceMeterProvisioned,
  emitVoiceTurnUsage,
  METER_VOICE_AGENT_MINUTES,
  type VoiceTurnUsage,
} from "../src/voice-meter.js";

const baseUsage: VoiceTurnUsage = { org: "org1", room: "room1", agentId: "a1", turnId: "t0", turnWallMs: 60_000 };

describe("turnMinutes", () => {
  it("converts wall-ms to fractional minutes (not truncated)", () => {
    expect(turnMinutes(60_000)).toBe(1);
    expect(turnMinutes(30_000)).toBe(0.5);
    expect(turnMinutes(90_000)).toBe(1.5);
  });
  it("clamps non-positive durations to 0 (never negative)", () => {
    expect(turnMinutes(0)).toBe(0);
    expect(turnMinutes(-5)).toBe(0);
  });
});

describe("buildVoiceMeterLines", () => {
  it("emits one voice_agent_minutes line with a stable idempotent event_id", () => {
    const lines = buildVoiceMeterLines(baseUsage);
    expect(lines).toEqual([
      { meter: METER_VOICE_AGENT_MINUTES, meter_value: 1, event_id: "room1:a1:t0:voice_agent_minutes" },
    ]);
  });
  it("emits nothing for a zero/negative turn (nothing billable)", () => {
    expect(buildVoiceMeterLines({ ...baseUsage, turnWallMs: 0 })).toEqual([]);
    expect(buildVoiceMeterLines({ ...baseUsage, turnWallMs: -1 })).toEqual([]);
  });
});

describe("isVoiceMeterProvisioned", () => {
  it("requires BOTH the gateway URL and the service token", () => {
    expect(isVoiceMeterProvisioned({})).toBe(false);
    expect(isVoiceMeterProvisioned({ GATEWAY_BASE_URL: "u" })).toBe(false);
    expect(isVoiceMeterProvisioned({ WAVE_SERVICE_TOKEN: "t" })).toBe(false);
    expect(isVoiceMeterProvisioned({ GATEWAY_BASE_URL: "u", WAVE_SERVICE_TOKEN: "t" })).toBe(true);
  });
});

describe("emitVoiceTurnUsage", () => {
  it("POSTs the usage envelope to /v1/internal/usage with the service Bearer", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await emitVoiceTurnUsage(
      { GATEWAY_BASE_URL: "https://api.wave.online/", WAVE_SERVICE_TOKEN: "svc" },
      baseUsage,
      fetchFn as unknown as typeof fetch,
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wave.online/v1/internal/usage");
    expect(url).not.toContain("svc");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer svc" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      org: "org1",
      usage: { meter: "voice_agent_minutes", meter_value: 1, event_id: "room1:a1:t0:voice_agent_minutes" },
    });
  });

  it("is INERT (no network) when unprovisioned", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await emitVoiceTurnUsage({}, baseUsage, fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("is fail-OPEN on a non-200 (does not throw)", async () => {
    const fetchFn = vi.fn(async () => new Response("err", { status: 500 }));
    await expect(
      emitVoiceTurnUsage(
        { GATEWAY_BASE_URL: "u", WAVE_SERVICE_TOKEN: "t" },
        baseUsage,
        fetchFn as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });

  it("is fail-OPEN on a transport throw (a metering error never breaks the turn)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(
      emitVoiceTurnUsage(
        { GATEWAY_BASE_URL: "u", WAVE_SERVICE_TOKEN: "t" },
        baseUsage,
        fetchFn as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});
