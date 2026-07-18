// #91 B2 / #35 — source-to-whip relay orchestration tests. Pure: fake pull/publish + pcFactory, NO werift, NO
// network. Proves the ORCHESTRATION (pull→collect tracks→publish verbatim→teardown + fail-loud); the live RTP
// forwarding is a ◆ go-live proof (§7.6), out of unit-test scope.
import { describe, it, expect, vi } from "vitest";
import { runRelay } from "../server/relay.mjs";

const SRC = "https://customer-abc.cloudflarestream.com/uid123/manifest/video.m3u8?protocol=llhls";
const WHIP = "https://gateway.wave.online/v1/whip/publish";
const KEY = "test-bridge-key-not-a-secret"; // fake fixture (avoid the wk_ prefix the secret-scan watches)

// A fake pull() that connects and surfaces the given tracks, then reports the source session.
function fakePull(tracks, { fail = false } = {}) {
  return vi.fn(async ({ onTrack, onState }) => {
    for (const t of tracks) onTrack?.(t);
    onState?.(fail ? "failed" : "connected");
    return { stop: vi.fn(async () => {}) };
  });
}

function fakePublish() {
  return vi.fn(async ({ source }) => ({
    stop: vi.fn(async () => {}),
    resourceUrl: "https://gateway.wave.online/v1/whip/resource/abc",
    _source: source,
  }));
}

const pcFactory = () => ({});

describe("runRelay — orchestration", () => {
  it("pulls the source, collects tracks, and republishes them VERBATIM via publish({ tracks })", async () => {
    const v = { kind: "video" };
    const a = { kind: "audio" };
    const pull = fakePull([v, a]);
    const publish = fakePublish();

    const relay = await runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory });

    expect(pull).toHaveBeenCalledOnce();
    expect(pull.mock.calls[0][0].srcUrl).toBe(SRC);
    expect(publish).toHaveBeenCalledOnce();
    const pubArg = publish.mock.calls[0][0];
    expect(pubArg.endpoint).toBe(WHIP);
    expect(pubArg.key).toBe(KEY);
    expect(pubArg.source.tracks).toEqual([v, a]); // same tracks, no transcode
    expect(relay.trackCount).toBe(2);
  });

  it("passes a signed-source Bearer through to pull() (contract Q-2)", async () => {
    const pull = fakePull([{ kind: "video" }]);
    await runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, sourceAuth: "tok_signed", pull, publish: fakePublish(), pcFactory });
    expect(pull.mock.calls[0][0].auth).toBe("tok_signed");
  });

  it("stop() tears down BOTH legs (idempotent — WHIP then source)", async () => {
    const whipStop = vi.fn(async () => {});
    const srcStop = vi.fn(async () => {});
    const pull = vi.fn(async ({ onTrack, onState }) => {
      onTrack?.({ kind: "audio" });
      onState?.("connected");
      return { stop: srcStop };
    });
    const publish = vi.fn(async () => ({ stop: whipStop, resourceUrl: "p" }));

    const relay = await runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory });
    await relay.stop();
    await relay.stop(); // idempotent
    expect(whipStop).toHaveBeenCalledOnce();
    expect(srcStop).toHaveBeenCalledOnce();
  });

  it("FAILS LOUD when the source leg fails (no live media) — and tears down", async () => {
    const srcStop = vi.fn(async () => {});
    const pull = vi.fn(async ({ onState }) => {
      onState?.("failed");
      return { stop: srcStop };
    });
    const publish = fakePublish();
    await expect(
      runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory }),
    ).rejects.toThrow(/source leg failed/);
    expect(publish).not.toHaveBeenCalled(); // never publish a dead source
  });

  it("FAILS LOUD when the source connects but surfaces NO tracks (misconfigured source)", async () => {
    const pull = fakePull([]); // connected, zero tracks
    const publish = fakePublish();
    await expect(
      runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory }),
    ).rejects.toThrow(/no tracks/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("FAILS LOUD when the WHIP-out leg throws — and tears the source leg down", async () => {
    const srcStop = vi.fn(async () => {});
    const pull = vi.fn(async ({ onTrack, onState }) => {
      onTrack?.({ kind: "video" });
      onState?.("connected");
      return { stop: srcStop };
    });
    const publish = vi.fn(async () => { throw new Error("WHIP publish failed: expected 201, got 401"); });
    await expect(
      runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory }),
    ).rejects.toThrow(/401/);
    expect(srcStop).toHaveBeenCalledOnce(); // cleaned up the source leg on WHIP failure
  });

  it("applies adaptTrack to map source tracks to WHIP-out publish tracks (default identity)", async () => {
    const received = { kind: "video", _id: "received" };
    const pull = fakePull([received]);
    const publish = fakePublish();
    const adaptTrack = vi.fn((t) => ({ kind: t.kind, _id: "relay", _from: t._id }));

    await runRelay({ sourceUrl: SRC, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory, adaptTrack });

    expect(adaptTrack).toHaveBeenCalledWith(received);
    expect(publish.mock.calls[0][0].source.tracks[0]).toEqual({ kind: "video", _id: "relay", _from: "received" });
  });

  it("requires sourceUrl / whipUrl / whipKey (guards)", async () => {
    await expect(runRelay({ whipUrl: WHIP, whipKey: KEY, pull: fakePull([]), publish: fakePublish(), pcFactory }))
      .rejects.toThrow(/sourceUrl is required/);
    await expect(runRelay({ sourceUrl: SRC, whipKey: KEY, pull: fakePull([]), publish: fakePublish(), pcFactory }))
      .rejects.toThrow(/whipUrl is required/);
    await expect(runRelay({ sourceUrl: SRC, whipUrl: WHIP, pull: fakePull([]), publish: fakePublish(), pcFactory }))
      .rejects.toThrow(/whipKey is required/);
  });
});
