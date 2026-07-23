// #88 M2 — RtmsBridgeCore state machine (src/rtms-bridge-core.ts). Proves the full outbound sequence with
// mock sockets (zero live Zoom/SFU): create the SFU ingest adapter, dial signaling with the handshake
// signature, open the media leg on the ack with the data handshake, echo keepalives on BOTH legs, and
// transcode one MEDIA_DATA_AUDIO frame to the exact 48k-stereo encodeIngestFrame wire bytes on the ingest
// socket. The auth/protocol/audio primitives it composes are each independently vector-pinned (#145).
import { describe, it, expect, vi } from "vitest";
import {
  RtmsBridgeCore,
  pickMediaUrl,
  MAX_RTMS_PARTICIPANTS,
  MoqTrackSink,
  type RtmsBridgeDeps,
  type RtmsBridgeConfig,
  type RtmsSocket,
  type ParticipantSink,
  type MoqForwardWriter,
} from "../src/rtms-bridge-core.js";
import type { IngestSocket } from "../src/agent-session.js";
import type { RtmsStartedEvent } from "../src/zoom-rtms-bridge.js";
import { rtmsHandshakeSignature } from "../src/rtms-auth.js";
import { signalingHandshakeReq, dataHandshakeReq, keepAliveResp, RTMS_MEDIA_TYPE } from "../src/rtms-protocol.js";
import { rtmsAudioToSfuPcm, int16ToPcmS16Le } from "../src/rtms-audio.js";
import { encodeIngestFrame } from "../src/agent-ingest-adapter.js";
import { bytesToBase64 } from "../src/twilio-mediastream.js";

interface FakeLeg {
  url: string;
  onMessage: (t: string) => void | Promise<void>;
  onClose?: () => void;
  sent: string[];
  closed: boolean;
}

const EVENT: RtmsStartedEvent = {
  kind: "rtms_started",
  meetingUuid: "mtg-uuid-xyz",
  rtmsStreamId: "stream-77",
  serverUrls: "wss://signal.zoom.us",
};

/** Build a fresh core + capture harness (mock Zoom legs + capturing SFU ingest sinks, audio + video). */
function harness(opts?: {
  ingestConnected?: boolean;
  videoEnabled?: boolean;
  videoIngestConnected?: boolean;
  withVideoTarget?: boolean;
  perParticipantEnabled?: boolean;
  sinks?: (userId: string | null) => ParticipantSink[];
  log?: (msg: string, fields: Record<string, unknown>) => void;
}) {
  const legs: FakeLeg[] = [];
  const ingestSent: Uint8Array[] = [];
  const videoIngestSent: Uint8Array[] = [];
  const sink: IngestSocket = { send: (d) => ingestSent.push(d as Uint8Array), close: () => {} };
  const videoSink: IngestSocket = { send: (d) => videoIngestSent.push(d as Uint8Array), close: () => {} };
  const connect = async (url: string, onMessage: (t: string) => void | Promise<void>, onClose?: () => void): Promise<RtmsSocket> => {
    const leg: FakeLeg = { url, onMessage, onClose, sent: [], closed: false };
    legs.push(leg);
    return { send: (d) => leg.sent.push(d), close: () => { leg.closed = true; } };
  };
  const createIngest = vi.fn(async (tracks) => ({ adapterId: "in_1", publishedSessionId: "cf_pub_sess", raw: { tracks } }));
  const deps: RtmsBridgeDeps = {
    connect,
    createIngest,
    ingestSocket: () => (opts?.ingestConnected ? sink : null),
    videoIngestSocket: () => (opts?.videoIngestConnected ? videoSink : null),
    sinks: opts?.sinks,
    now: () => 0,
    log: opts?.log ?? (() => {}),
  };
  const config: RtmsBridgeConfig = {
    clientId: "APPID123",
    clientSecret: "s3cr3t",
    videoEnabled: opts?.videoEnabled,
    perParticipantEnabled: opts?.perParticipantEnabled,
    target: {
      appId: "a".repeat(32),
      bearer: "sfu-bearer",
      sessionId: "sess-12345678",
      trackName: "zoom-mtg",
      endpoint: "wss://rt.wave.online/zoom/rtms/ingest/mtg-uuid-xyz/org/sess-12345678/zoom-mtg?t=tok",
      ...(opts?.withVideoTarget
        ? {
            videoTrackName: "zoom-mtg-video",
            videoEndpoint: "wss://rt.wave.online/zoom/rtms/ingest/mtg-uuid-xyz/org/sess-12345678/zoom-mtg-video?t=tok",
          }
        : {}),
    },
  };
  return { core: new RtmsBridgeCore(deps, config), legs, ingestSent, videoIngestSent, createIngest, config };
}

const ackFrame = (audioUrl: string): string =>
  JSON.stringify({ msg_type: 2, status_code: 0, media_server: { server_urls: { audio: audioUrl } } });

describe("RtmsBridgeCore.start — ingest adapter + signaling handshake", () => {
  it("creates a location:local ingest adapter for the target then dials + signs the signaling leg", async () => {
    const { core, legs, createIngest, config } = harness();
    await core.start(EVENT);

    const tracks = createIngest.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(tracks[0]).toMatchObject({
      location: "local",
      sessionId: config.target.sessionId,
      trackName: config.target.trackName,
      endpoint: config.target.endpoint,
      inputCodec: "pcm",
      mode: "buffer",
    });

    expect(legs).toHaveLength(1);
    expect(legs[0].url).toBe("wss://signal.zoom.us");
    const sig = await rtmsHandshakeSignature("APPID123", EVENT.meetingUuid, EVENT.rtmsStreamId, "s3cr3t");
    expect(legs[0].sent[0]).toBe(signalingHandshakeReq(EVENT.meetingUuid, EVENT.rtmsStreamId, sig));
    expect(core.isStarted).toBe(true);
  });

  it("is idempotent — a second start() does not re-dial", async () => {
    const { core, legs } = harness();
    await core.start(EVENT);
    await core.start(EVENT);
    expect(legs).toHaveLength(1);
  });
});

describe("RtmsBridgeCore — signaling ack opens the media leg", () => {
  it("dials the ack's media URL and sends the AUDIO data handshake with the same signature", async () => {
    const { core, legs } = harness();
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));

    expect(legs).toHaveLength(2);
    expect(legs[1].url).toBe("wss://media.zoom.us/audio");
    const sig = await rtmsHandshakeSignature("APPID123", EVENT.meetingUuid, EVENT.rtmsStreamId, "s3cr3t");
    expect(legs[1].sent[0]).toBe(dataHandshakeReq(EVENT.meetingUuid, EVENT.rtmsStreamId, sig, RTMS_MEDIA_TYPE.AUDIO));
  });

  it("does not open a media leg on a non-zero signaling status (nack)", async () => {
    const { core, legs } = harness();
    await core.start(EVENT);
    await legs[0].onMessage(JSON.stringify({ msg_type: 2, status_code: 7, media_server: { server_urls: {} } }));
    expect(legs).toHaveLength(1);
  });
});

describe("RtmsBridgeCore — keepalives", () => {
  it("echoes KEEP_ALIVE_RESP on the signaling and media legs", async () => {
    const { core, legs } = harness();
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    await legs[0].onMessage(JSON.stringify({ msg_type: 12, timestamp: 111 }));
    await legs[1].onMessage(JSON.stringify({ msg_type: 12, timestamp: 222 }));
    expect(legs[0].sent).toContain(keepAliveResp(111));
    expect(legs[1].sent).toContain(keepAliveResp(222));
  });
});

describe("RtmsBridgeCore — audio pump", () => {
  it("transcodes one MEDIA_DATA_AUDIO frame to the exact 48k-stereo ingest wire bytes", async () => {
    const { core, legs, ingestSent } = harness({ ingestConnected: true });
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));

    const rtmsPcm = int16ToPcmS16Le(new Int16Array([100, -200, 300, 400]));
    const b64 = bytesToBase64(rtmsPcm);
    await legs[1].onMessage(JSON.stringify({ msg_type: 14, content: { user_id: 5, data: b64 } }));

    const expected = encodeIngestFrame(int16ToPcmS16Le(rtmsAudioToSfuPcm(rtmsPcm)), { sequenceNumber: 0, timestamp: 0 }, "packet");
    expect(ingestSent).toHaveLength(1);
    expect(ingestSent[0]).toEqual(expected);
  });

  it("drops audio (no throw) when the SFU ingest socket is not connected yet", async () => {
    const { core, legs, ingestSent } = harness({ ingestConnected: false });
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    const rtmsPcm = int16ToPcmS16Le(new Int16Array([1, 2, 3]));
    await legs[1].onMessage(JSON.stringify({ msg_type: 14, content: { data: bytesToBase64(rtmsPcm) } }));
    expect(ingestSent).toHaveLength(0);
  });
});

describe("RtmsBridgeCore — teardown", () => {
  it("a dropped leg tears down the whole bridge (both legs closed, idempotent)", async () => {
    const { core, legs } = harness();
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    legs[0].onClose?.();
    expect(legs[0].closed).toBe(true);
    expect(legs[1].closed).toBe(true);
    core.stop(); // idempotent — no throw, no double-close error
  });
});

// ── #RTMS-fanout — per-participant demux + multi-protocol sink fan-out (WAVE_RTMS_PER_PARTICIPANT) ──

/** A fake ParticipantSink that just records every frame it's given (audio/video separately). */
function fakeSink(): ParticipantSink & { audioFrames: Uint8Array[]; videoFrames: Uint8Array[]; closed: boolean } {
  const audioFrames: Uint8Array[] = [];
  const videoFrames: Uint8Array[] = [];
  return {
    audioFrames,
    videoFrames,
    closed: false,
    audio(frame) {
      audioFrames.push(frame);
    },
    video(frame) {
      videoFrames.push(frame);
    },
    close() {
      this.closed = true;
    },
  };
}

async function openMediaLeg(core: RtmsBridgeCore, legs: FakeLeg[]): Promise<void> {
  await core.start(EVENT);
  await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
}

const audioFrame = (userId: number, samples: number[]): string =>
  JSON.stringify({ msg_type: 14, content: { user_id: userId, data: bytesToBase64(int16ToPcmS16Le(new Int16Array(samples))) } });

describe("RtmsBridgeCore — per-participant demux (WAVE_RTMS_PER_PARTICIPANT)", () => {
  it("(a) flag OFF: a userId-bearing frame still goes through the single mixed track — byte-identical to today", async () => {
    const { core, legs, ingestSent } = harness({ ingestConnected: true }); // perParticipantEnabled unset (off)
    await openMediaLeg(core, legs);
    const rtmsPcm = int16ToPcmS16Le(new Int16Array([100, -200, 300, 400]));
    await legs[1].onMessage(JSON.stringify({ msg_type: 14, content: { user_id: 5, data: bytesToBase64(rtmsPcm) } }));
    const expected = encodeIngestFrame(int16ToPcmS16Le(rtmsAudioToSfuPcm(rtmsPcm)), { sequenceNumber: 0, timestamp: 0 }, "packet");
    expect(ingestSent).toHaveLength(1);
    expect(ingestSent[0]).toEqual(expected);
  });

  it("(b) flag ON + 2 distinct userIds: each gets its own sink fan-out with an independent seq counter", async () => {
    const sinkA = fakeSink();
    const sinkB = fakeSink();
    const sinks = (userId: string | null): ParticipantSink[] => (userId === "111" ? [sinkA] : userId === "222" ? [sinkB] : []);
    const { core, legs } = harness({ perParticipantEnabled: true, sinks });
    await openMediaLeg(core, legs);

    await legs[1].onMessage(audioFrame(111, [1, 2, 3, 4]));
    await legs[1].onMessage(audioFrame(222, [5, 6, 7, 8]));
    await legs[1].onMessage(audioFrame(111, [9, 10, 11, 12]));

    expect(sinkA.audioFrames).toHaveLength(2);
    expect(sinkB.audioFrames).toHaveLength(1);
    // independent seq counters: sinkA's 2nd frame is sequenceNumber 1, sinkB's 1st frame is sequenceNumber 0
    const a1 = int16ToPcmS16Le(rtmsAudioToSfuPcm(int16ToPcmS16Le(new Int16Array([1, 2, 3, 4]))));
    const a2 = int16ToPcmS16Le(rtmsAudioToSfuPcm(int16ToPcmS16Le(new Int16Array([9, 10, 11, 12]))));
    const b1 = int16ToPcmS16Le(rtmsAudioToSfuPcm(int16ToPcmS16Le(new Int16Array([5, 6, 7, 8]))));
    expect(sinkA.audioFrames[0]).toEqual(encodeIngestFrame(a1, { sequenceNumber: 0, timestamp: 0 }, "packet"));
    expect(sinkA.audioFrames[1]).toEqual(encodeIngestFrame(a2, { sequenceNumber: 1, timestamp: 0 }, "packet"));
    expect(sinkB.audioFrames[0]).toEqual(encodeIngestFrame(b1, { sequenceNumber: 0, timestamp: 0 }, "packet"));
  });

  it("(c) fan-out: one audio frame is teed to ALL sinks resolved for that participant, identical bytes", async () => {
    const sinkA = fakeSink();
    const sinkB = fakeSink();
    const sinks = (): ParticipantSink[] => [sinkA, sinkB];
    const { core, legs } = harness({ perParticipantEnabled: true, sinks });
    await openMediaLeg(core, legs);
    await legs[1].onMessage(audioFrame(1, [1, 2, 3, 4]));
    expect(sinkA.audioFrames).toHaveLength(1);
    expect(sinkB.audioFrames).toHaveLength(1);
    expect(sinkA.audioFrames[0]).toEqual(sinkB.audioFrames[0]);
  });

  it("(d) invalid/oversized userId falls back to the mixed track (no injection into a sink lookup)", async () => {
    const sinkCalls: Array<string | null> = [];
    const sinks = (userId: string | null): ParticipantSink[] => {
      sinkCalls.push(userId);
      return [];
    };
    const { core, legs, ingestSent } = harness({ perParticipantEnabled: true, sinks, ingestConnected: true });
    await openMediaLeg(core, legs);
    // A number large enough to stringify in scientific notation (e.g. "1e+21") contains "+"/"e" and fails
    // the ^[A-Za-z0-9_-]{1,64}$ allowlist — the sanitizer rejects it and the frame falls back to mixed.
    await legs[1].onMessage(
      JSON.stringify({ msg_type: 14, content: { user_id: 1e21, data: bytesToBase64(int16ToPcmS16Le(new Int16Array([1, 2]))) } }),
    );
    expect(sinkCalls).toHaveLength(0); // never reached deps.sinks() with an unsanitized id
    expect(ingestSent).toHaveLength(1); // routed to the mixed track instead
  });

  it("(e) over MAX_RTMS_PARTICIPANTS: overflow participants route to the mixed track and log the cap", async () => {
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const sinks = (): ParticipantSink[] => [fakeSink()];
    const { core, legs, ingestSent } = harness({
      perParticipantEnabled: true,
      sinks,
      ingestConnected: true,
      log: (msg, fields) => logs.push({ msg, fields }),
    });
    await openMediaLeg(core, legs);
    for (let i = 0; i < MAX_RTMS_PARTICIPANTS; i++) {
      await legs[1].onMessage(audioFrame(1000 + i, [1, 2]));
    }
    expect(ingestSent).toHaveLength(0); // all MAX_RTMS_PARTICIPANTS fit — none overflowed yet
    await legs[1].onMessage(audioFrame(9999, [3, 4])); // the (MAX+1)th distinct participant → overflow
    expect(ingestSent).toHaveLength(1); // overflow frame routed to the mixed track
    expect(logs.some((l) => l.msg === "rtms-participant-cap")).toBe(true);
  });
});

describe("pickMediaUrl", () => {
  it("prefers audio, then all, then any URL, else null", () => {
    expect(pickMediaUrl({ audio: "a", all: "x" })).toBe("a");
    expect(pickMediaUrl({ all: "x", video: "v" })).toBe("x");
    expect(pickMediaUrl({ video: "v" })).toBe("v");
    expect(pickMediaUrl({})).toBeNull();
  });
});

describe("RtmsBridgeCore — video (WAVE_RTMS_VIDEO)", () => {
  it("flag off (default): media handshake requests AUDIO only, no video track requested", async () => {
    const { core, legs, createIngest } = harness();
    await core.start(EVENT);
    const tracks = createIngest.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(1);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    const sig = await rtmsHandshakeSignature("APPID123", EVENT.meetingUuid, EVENT.rtmsStreamId, "s3cr3t");
    expect(legs[1].sent[0]).toBe(dataHandshakeReq(EVENT.meetingUuid, EVENT.rtmsStreamId, sig, RTMS_MEDIA_TYPE.AUDIO));
  });

  it("flag on + a video target: requests AUDIO|VIDEO and a second inputCodec:jpeg track", async () => {
    const { core, legs, createIngest } = harness({ videoEnabled: true, withVideoTarget: true });
    await core.start(EVENT);
    const tracks = createIngest.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(tracks).toHaveLength(2);
    expect(tracks[1]).toMatchObject({ inputCodec: "jpeg", mode: "buffer", trackName: "zoom-mtg-video" });
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    const sig = await rtmsHandshakeSignature("APPID123", EVENT.meetingUuid, EVENT.rtmsStreamId, "s3cr3t");
    expect(legs[1].sent[0]).toBe(
      dataHandshakeReq(EVENT.meetingUuid, EVENT.rtmsStreamId, sig, RTMS_MEDIA_TYPE.AUDIO | RTMS_MEDIA_TYPE.VIDEO),
    );
  });

  it("flag on + video ingest connected: maps one MEDIA_DATA_VIDEO frame to one ingest Packet, unchanged bytes", async () => {
    const { core, legs, videoIngestSent } = harness({ videoEnabled: true, withVideoTarget: true, videoIngestConnected: true });
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    const jpeg = Uint8Array.from([0xff, 0xd8, 7, 7, 7, 0xff, 0xd9]);
    await legs[1].onMessage(JSON.stringify({ msg_type: 15, content: { user_id: 5, data: bytesToBase64(jpeg) } }));
    const expected = encodeIngestFrame(jpeg, { sequenceNumber: 0, timestamp: 0 }, "packet");
    expect(videoIngestSent).toHaveLength(1);
    expect(videoIngestSent[0]).toEqual(expected);
  });

  it("flag on but video ingest socket not connected: drops the frame, no throw", async () => {
    const { core, legs, videoIngestSent } = harness({ videoEnabled: true, withVideoTarget: true, videoIngestConnected: false });
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    const jpeg = Uint8Array.from([0xff, 0xd8, 1, 0xff, 0xd9]);
    await legs[1].onMessage(JSON.stringify({ msg_type: 15, content: { data: bytesToBase64(jpeg) } }));
    expect(videoIngestSent).toHaveLength(0);
  });

  it("flag OFF: a MEDIA_DATA_VIDEO frame is ignored even if a video ingest socket exists (off-path never invoked)", async () => {
    const { core, legs, videoIngestSent } = harness({ videoEnabled: false, videoIngestConnected: true });
    await core.start(EVENT);
    await legs[0].onMessage(ackFrame("wss://media.zoom.us/audio"));
    const jpeg = Uint8Array.from([0xff, 0xd8, 2, 0xff, 0xd9]);
    await legs[1].onMessage(JSON.stringify({ msg_type: 15, content: { data: bytesToBase64(jpeg) } }));
    expect(videoIngestSent).toHaveLength(0);
  });
});

// #314 Slice 1 — MoqTrackSink: no writer injected → byte-identical to the pre-#314 inert log-only stub; a
// writer injected → every audio()/video() call forwards through it (uid, kind, ts, the exact frame bytes),
// a throwing writer is swallowed (never breaks the pump's fan-out loop), and close() reaches the writer.
describe("MoqTrackSink (#314 Slice 1)", () => {
  it("no writer: audio/video are logged only, never touch a writer, close() is a no-op", () => {
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const sink = new MoqTrackSink((msg, fields) => logs.push({ msg, fields }), "u1");
    const frame = Uint8Array.from([1, 2, 3]);
    sink.audio(frame);
    sink.video(frame);
    sink.close();
    expect(logs.map((l) => l.msg)).toEqual(["rtms-bridge-moq-sink-stub", "rtms-bridge-moq-sink-stub"]);
  });

  it("writer injected: forwards audio/video with the sanitized uid + injected clock, and close() closes it", () => {
    const calls: Array<{ uid: string; kind: string; ts: number; payload: Uint8Array }> = [];
    let closed = false;
    const writer: MoqForwardWriter = {
      writeFrame: (uid, kind, ts, payload) => calls.push({ uid, kind, ts, payload }),
      close: () => {
        closed = true;
      },
    };
    const sink = new MoqTrackSink(() => {}, "u42", writer, () => 12345);
    const audioFrame = Uint8Array.from([9, 9]);
    const videoFrame = Uint8Array.from([7, 7, 7]);
    sink.audio(audioFrame);
    sink.video(videoFrame);
    sink.close();
    expect(calls).toEqual([
      { uid: "u42", kind: "audio", ts: 12345, payload: audioFrame },
      { uid: "u42", kind: "video", ts: 12345, payload: videoFrame },
    ]);
    expect(closed).toBe(true);
  });

  it("a throwing writer is swallowed (logged), never thrown up into the caller", () => {
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const writer: MoqForwardWriter = {
      writeFrame: () => {
        throw new Error("container unreachable");
      },
      close: () => {
        throw new Error("close failed");
      },
    };
    const sink = new MoqTrackSink((msg, fields) => logs.push({ msg, fields }), "u1", writer);
    expect(() => sink.audio(Uint8Array.from([1]))).not.toThrow();
    expect(() => sink.close()).not.toThrow();
    expect(logs.find((l) => l.msg === "rtms-bridge-moq-sink-error")).toBeTruthy();
  });
});
