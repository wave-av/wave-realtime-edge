// wave-realtime-edge — a gateway 200 IS NOT AN ACK.
//
// THE DEFECT THESE PIN. The gateway's /v1/internal/usage door is deliberately fail-OPEN: it answers
// `{ok:true, recorded:N}` even when the record failed, and signals that with `recorded:0` (its own
// comment: "even on a record error we ack 200 (the spoke must not retry-storm); `recorded:0` signals
// it."). This emitter checked only `res.ok`. So when `voice_agent_minutes` matched no gateway dimension,
// every turn from 2026-06-25 got 200/recorded:0 and was read here as SUCCESS — a total revenue drop that
// logged success at BOTH ends and was therefore invisible from either.
//
// `recorded` is the actual receipt. These tests pin that it is read, that a drop is loud, that the emit
// stays fail-open regardless, and that a 429 gets exactly one idempotent retry — DETACHED, because the
// emit is awaited at the end of every live turn and an inline retry wait stalls the next turn.
import { describe, it, expect, vi, afterEach } from "vitest";
import { emitVoiceTurnUsage, METER_VOICE_AGENT_MINUTES, type VoiceTurnUsage } from "../src/voice-meter.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const env = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "t" };
const usage: VoiceTurnUsage = { org: "org_v", room: "r1", agentId: "a1", turnId: "7", turnWallMs: 4500 };

const jsonRes = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const emit = (fetchFn: unknown) => emitVoiceTurnUsage(env, usage, fetchFn as typeof fetch);

describe("a 200 carrying recorded:0 is a DROP, not an ack", () => {
  it("REGRESSION: warns loudly when the gateway acks 200 but recorded:0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await emit(vi.fn(async () => jsonRes({ ok: true, recorded: 0, deduped: false, dims: {} })));
    const line = warn.mock.calls.flat().join(" ");
    expect(line).toContain("DROPPED");
    expect(line).toContain(METER_VOICE_AGENT_MINUTES);
    expect(line).toContain("recorded:0");
  });

  it("stays QUIET on a real record (recorded >= 1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await emit(vi.fn(async () => jsonRes({ ok: true, recorded: 1, dims: { voice_agent_minutes: 4500 } })));
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays QUIET on a DEDUPED replay — recorded:0 with deduped:true is not a drop", async () => {
    // An idempotent re-emit is expected and healthy; warning on it would train the reader to ignore the
    // warning that matters. The gateway reports the dedupe explicitly, so it is distinguishable.
    // This is the REAL dedupe shape: recordUsage records nothing on a replay, so `recorded` is 0 and
    // `deduped` is true. An earlier draft of this test wrote `recorded: 1` and therefore passed without
    // exercising the case at all — while the implementation did warn "DROPPED" on every idempotent retry.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await emit(vi.fn(async () => jsonRes({ ok: true, recorded: 0, deduped: true, dims: {} })));
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT invent a drop from an unparseable body (observability failure != drop)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await emit(vi.fn(async () => new Response("not json", { status: 200 })));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("DROPPED");
  });

  it("NEVER throws on a recorded:0 drop — a metering failure must not break the live turn", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(emit(vi.fn(async () => jsonRes({ ok: true, recorded: 0 })))).resolves.toBeUndefined();
  });
});

describe("429 gets exactly one idempotent retry — DETACHED from the awaited emit", () => {
  it("retries once and succeeds, re-sending the IDENTICAL event_id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return bodies.length === 1
        ? jsonRes({ ok: false, reason: "rate_limited" }, { status: 429, headers: { "retry-after": "0" } })
        : jsonRes({ ok: true, recorded: 1 });
    });
    await emit(fetchFn);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    // Same body both times → the gateway's event_id dedup makes a retry it already recorded a no-op,
    // so the retry can never double-bill.
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]).usage.event_id).toBe(`r1:a1:7:${METER_VOICE_AGENT_MINUTES}`);
  });

  it("gives up after ONE retry and warns — never an unbounded retry storm", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => jsonRes({ ok: false }, { status: 429, headers: { "retry-after": "0" } }));
    await emit(fetchFn);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("status=429"));
    expect(fetchFn).toHaveBeenCalledTimes(2); // still 2 — the retry never retries itself
  });

  it("does NOT retry a non-429 failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => jsonRes({ ok: false }, { status: 500 }));
    await emit(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("NEVER blocks the awaited emit on the retry wait — the live turn must not stall (devin on #356)", async () => {
    // The emit is awaited at the end of every turn while `turnInFlight` blocks the next one, so an
    // inline `retry-after` sleep = a dead window in the live conversation. The awaited promise must
    // settle after the FIRST attempt; the retry fires later, detached.
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => jsonRes({ ok: false }, { status: 429, headers: { "retry-after": "60" } }));
    await emit(fetchFn); // resolves under fake timers ⇒ no inline sleep on the awaited path
    expect(fetchFn).toHaveBeenCalledTimes(1); // retry not fired yet — it is scheduled, not awaited
    await vi.advanceTimersByTimeAsync(2000); // clamped: 60s retry-after must fire by 2s, not 60s
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("clamps a hostile retry-after so an upstream cannot park the retry, and honors retry-after:0 as NOW", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = vi.fn(async () => jsonRes({ ok: false }, { status: 429, headers: { "retry-after": "86400" } }));
    await emit(hostile);
    await vi.advanceTimersByTimeAsync(1999);
    expect(hostile).toHaveBeenCalledTimes(1); // not yet — clamp is 2000ms, default 1000ms does not apply
    await vi.advanceTimersByTimeAsync(1);
    expect(hostile).toHaveBeenCalledTimes(2); // fired at the 2s clamp, not 24h

    // `retry-after: 0` means retry NOW — it must not fall through to the 1s default.
    const immediate = vi.fn(async () => jsonRes({ ok: false }, { status: 429, headers: { "retry-after": "0" } }));
    await emit(immediate);
    await vi.advanceTimersByTimeAsync(0);
    expect(immediate).toHaveBeenCalledTimes(2);
  });
});
