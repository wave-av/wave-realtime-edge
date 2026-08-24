// E-MEDIA-TAP (#74) receipt test — proves the one-subscribe-surface lifecycle:
//   tap attach on an active SFU session → consumer receives frames → backpressure when consumer stalls →
//   consumer isolation (one slow consumer doesn't block others) → detach GC.
// Arming: MEDIA_TAP_ENABLED="1" (test path). Headless — uses the real MediaTap + pumpConsumer +
// tapPublishFrame glue with a mocked RoomState snapshot (no DO, no SFU).
import { describe, it, expect } from "vitest";
import {
  MediaTap,
  tapPublishFrame,
  pumpConsumer,
  type TapFrame,
  type TapConsumerHandle,
  type MediaConsumer,
  type TapFrameInput,
} from "../src/media-tap.js";
import type { RoomState, TrackKind } from "../src/room.js";

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

const BYTES_3 = new Uint8Array([0xde, 0xad, 0xef]);
const BYTES_VIDEO = new Uint8Array([0xca, 0xfe]);
const ARMED_ENV = { MEDIA_TAP_ENABLED: "1" } as const;

/** Build a minimal RoomState with N tracks for N participants. */
function roomWithTracks(
  tracks: Array<{ trackName: string; sessionId: string; participantId: string; kind: TrackKind }>,
): RoomState {
  const trackMap: RoomState["tracks"] = {};
  for (const t of tracks) {
    trackMap[t.trackName] = { ...t, lastSeenAt: 0 };
  }
  return {
    config: { roomId: "receipt-room", org: "receipt-org" },
    participants: {},
    tracks: trackMap,
    emptyAt: null,
    policy: null,
    waiting: {},
    banned: [],
    admitted: [],
  };
}

/** Publish a resolved frame directly into the tap (no DO glue — pure fan-out). */
function publishFrame(
  tap: MediaTap,
  overrides: Partial<TapFrameInput> = {},
): number {
  return tap.publish({
    sessionId: overrides.sessionId ?? "sfu-sess-A",
    trackName: overrides.trackName ?? "mic",
    kind: overrides.kind ?? ("audio" as const),
    participantId: overrides.participantId ?? "alice",
    ts: overrides.ts ?? Date.now(),
    bytes: overrides.bytes ?? BYTES_3,
  });
}

/** Convenience: publish a video frame. */
function publishVideo(tap: MediaTap, ts: number): number {
  return publishFrame(tap, {
    trackName: "cam",
    kind: "video",
    participantId: "alice",
    ts,
    bytes: BYTES_VIDEO,
  });
}

// ── receipt: full lifecycle ──────────────────────────────────────────────────────────────────────────────────

describe("E-MEDIA-TAP receipt — one-tap lifecycle", () => {
  it("attaches consumers, filters selectors, and applies backpressure", async () => {
    // 1. Tap attach: create a tap and register two independent consumers (recorder + perception).
    const tap = new MediaTap(4); // small queue for backpressure proof
    const recorder = tap.subscribe("egress-recorder", {}); // egress wants everything
    const perception = tap.subscribe("agent-perception", { kinds: ["audio"] }); // agent wants audio only

    expect(tap.consumerCount).toBe(2);

    // 2. Consumer receives frames: publish audio + video through tap; recorder gets both, perception gets audio only.
    publishFrame(tap, { ts: 100 });
    publishVideo(tap, 200);
    publishFrame(tap, { ts: 300, trackName: "mic-bob", participantId: "bob", sessionId: "sfu-sess-B" });

    // Recorder: 3 frames (audio-alice + video-alice + audio-bob)
    const r1 = await recorder.next();
    const r2 = await recorder.next();
    const r3 = await recorder.next();
    expect([r1!.seq, r2!.seq, r3!.seq]).toEqual([1, 2, 3]);
    expect(r1!.kind).toBe("audio");
    expect(r2!.kind).toBe("video");
    expect(r3!.participantId).toBe("bob");

    // Perception: 2 frames (audio-alice + audio-bob only — video filtered by selector)
    const p1 = await perception.next();
    const p2 = await perception.next();
    expect([p1!.seq, p2!.seq]).toEqual([1, 3]); // seq 1 (mic), seq 3 (mic-bob); seq 2 (cam) filtered
    expect(p1!.kind).toBe("audio");
    expect(p2!.trackName).toBe("mic-bob");

    // 3. Backpressure when consumer stalls: stop draining perception; publish enough to overflow its queue (depth 4).
    for (let i = 4; i <= 20; i++) {
      publishFrame(tap, { ts: i * 100 });
    }
    const pStats = perception.stats();
    expect(pStats.dropped).toBeGreaterThan(0); // backpressure fired
    expect(pStats.depth).toBeLessThanOrEqual(4); // queue capped at high-water
    // The NEWEST frames survive (drop-oldest semantics). Drain the buffer while it has frames,
    // then stop — next() on an open consumer with an empty buffer hangs (no null sentinel).
    const remaining = [] as TapFrame[];
    while (perception.stats().depth > 0) {
      const f = await perception.next();
      if (f) remaining.push(f);
    }
    expect(remaining.length).toBeGreaterThan(0);
    // All remaining frames have seq > the ones that were dropped — newest survive
    for (const f of remaining) {
      expect(f.seq).toBeGreaterThanOrEqual(17); // tail of the sequence
    }

        });

  it("isolates a fast consumer from a stalled consumer", async () => {
      // Consumer isolation: register a slow consumer and a fast consumer; publish frames.
    //    Fast consumer drains immediately, slow never drains → slow eats ALL drops, fast gets every frame.
    const tap2 = new MediaTap(3);
    const fast = tap2.subscribe("fast", {});
    const slow = tap2.subscribe("slow", {});
    const fastSeqs: number[] = [];

    for (let i = 1; i <= 15; i++) {
      publishFrame(tap2, { ts: i });
      const f = await fast.next();
      if (f) fastSeqs.push(f.seq);
    }
    // Fast consumer: every frame in order, zero drops
    expect(fastSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(fast.stats().dropped).toBe(0);
    // Slow consumer: hit backpressure, lost frames
    expect(slow.stats().dropped).toBeGreaterThan(0);

        });

  it("keeps pump peers alive when one consumer throws", async () => {
      // A throwing onFrame never crashes the pump or its peers.
    const tap3 = new MediaTap(10);
    const goodHandle = tap3.subscribe("good-consumer", {});
    const badHandle = tap3.subscribe("bad-consumer", {});

    const goodSeen: number[] = [];
    const goodConsumer: MediaConsumer = {
      id: "good-consumer",
      selector: {},
      onFrame: (f) => { goodSeen.push(f.seq); },
    };
    const badConsumer: MediaConsumer = {
      id: "bad-consumer",
      selector: {},
      onFrame: () => { throw new Error("perception crash"); },
    };

    const goodPump = pumpConsumer(goodHandle, goodConsumer);
    const badPump = pumpConsumer(badHandle, badConsumer);

    publishFrame(tap3, { ts: 1 });
    publishFrame(tap3, { ts: 2 });
    publishFrame(tap3, { ts: 3 });
    await new Promise((r) => setTimeout(r, 0)); // let microtasks drain

    tap3.unsubscribe("good-consumer");
    tap3.unsubscribe("bad-consumer");

    await Promise.all([goodPump, badPump]);
    expect(goodSeen).toEqual([1, 2, 3]); // good consumer got everything despite bad consumer throwing

        });

  it("garbage-collects detached consumers", async () => {
      // Unsubscribe removes the consumer; next() resolves null; fan-out count drops to 0.
    const tap4 = new MediaTap();
    const h = tap4.subscribe("to-gc");
    publishFrame(tap4, { ts: 1 });
    expect(await h.next()).toBeTruthy();
    tap4.unsubscribe("to-gc");
    expect(await h.next()).toBeNull(); // GC'd handle returns null
    expect(tap4.consumerCount).toBe(0);
    expect(tap4.publish(frameInput())).toBe(0); // no consumers left
    expect(tap4.stats().consumers).toHaveLength(0);
  });
});

describe("E-MEDIA-TAP receipt — tapPublishFrame DO glue path (armed)", () => {
  const state = roomWithTracks([
    { trackName: "mic", sessionId: "sfu-sess-A", participantId: "alice", kind: "audio" },
    { trackName: "cam", sessionId: "sfu-sess-A", participantId: "alice", kind: "video" },
  ]);

  it("tapPublishFrame resolves from registry + publishes into tap when MEDIA_TAP_ENABLED is armed", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("recorder", {});
    await tapPublishFrame(tap, ARMED_ENV, async () => state, "sfu-sess-A", "mic", BYTES_3, 1000);
    const f = (await h.next()) as TapFrame;
    expect(f).toMatchObject({
      participantId: "alice",
      kind: "audio",
      trackName: "mic",
      sessionId: "sfu-sess-A",
      ts: 1000,
      seq: 1,
      bytes: BYTES_3,
    });
  });

  it("tapPublishFrame is INERT when MEDIA_TAP_ENABLED is off (prod byte-identical)", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("recorder", {});
    await tapPublishFrame(tap, {}, async () => state, "sfu-sess-A", "mic", BYTES_3, 2000);
    // Nothing was published (tap inert). Close the consumer so next() resolves null
    // — an open consumer with an empty buffer hangs forever (no null sentinel).
    h.close();
    expect(await h.next()).toBeNull();
    expect(tap.stats().seq).toBe(0);
  });

  it("tapPublishFrame is FAIL-OPEN: a throwing snapshot never propagates (media-safety > fan-out)", async () => {
    const tap = new MediaTap();
    const boom = async (): Promise<RoomState> => { throw new Error("snapshot crash"); };
    await expect(
      tapPublishFrame(tap, ARMED_ENV, boom, "sfu-sess-A", "mic", BYTES_3, 3000),
    ).resolves.toBeUndefined();
    expect(tap.stats().seq).toBe(0);
  });
});

// helper for the detach-GC sub-test (needs a fresh frameInput call)
function frameInput(overrides: Partial<TapFrameInput> = {}): TapFrameInput {
  return {
    sessionId: overrides.sessionId ?? "sfu-sess-A",
    trackName: overrides.trackName ?? "mic",
    kind: overrides.kind ?? ("audio" as const),
    participantId: overrides.participantId ?? "alice",
    ts: overrides.ts ?? 0,
    bytes: overrides.bytes ?? BYTES_3,
  };
}
