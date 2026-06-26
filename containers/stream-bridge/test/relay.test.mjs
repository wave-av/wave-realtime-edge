// #91 B2 — whep-to-whip relay orchestration tests. Pure: fake pull/publish + pcFactory, NO werift, NO network.
// Proves the ORCHESTRATION (pull→collect tracks→publish verbatim→teardown + fail-loud); the live RTP
// forwarding is a ◆ go-live proof (§7.6), out of unit-test scope.
import { describe, it, expect, vi } from "vitest";
import { runRelay } from "../server/relay.mjs";

const WHEP = "https://customer-abc.cloudflarestream.com/uid123/webRTC/play";
const WHIP = "https://gateway.wave.online/v1/whip/publish";
const KEY = "test-bridge-key-not-a-secret"; // fake fixture (avoid the wk_ prefix the secret-scan watches)

// A fake pull() that connects and surfaces the given tracks, then reports the WHEP session.
function fakePull(tracks, { fail = false } = {}) {
  return vi.fn(async ({ onTrack, onState }) => {
    for (const t of tracks) onTrack?.(t);
    onState?.(fail ? "failed" : "connected");
    return { stop: vi.fn(async () => {}), resourceUrl: "https://whep/resource/1" };
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
  it("pulls WHEP, collects tracks, and republishes them VERBATIM via publish({ tracks })", async () => {
    const v = { kind: "video" };
    const a = { kind: "audio" };
    const pull = fakePull([v, a]);
    const publish = fakePublish();

    const relay = await runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory });

    expect(pull).toHaveBeenCalledOnce();
    expect(pull.mock.calls[0][0].whepUrl).toBe(WHEP);
    expect(publish).toHaveBeenCalledOnce();
    const pubArg = publish.mock.calls[0][0];
    expect(pubArg.endpoint).toBe(WHIP);
    expect(pubArg.key).toBe(KEY);
    expect(pubArg.source.tracks).toEqual([v, a]); // same tracks, no transcode
    expect(relay.trackCount).toBe(2);
  });

  it("passes a signed-WHEP Bearer through to pull() (contract Q-2)", async () => {
    const pull = fakePull([{ kind: "video" }]);
    await runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, whepAuth: "tok_signed", pull, publish: fakePublish(), pcFactory });
    expect(pull.mock.calls[0][0].auth).toBe("tok_signed");
  });

  it("stop() tears down BOTH legs (idempotent — WHIP then WHEP)", async () => {
    const whipStop = vi.fn(async () => {});
    const whepStop = vi.fn(async () => {});
    const pull = vi.fn(async ({ onTrack, onState }) => {
      onTrack?.({ kind: "audio" });
      onState?.("connected");
      return { stop: whepStop, resourceUrl: "w" };
    });
    const publish = vi.fn(async () => ({ stop: whipStop, resourceUrl: "p" }));

    const relay = await runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory });
    await relay.stop();
    await relay.stop(); // idempotent
    expect(whipStop).toHaveBeenCalledOnce();
    expect(whepStop).toHaveBeenCalledOnce();
  });

  it("FAILS LOUD when the WHEP leg fails (no live egress) — and tears down", async () => {
    const whepStop = vi.fn(async () => {});
    const pull = vi.fn(async ({ onState }) => {
      onState?.("failed");
      return { stop: whepStop, resourceUrl: "w" };
    });
    const publish = fakePublish();
    await expect(
      runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory }),
    ).rejects.toThrow(/WHEP-in leg failed/);
    expect(publish).not.toHaveBeenCalled(); // never publish a dead source
  });

  it("FAILS LOUD when WHEP connects but surfaces NO tracks (misconfigured source)", async () => {
    const pull = fakePull([]); // connected, zero tracks
    const publish = fakePublish();
    await expect(
      runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory }),
    ).rejects.toThrow(/no tracks/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("FAILS LOUD when the WHIP-out leg throws — and tears the WHEP leg down", async () => {
    const whepStop = vi.fn(async () => {});
    const pull = vi.fn(async ({ onTrack, onState }) => {
      onTrack?.({ kind: "video" });
      onState?.("connected");
      return { stop: whepStop, resourceUrl: "w" };
    });
    const publish = vi.fn(async () => { throw new Error("WHIP publish failed: expected 201, got 401"); });
    await expect(
      runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory }),
    ).rejects.toThrow(/401/);
    expect(whepStop).toHaveBeenCalledOnce(); // cleaned up the WHEP leg on WHIP failure
  });

  it("applies adaptTrack to map WHEP-in tracks to WHIP-out publish tracks (werift relay seam)", async () => {
    const received = { kind: "video", _id: "received" };
    const pull = fakePull([received]);
    const publish = fakePublish();
    const adaptTrack = vi.fn((t) => ({ kind: t.kind, _id: "relay", _from: t._id }));

    await runRelay({ whepUrl: WHEP, whipUrl: WHIP, whipKey: KEY, pull, publish, pcFactory, adaptTrack });

    expect(adaptTrack).toHaveBeenCalledWith(received);
    expect(publish.mock.calls[0][0].source.tracks[0]).toEqual({ kind: "video", _id: "relay", _from: "received" });
  });

  it("requires whepUrl / whipUrl / whipKey (guards)", async () => {
    await expect(runRelay({ whipUrl: WHIP, whipKey: KEY, pull: fakePull([]), publish: fakePublish(), pcFactory }))
      .rejects.toThrow(/whepUrl is required/);
    await expect(runRelay({ whepUrl: WHEP, whipKey: KEY, pull: fakePull([]), publish: fakePublish(), pcFactory }))
      .rejects.toThrow(/whipUrl is required/);
    await expect(runRelay({ whepUrl: WHEP, whipUrl: WHIP, pull: fakePull([]), publish: fakePublish(), pcFactory }))
      .rejects.toThrow(/whipKey is required/);
  });
});
