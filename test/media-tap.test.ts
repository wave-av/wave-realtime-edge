// E-MEDIA-TAP (#74) — the pure fan-out engine + consumer contract. The epic verdict lives here: two independent
// consumers attach to ONE room-subscribe surface and each receives its selected tracks without starving the other,
// backpressure holds under load, and a slow/throwing consumer is isolated from the source and its peers. No DO, no
// SFU — deterministic (arrival time is passed in), so these invariants are provable hermetically.
import { describe, it, expect, vi } from "vitest";
import {
  MediaTap,
  selectorMatches,
  pumpConsumer,
  mediaTapEnabled,
  resolveTapTrack,
  tapPublishFrame,
  DEFAULT_HIGH_WATER,
  type TapFrame,
  type MediaConsumer,
} from "../src/media-tap.js";
import type { RoomState } from "../src/room.js";

const BYTES = new Uint8Array([1, 2, 3]);
function frameInput(over: Partial<{ sessionId: string; trackName: string; kind: "audio" | "video"; participantId: string; ts: number }> = {}) {
  return {
    sessionId: over.sessionId ?? "sess-1",
    trackName: over.trackName ?? "mic",
    kind: over.kind ?? ("audio" as const),
    participantId: over.participantId ?? "p1",
    ts: over.ts ?? 0,
    bytes: BYTES,
  };
}

describe("selectorMatches", () => {
  const f = { kind: "audio" as const, trackName: "mic", participantId: "p1" };
  it("an empty selector matches anything", () => {
    expect(selectorMatches({}, f)).toBe(true);
  });
  it("constrains by kind, trackName, participantId (all must hold)", () => {
    expect(selectorMatches({ kinds: ["audio"] }, f)).toBe(true);
    expect(selectorMatches({ kinds: ["video"] }, f)).toBe(false);
    expect(selectorMatches({ trackNames: ["cam"] }, f)).toBe(false);
    expect(selectorMatches({ participantIds: ["p2"] }, f)).toBe(false);
    expect(selectorMatches({ kinds: ["audio"], participantIds: ["p1"], trackNames: ["mic"] }, f)).toBe(true);
    // one failing constraint fails the whole match
    expect(selectorMatches({ kinds: ["audio"], participantIds: ["p2"] }, f)).toBe(false);
  });
});

describe("MediaTap — fan-out (the one subscribe surface)", () => {
  it("fans ONE published frame out to every matching consumer, each on its own queue", async () => {
    const tap = new MediaTap();
    const recorder = tap.subscribe("recorder", {}); // wants everything (egress)
    const captioner = tap.subscribe("captioner", { kinds: ["audio"] }); // wants audio only (perception)
    const reached = tap.publish(frameInput({ kind: "audio" }));
    expect(reached).toBe(2);
    const a = await recorder.next();
    const b = await captioner.next();
    expect(a?.trackName).toBe("mic");
    expect(b?.trackName).toBe("mic");
    // Same logical frame, independent handles — one consumer draining does not consume the other's copy.
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(1);
  });

  it("a selector filters: a video-only consumer never sees audio, and vice-versa", async () => {
    const tap = new MediaTap();
    const videoOnly = tap.subscribe("v", { kinds: ["video"] });
    const audioOnly = tap.subscribe("a", { kinds: ["audio"] });
    expect(tap.publish(frameInput({ kind: "audio", trackName: "mic" }))).toBe(1); // only audioOnly
    expect(tap.publish(frameInput({ kind: "video", trackName: "cam" }))).toBe(1); // only videoOnly
    expect((await audioOnly.next())?.kind).toBe("audio");
    expect((await videoOnly.next())?.kind).toBe("video");
  });

  it("stamps a strictly-monotonic seq across all frames (ordering signal)", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("c");
    for (let i = 0; i < 3; i++) tap.publish(frameInput({ trackName: `t${i}` }));
    const seqs = [(await h.next())?.seq, (await h.next())?.seq, (await h.next())?.seq];
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("publish before any subscriber, and to a non-matching selector, reaches no one (fail-closed on no match)", () => {
    const tap = new MediaTap();
    expect(tap.publish(frameInput())).toBe(0); // no consumers
    tap.subscribe("v", { kinds: ["video"] });
    expect(tap.publish(frameInput({ kind: "audio" }))).toBe(0); // no matching consumer
  });

  it("a parked next() is fed directly by a later publish (no buffering, no drop)", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("c");
    const pending = h.next(); // parks — buffer empty
    tap.publish(frameInput({ trackName: "live" }));
    expect((await pending)?.trackName).toBe("live");
    expect(h.stats().dropped).toBe(0);
  });
});

describe("MediaTap — backpressure + consumer isolation (the epic verdict)", () => {
  it("a full consumer queue drops its OLDEST frames (drop-oldest) — the newest always survives", async () => {
    const tap = new MediaTap(3); // tiny high-water
    const slow = tap.subscribe("slow"); // never drains
    for (let i = 1; i <= 10; i++) tap.publish(frameInput({ trackName: `f${i}`, ts: i }));
    const st = slow.stats();
    expect(st.depth).toBe(3); // capped at high-water
    expect(st.dropped).toBe(7); // 10 pushed − 3 retained
    // the 3 retained are the NEWEST (f8,f9,f10)
    const seqs = [(await slow.next())?.seq, (await slow.next())?.seq, (await slow.next())?.seq];
    expect(seqs).toEqual([8, 9, 10]);
  });

  it("one SLOW consumer never starves a FAST one — the fast consumer receives every frame in order", async () => {
    const tap = new MediaTap(3);
    const slow = tap.subscribe("slow"); // sits at high-water, dropping
    const fast = tap.subscribe("fast");
    const got: number[] = [];
    // Interleave: publish then immediately drain the fast consumer, so it never backs up.
    for (let i = 1; i <= 10; i++) {
      tap.publish(frameInput({ ts: i }));
      const f = await fast.next();
      if (f) got.push(f.seq);
    }
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // fast lost nothing
    expect(fast.stats().dropped).toBe(0);
    expect(slow.stats().dropped).toBe(7); // slow ate the backpressure alone
  });

  it("publish runs NO consumer code — a consumer can't block or throw into the source", () => {
    const tap = new MediaTap();
    tap.subscribe("c");
    // publish is a pure sync fan-out (push only); it returns a count and never awaits a consumer.
    expect(() => tap.publish(frameInput())).not.toThrow();
  });

  it("unsubscribe closes the handle: next() resolves null and further publishes skip it", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("c");
    tap.unsubscribe("c");
    expect(await h.next()).toBeNull(); // closed
    expect(tap.publish(frameInput())).toBe(0); // gone from the fan-out
    expect(tap.consumerCount).toBe(0);
  });

  it("re-subscribing the same id replaces the prior queue (one queue per id)", async () => {
    const tap = new MediaTap();
    const first = tap.subscribe("dup");
    const second = tap.subscribe("dup");
    expect(await first.next()).toBeNull(); // the old handle was closed
    expect(tap.publish(frameInput())).toBe(1); // only the new one is registered
    expect((await second.next())?.seq).toBe(1);
  });

  it("stats() is a whole-tap receipt: seq high-water + per-consumer delivered/dropped/depth", async () => {
    const tap = new MediaTap(2);
    const a = tap.subscribe("a");
    tap.subscribe("b");
    tap.publish(frameInput());
    tap.publish(frameInput());
    tap.publish(frameInput()); // b never drains → 1 drop for b; a drains below
    await a.next();
    const stats = tap.stats();
    expect(stats.seq).toBe(3);
    const b = stats.consumers.find((c) => c.consumerId === "b")!;
    expect(b.dropped).toBe(1);
    expect(b.depth).toBe(2);
    const av = stats.consumers.find((c) => c.consumerId === "a")!;
    expect(av.delivered).toBe(1);
  });
});

describe("pumpConsumer — the P3 consumer adapter contract", () => {
  it("drives onFrame for every frame until the handle closes, then calls onClose", async () => {
    const tap = new MediaTap();
    const handle = tap.subscribe("rec");
    const seen: number[] = [];
    const onClose = vi.fn();
    const consumer: MediaConsumer = { id: "rec", selector: {}, onFrame: (f) => void seen.push(f.seq), onClose };
    const pump = pumpConsumer(handle, consumer);
    tap.publish(frameInput());
    tap.publish(frameInput());
    // let the microtask pump drain, then close
    await new Promise((r) => setTimeout(r, 0));
    tap.unsubscribe("rec");
    await pump;
    expect(seen).toEqual([1, 2]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("isolates a THROWING onFrame — the pump survives and keeps delivering", async () => {
    const tap = new MediaTap();
    const handle = tap.subscribe("bad");
    let calls = 0;
    const consumer: MediaConsumer = {
      id: "bad",
      selector: {},
      onFrame: () => {
        calls++;
        throw new Error("consumer boom");
      },
    };
    const pump = pumpConsumer(handle, consumer);
    tap.publish(frameInput());
    tap.publish(frameInput());
    await new Promise((r) => setTimeout(r, 0));
    tap.unsubscribe("bad");
    await expect(pump).resolves.toBeUndefined(); // never rejected despite every onFrame throwing
    expect(calls).toBe(2);
  });
});

describe("DO glue — flag gate + registry resolution + tapPublishFrame", () => {
  const state = (): RoomState => ({
    config: { roomId: "r1", org: "org-A" },
    participants: {},
    tracks: { mic: { trackName: "mic", sessionId: "sess-1", participantId: "p1", kind: "audio", lastSeenAt: 0 } },
    emptyAt: null,
    policy: null,
    waiting: {},
    banned: [],
    admitted: [],
  });

  it("mediaTapEnabled is truthy only for true/'1'/'true'", () => {
    expect(mediaTapEnabled({ MEDIA_TAP_ENABLED: "1" })).toBe(true);
    expect(mediaTapEnabled({ MEDIA_TAP_ENABLED: "true" })).toBe(true);
    expect(mediaTapEnabled({ MEDIA_TAP_ENABLED: true })).toBe(true);
    expect(mediaTapEnabled({})).toBe(false);
    expect(mediaTapEnabled({ MEDIA_TAP_ENABLED: "0" })).toBe(false);
    expect(mediaTapEnabled({ MEDIA_TAP_ENABLED: "yes" })).toBe(false);
  });

  it("resolveTapTrack maps (session,track) → (participant,kind) from the registry; unknown → null (fail-closed)", () => {
    expect(resolveTapTrack(state(), "sess-1", "mic")).toEqual({ participantId: "p1", kind: "audio" });
    expect(resolveTapTrack(state(), "sess-1", "ghost")).toBeNull(); // unknown track
    expect(resolveTapTrack(state(), "wrong-sess", "mic")).toBeNull(); // track owned by a different session
  });

  it("tapPublishFrame is INERT when the flag is off (no snapshot read, no publish)", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("c");
    const snapshot = vi.fn(async () => state());
    await tapPublishFrame(tap, {}, snapshot, "sess-1", "mic", BYTES, 5);
    expect(snapshot).not.toHaveBeenCalled(); // gated BEFORE the snapshot read
    expect(tap.stats().seq).toBe(0);
    void h;
  });

  it("tapPublishFrame publishes a resolved frame when armed; an unresolved frame fans out to no one", async () => {
    const tap = new MediaTap();
    const h = tap.subscribe("c");
    await tapPublishFrame(tap, { MEDIA_TAP_ENABLED: "1" }, async () => state(), "sess-1", "mic", BYTES, 7);
    const f = (await h.next()) as TapFrame;
    expect(f).toMatchObject({ participantId: "p1", kind: "audio", trackName: "mic", ts: 7, seq: 1 });
    // unknown track when armed → resolves null → nothing published
    await tapPublishFrame(tap, { MEDIA_TAP_ENABLED: "1" }, async () => state(), "sess-1", "ghost", BYTES, 8);
    expect(tap.stats().seq).toBe(1); // unchanged
  });

  it("tapPublishFrame is FAIL-OPEN — a throwing snapshot never propagates (media-safety > fan-out)", async () => {
    const tap = new MediaTap();
    const boom = async (): Promise<RoomState> => {
      throw new Error("storage boom");
    };
    await expect(tapPublishFrame(tap, { MEDIA_TAP_ENABLED: "1" }, boom, "sess-1", "mic", BYTES, 3)).resolves.toBeUndefined();
    expect(tap.stats().seq).toBe(0); // nothing published, no throw
  });

  it("DEFAULT_HIGH_WATER is a sane positive bound", () => {
    expect(DEFAULT_HIGH_WATER).toBeGreaterThan(0);
  });
});
