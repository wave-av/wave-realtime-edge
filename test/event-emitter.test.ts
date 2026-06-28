// LK-rip #46 — WAVE SFU room/session event emitter tests (TDD).
//
// Covers the PR #4985 contract invariants: event shape matches the schema, HMAC-SHA256 `wave-signature`
// signing, flag-off = NO emit (DORMANT), session_minutes computed correctly (publish-gated, fractional),
// and fail-open emit (a non-2xx / network error never throws). No live network — the fetch is injected.

import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_WSC_EVENTS_URL,
  isEmitArmed,
  sessionMinutesFor,
  signBody,
  emitEvent,
  buildRoomStarted,
  buildRoomFinished,
  buildParticipantJoined,
  buildParticipantLeft,
  buildTrackPublished,
  buildSessionEnded,
  type EventEmitEnv,
} from "../src/event-emitter.js";
import type { ParticipantSessionUsage } from "../src/metering.js";

const MIN = 60_000;
const TEST_HMAC = "shared-webhook-secret";
const armed: EventEmitEnv = { WAVE_REALTIME_EVENTS_EMIT: "1", WAVE_REALTIME_WEBHOOK_SECRET: TEST_HMAC };

const usage: ParticipantSessionUsage = {
  org: "org_a",
  room: "room_1",
  participantId: "p1",
  sessionId: "sess_abc",
  joinedAt: 1_000_000,
  leftAt: 1_000_000 + 5 * MIN, // 5 minutes
  publishedAudio: true,
  publishedVideo: true,
};

describe("isEmitArmed — DORMANT until flag + secret", () => {
  it("false when flag unset (default — fully inert)", () => {
    expect(isEmitArmed({})).toBe(false);
    expect(isEmitArmed({ WAVE_REALTIME_WEBHOOK_SECRET: TEST_HMAC })).toBe(false);
  });
  it("false when flag set but secret missing (cannot sign → inert)", () => {
    expect(isEmitArmed({ WAVE_REALTIME_EVENTS_EMIT: "1" })).toBe(false);
  });
  it("false when flag is anything other than exactly '1'", () => {
    expect(isEmitArmed({ WAVE_REALTIME_EVENTS_EMIT: "true", WAVE_REALTIME_WEBHOOK_SECRET: TEST_HMAC })).toBe(false);
  });
  it("true only when flag='1' AND secret set", () => {
    expect(isEmitArmed(armed)).toBe(true);
  });
});

describe("sessionMinutesFor — publish-gated, fractional, never negative", () => {
  it("both tiers when published both (5 min)", () => {
    expect(sessionMinutesFor(usage)).toEqual({ video: 5, audio: 5 });
  });
  it("audio-only when only audio published", () => {
    expect(sessionMinutesFor({ ...usage, publishedVideo: false })).toEqual({ video: 0, audio: 5 });
  });
  it("pure viewer (published nothing) → zero both", () => {
    expect(sessionMinutesFor({ ...usage, publishedAudio: false, publishedVideo: false })).toEqual({ video: 0, audio: 0 });
  });
  it("fractional minutes are not truncated (90s = 1.5)", () => {
    expect(sessionMinutesFor({ ...usage, leftAt: usage.joinedAt + 90_000 })).toEqual({ video: 1.5, audio: 1.5 });
  });
  it("inverted/zero window → zero (never negative)", () => {
    expect(sessionMinutesFor({ ...usage, leftAt: usage.joinedAt - 1000 })).toEqual({ video: 0, audio: 0 });
  });
});

describe("event builders — shape matches the #4985 schema", () => {
  it("room.started carries event/org_id/room + stable idempotency_key", () => {
    const e = buildRoomStarted({ org: "org_a", room: "room_1" }, 0);
    expect(e.event).toBe("room.started");
    expect(e.org_id).toBe("org_a");
    expect(e.room).toEqual({ id: "room_1" });
    expect(e.occurred_at).toBe("1970-01-01T00:00:00.000Z");
    expect(e.idempotency_key).toBe("room_1:room.started");
  });
  it("room.finished shape", () => {
    expect(buildRoomFinished({ org: "org_a", room: "room_1" }, 0).event).toBe("room.finished");
  });
  it("participant.joined carries participant + key", () => {
    const e = buildParticipantJoined({ org: "org_a", room: "room_1" }, "p1", 0);
    expect(e.event).toBe("participant.joined");
    expect(e.participant).toEqual({ id: "p1" });
    expect(e.idempotency_key).toBe("room_1:p1:participant.joined");
  });
  it("track.published carries track id+kind", () => {
    const e = buildTrackPublished({ org: "org_a", room: "room_1" }, "p1", { name: "cam0", kind: "video" }, 0);
    expect(e.event).toBe("track.published");
    expect(e.track).toEqual({ id: "cam0", kind: "video" });
    expect(e.idempotency_key).toBe("room_1:p1:cam0:track.published");
  });
  it("participant.left uses leftAt as occurred_at", () => {
    const e = buildParticipantLeft(usage);
    expect(e.event).toBe("participant.left");
    expect(e.occurred_at).toBe(new Date(usage.leftAt).toISOString());
    expect(e.idempotency_key).toBe("room_1:p1:sess_abc:participant.left");
  });
  it("session.ended is BILLABLE — carries org_id + session_minutes + stable key", () => {
    const e = buildSessionEnded(usage);
    expect(e.event).toBe("session.ended");
    expect(e.org_id).toBe("org_a");
    expect(e.session_minutes).toEqual({ video: 5, audio: 5 });
    expect(e.participant).toEqual({ id: "p1" });
    expect(e.idempotency_key).toBe("room_1:p1:sess_abc:session.ended");
    // session_minutes appears ONLY on session.ended
    expect(buildRoomStarted({ org: "org_a", room: "room_1" }).session_minutes).toBeUndefined();
  });
});

describe("signBody — hex HMAC-SHA256 (the #4985 wave-signature)", () => {
  it("produces a 64-char lowercase hex digest, deterministic for same body+secret", async () => {
    const sig1 = await signBody('{"a":1}', TEST_HMAC);
    const sig2 = await signBody('{"a":1}', TEST_HMAC);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
    expect(sig1).toBe(sig2);
  });
  it("differs for a different body", async () => {
    expect(await signBody('{"a":1}', TEST_HMAC)).not.toBe(await signBody('{"a":2}', TEST_HMAC));
  });
});

describe("emitEvent — flag-off no-op, signed POST when armed, fail-open", () => {
  it("flag OFF → NO network call (DORMANT)", async () => {
    const fetchFn = vi.fn();
    await emitEvent({}, buildRoomStarted({ org: "org_a", room: "room_1" }), fetchFn as unknown as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("armed → POSTs signed JSON to the contract URL with the exact raw body", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const event = buildSessionEnded(usage);
    await emitEvent(armed, event, fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DEFAULT_WSC_EVENTS_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    // signature must be the HMAC of the EXACT body sent (sign-then-send the same string)
    const rawBody = init.body as string;
    expect(headers["wave-signature"]).toBe(await signBody(rawBody, TEST_HMAC));
    expect(JSON.parse(rawBody)).toEqual(event);
  });

  it("WSC_EVENTS_URL override is honored (staging)", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await emitEvent(
      { ...armed, WSC_EVENTS_URL: "https://staging.example/api/v1/argus/webhooks/wave-realtime" },
      buildRoomStarted({ org: "org_a", room: "room_1" }),
      fetchFn as unknown as typeof fetch,
    );
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe("https://staging.example/api/v1/argus/webhooks/wave-realtime");
  });

  it("non-2xx → swallowed (never throws), warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      emitEvent(armed, buildRoomStarted({ org: "org_a", room: "room_1" }), fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("network throw → fail-open (never propagates)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      emitEvent(armed, buildSessionEnded(usage), fetchFn as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
