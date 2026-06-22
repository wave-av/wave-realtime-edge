// RT-R9 P2 — RoomDO/Signaling recording orchestration. Injected fakes only (RoomCore over in-memory storage,
// fake SFU, fake recording encoder). Proves: publish → onPublish once; leave → finalize; a finalize-throw is
// swallowed so leave still succeeds; the live "managed" path is a no-op (handle has no onPublish/null toMeta).
import { describe, it, expect, vi } from "vitest";
import { Signaling } from "../../src/signaling.js";
import type { RecordingHook } from "../../src/signaling.js";
import { RoomCore } from "../../src/room.js";
import { RoomRecording } from "../../src/room.js";
import type { RoomStorage } from "../../src/room.js";
import type { EncoderHandle, RecordingEncoder, RecordingSession } from "../../src/encoders/encoder.js";

function memStorage(): RoomStorage {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async put<T>(k: string, v: T) {
      m.set(k, v);
    },
  };
}

// Minimal SFU fake — newSession + pushTracks return canned shapes the signaling layer threads through.
function fakeSfu() {
  return {
    newSession: async () => ({ sessionId: "sfu-sess-1", sessionDescription: undefined }),
    pushTracks: async () => ({ tracks: [{ trackName: "mic" }] }),
    pullTracks: async () => ({ tracks: [] }),
    renegotiate: async () => ({ tracks: [] }),
  } as never;
}

const CTX = { org: "org_x", room: "r1", participantId: "p1", role: "host" as const };

async function seatAndPublish(rec: RecordingHook) {
  const core = new RoomCore(memStorage());
  const sig = new Signaling(core, fakeSfu(), {}, rec);
  await sig.join(CTX, {});
  await sig.publishTrack(CTX, { tracks: [{ mid: "0", trackName: "mic", kind: "audio" }], offer: { type: "offer", sdp: "x" } });
  return { core, sig };
}

describe("Signaling recording hook — publish → onPublish, leave → finalize", () => {
  it("publishTrack fires onPublish exactly once with the right (org,sessionId,room,track,kind)", async () => {
    const rec: RecordingHook = { onPublish: vi.fn(async () => {}), finalize: vi.fn(async () => {}) };
    await seatAndPublish(rec);
    expect(rec.onPublish).toHaveBeenCalledTimes(1);
    expect(rec.onPublish).toHaveBeenCalledWith("org_x", "sfu-sess-1", "r1", "mic", "audio");
  });

  it("leave fires finalize with the leaving participant's SFU sessionId", async () => {
    const rec: RecordingHook = { onPublish: vi.fn(async () => {}), finalize: vi.fn(async () => {}) };
    const { sig } = await seatAndPublish(rec);
    await sig.leave(CTX);
    expect(rec.finalize).toHaveBeenCalledWith("sfu-sess-1");
  });

  it("a finalize THROW is swallowed → leave still resolves (media-safety > recording)", async () => {
    const rec: RecordingHook = {
      onPublish: vi.fn(async () => {}),
      finalize: vi.fn(async () => {
        throw new Error("recorder boom");
      }),
    };
    const { sig } = await seatAndPublish(rec);
    await expect(sig.leave(CTX)).resolves.toBeUndefined();
  });

  it("an onPublish THROW is swallowed → publish still resolves", async () => {
    const rec: RecordingHook = {
      onPublish: vi.fn(async () => {
        throw new Error("arm boom");
      }),
      finalize: vi.fn(async () => {}),
    };
    const core = new RoomCore(memStorage());
    const sig = new Signaling(core, fakeSfu(), {}, rec);
    await sig.join(CTX, {});
    await expect(
      sig.publishTrack(CTX, { tracks: [{ mid: "0", trackName: "mic", kind: "audio" }], offer: { type: "offer", sdp: "x" } }),
    ).resolves.toBeDefined();
  });

  it("no recording hook → publish/leave behave exactly as before (recording is a no-op)", async () => {
    const core = new RoomCore(memStorage());
    const sig = new Signaling(core, fakeSfu(), {}); // no hook
    await sig.join(CTX, {});
    await sig.publishTrack(CTX, { tracks: [{ mid: "0", trackName: "mic", kind: "audio" }], offer: { type: "offer", sdp: "x" } });
    await expect(sig.leave(CTX)).resolves.toBeUndefined();
  });
});

// ── RoomRecording — the per-DO orchestrator: lazy encoder, fail-open, managed no-op ──
const SESSION_ID = "sfu-sess-1";

function fakeHandle(over: Partial<EncoderHandle> = {}): EncoderHandle {
  return {
    onPublish: vi.fn(async () => {}),
    finalize: vi.fn(async () => null),
    abort: vi.fn(async () => {}),
    toMeta: () => null,
    ...over,
  };
}
function fakeEncoder(handle: EncoderHandle | null): RecordingEncoder {
  return { kind: "container", begin: vi.fn(async (_s: RecordingSession) => handle) };
}

describe("RoomRecording — lazy, fail-open, managed no-op", () => {
  it("begins the handle once on first publish, forwards onPublish", async () => {
    const handle = fakeHandle();
    const enc = fakeEncoder(handle);
    const r = new RoomRecording({ __recordingEncoder: enc }, memStorage());
    await r.onPublish("org_x", SESSION_ID, "r1", "mic", "audio");
    await r.onPublish("org_x", SESSION_ID, "r1", "mic2", "audio");
    expect(enc.begin).toHaveBeenCalledTimes(1); // lazy + cached per session
    expect(handle.onPublish).toHaveBeenCalledTimes(2);
  });

  it("a disarmed encoder (begin → null) records nothing, never throws", async () => {
    const enc = fakeEncoder(null);
    const r = new RoomRecording({ __recordingEncoder: enc }, memStorage());
    await expect(r.onPublish("org_x", SESSION_ID, "r1", "mic", "audio")).resolves.toBeUndefined();
  });

  it("finalize forwards to the handle then clears it (idempotent)", async () => {
    const handle = fakeHandle();
    const r = new RoomRecording({ __recordingEncoder: fakeEncoder(handle) }, memStorage());
    await r.onPublish("org_x", SESSION_ID, "r1", "mic", "audio");
    await r.finalize(SESSION_ID);
    expect(handle.finalize).toHaveBeenCalledTimes(1);
    await r.finalize(SESSION_ID); // already cleared → no second call
    expect(handle.finalize).toHaveBeenCalledTimes(1);
  });

  it("a managed-style handle (no onPublish, null toMeta) is a no-op but never throws", async () => {
    const managed = { finalize: vi.fn(async () => null), abort: vi.fn(async () => {}), toMeta: () => null } as EncoderHandle;
    const r = new RoomRecording({ __recordingEncoder: fakeEncoder(managed) }, memStorage());
    await expect(r.onPublish("org_x", SESSION_ID, "r1", "mic", "audio")).resolves.toBeUndefined();
    await expect(r.finalize(SESSION_ID)).resolves.toBeUndefined();
  });

  it("feedFrame is a no-op when no container tap is held (managed/no handle)", async () => {
    const r = new RoomRecording({ __recordingEncoder: fakeEncoder(fakeHandle()) }, memStorage());
    await expect(r.feedFrame(SESSION_ID, "mic", new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  });
});
