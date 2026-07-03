// #76 P3 (arch A, co-locate) — the READ port: tapped frames drive the real VAD→STT→LLM→TTS turn-loop instead of
// the P2 counting receipt. Proves: the sink forwards AUDIO frame bytes to the driver + drops non-audio; a driver
// defect (sync throw OR async rejection) never escapes into the tap drain; close() forwards; the live driver
// factory is fail-closed on voiceAgentEnabled and delegates onFrame to a real TurnTakingCore over a fake media
// seam (no network); and RoomDO.armAgentRead swaps in the turn-loop sink when a driver is injected.
import { describe, it, expect } from "vitest";
import { buildTurnLoopSink, buildRoomTurnLoopDriver, type TurnLoopDriver } from "../src/agent-turn-sink.js";
import type { TapFrame } from "../src/media-tap.js";
import type { AgentMediaDeps, IngestSocket } from "../src/agent-session.js";
import type { AgentTurnEnv, TurnTakingConfig } from "../src/agent-turn.js";
import { RoomDO } from "../src/room.js";
import type { RoomDOEnv } from "../src/room.js";

const PCM = new Uint8Array([1, 2, 3, 4]);
function audioFrame(bytes = PCM): TapFrame {
  return { sessionId: "s", trackName: "mic", kind: "audio", participantId: "p1", seq: 1, ts: 0, bytes };
}
function videoFrame(): TapFrame {
  return { sessionId: "s", trackName: "cam", kind: "video", participantId: "p1", seq: 2, ts: 0, bytes: PCM };
}

describe("#76 P3 — buildTurnLoopSink (tap → turn-loop bridge)", () => {
  it("forwards an AUDIO frame's bytes to the driver as PCM", () => {
    const got: Uint8Array[] = [];
    const sink = buildTurnLoopSink({ onFrame: (pcm) => void got.push(pcm) });
    sink.onFrame(audioFrame());
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(PCM); // the exact tapped bytes, no copy/transcode
  });

  it("DROPS a non-audio frame (never feeds video bytes to STT as PCM)", () => {
    let calls = 0;
    const sink = buildTurnLoopSink({ onFrame: () => void calls++ });
    sink.onFrame(videoFrame());
    expect(calls).toBe(0);
  });

  it("swallows a SYNCHRONOUS driver throw — never escapes into the tap drain", () => {
    const sink = buildTurnLoopSink({ onFrame: () => { throw new Error("driver boom"); } });
    expect(() => sink.onFrame(audioFrame())).not.toThrow();
  });

  it("swallows an ASYNC driver rejection — no unhandled rejection into pumpConsumer", async () => {
    const sink = buildTurnLoopSink({ onFrame: () => Promise.reject(new Error("async boom")) });
    expect(() => sink.onFrame(audioFrame())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the rejected microtask settle; the .catch must have eaten it
  });

  it("onClose forwards to driver.close() (releases the TTS-out ingest socket)", () => {
    let closed = 0;
    const sink = buildTurnLoopSink({ onFrame: () => {}, close: () => void closed++ });
    sink.onClose?.();
    expect(closed).toBe(1);
  });

  it("onClose is safe when driver.close throws or is absent", () => {
    expect(() => buildTurnLoopSink({ onFrame: () => {} }).onClose?.()).not.toThrow();
    expect(() => buildTurnLoopSink({ onFrame: () => {}, close: () => { throw new Error("x"); } }).onClose?.()).not.toThrow();
  });
});

// A media seam with a live INGEST socket (TTS-out) and DEAD egress (the tap replaced it in arch A). createEgress/
// createIngest are never called by core construction or a silent frame, so they reject to prove they're unused.
function fakeMedia(socket: IngestSocket | null): AgentMediaDeps {
  return {
    createEgress: () => Promise.reject(new Error("egress is DEAD in arch A — the tap is the read")),
    createIngest: () => Promise.reject(new Error("ingest adapter opened by the ◆-arm slice, not core ctor")),
    ingestSocket: () => socket,
    now: () => 0,
    log: () => {},
  };
}

const TURN_CONFIG: TurnTakingConfig = {
  roomId: "room-1", org: "org-A", agentId: "a1", participantSessionId: "sess-1", participantTrackName: "mic",
};

describe("#76 P3 — buildRoomTurnLoopDriver (live core factory)", () => {
  it("is FAIL-CLOSED — returns null unless VOICE_AGENT_PROVIDER==='wave'", () => {
    const env = {} as AgentTurnEnv; // provider unset
    expect(buildRoomTurnLoopDriver({ env, config: TURN_CONFIG, media: fakeMedia(null) })).toBeNull();
  });

  it("builds a real TurnTakingCore whose onFrame accepts a tapped PCM frame (no network on silence)", async () => {
    const env = { VOICE_AGENT_PROVIDER: "wave" } as AgentTurnEnv;
    const driver = buildRoomTurnLoopDriver({ env, config: TURN_CONFIG, media: fakeMedia(null) });
    expect(driver).not.toBeNull();
    // A tiny frame drives VAD only — it never endpoints an utterance, so no STT/LLM/TTS network is reached.
    await expect(Promise.resolve(driver!.onFrame(PCM))).resolves.not.toThrow();
  });

  it("close() closes the TTS-out ingest socket (room-end releases the publish track)", () => {
    let closed = 0;
    const socket: IngestSocket = { send: () => {}, close: () => void closed++ };
    const env = { VOICE_AGENT_PROVIDER: "wave" } as AgentTurnEnv;
    const driver = buildRoomTurnLoopDriver({ env, config: TURN_CONFIG, media: fakeMedia(socket) });
    driver!.close?.();
    expect(closed).toBe(1);
  });
});

describe("#76 P3 — RoomDO.armAgentRead swaps in the turn-loop sink when a driver is injected", () => {
  function memStorage() {
    const map = new Map<string, unknown>();
    return { get: async <T>(k: string) => map.get(k) as T | undefined, put: async <T>(k: string, v: T) => void map.set(k, v) };
  }
  async function seededRoom(env: RoomDOEnv) {
    const do_ = new RoomDO({ storage: memStorage() }, env);
    await do_.ensureRoom({ roomId: "room-1", org: "org-A" });
    await do_.joinRoom("org-A", { participantId: "p1", sessionId: "sess-1", role: "host" });
    await do_.registerTrack("org-A", { trackName: "mic", sessionId: "sess-1", participantId: "p1", kind: "audio" });
    return do_;
  }

  it("routes tapped frames into the injected driver (NOT the P2 counting receipt)", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    const got: Uint8Array[] = [];
    const driver: TurnLoopDriver = { onFrame: (pcm) => void got.push(pcm) };
    expect(do_.armAgentRead({ agentId: "a1", participantTrackName: "mic" }, driver)).toBe(true);
    await do_.feedRecorderFrame("sess-1", "mic", PCM);
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1); // frame reached the turn-loop driver
    expect(do_.agentReadFrameCount).toBe(0); // the P2 counting receipt did NOT run
  });

  it("stays byte-identically INERT with a driver when MEDIA_TAP_ENABLED is off", async () => {
    const do_ = await seededRoom({});
    const got: Uint8Array[] = [];
    expect(do_.armAgentRead({ agentId: "a1", participantTrackName: "mic" }, { onFrame: (pcm) => void got.push(pcm) })).toBe(false);
    await do_.feedRecorderFrame("sess-1", "mic", PCM);
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(0);
  });
});
