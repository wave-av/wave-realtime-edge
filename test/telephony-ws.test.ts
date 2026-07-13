import { describe, it, expect } from "vitest";
import {
  TelephonyBridgeCore,
  maybeHandleTelephonyStream,
  type TelephonyBridgeDeps,
  type TelephonyTarget,
} from "../src/telephony-ws.js";
import { telephonyStreamEnabled, type Env } from "../src/dispatch-helpers.js";
import { bytesToBase64, twilioMediaFrame } from "../src/twilio-mediastream.js";
import { twilioMuLawToSfuPcm, sfuPcmToTwilioMuLaw } from "../src/telephony-codec.js";
import { int16ToPcmS16Le } from "../src/rtms-audio.js";
import { encodeIngestFrame, chunkPcm } from "../src/agent-ingest-adapter.js";
import type { IngestSocket } from "../src/agent-session.js";

// ── test doubles ───────────────────────────────────────────────────────────────────────────────
function makeIngestSocket(): { sent: Uint8Array[]; sock: IngestSocket } {
  const sent: Uint8Array[] = [];
  return {
    sent,
    sock: {
      send: (data: ArrayBufferView | ArrayBuffer) => {
        sent.push(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    },
  };
}

function makeDeps(overrides: Partial<TelephonyBridgeDeps> = {}): {
  deps: TelephonyBridgeDeps;
  twilioSent: string[];
  ingestCalls: number;
  logs: Array<{ msg: string; fields: Record<string, unknown> }>;
} {
  const twilioSent: string[] = [];
  const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  let ingestCalls = 0;
  const deps: TelephonyBridgeDeps = {
    createIngest: async () => {
      ingestCalls++;
      return { raw: {} };
    },
    ingestSocket: () => null,
    twilioSend: (t) => twilioSent.push(t),
    now: () => 1000,
    log: (msg, fields) => logs.push({ msg, fields }),
    ...overrides,
  };
  return { deps, twilioSent, get ingestCalls() { return ingestCalls; }, logs };
}

function startFrame(streamSid: string): string {
  return JSON.stringify({
    event: "start",
    streamSid,
    start: { callSid: "CA123", accountSid: "AC1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: {} },
  });
}
function mediaFrame(streamSid: string, muLaw: Uint8Array): string {
  return JSON.stringify({ event: "media", streamSid, media: { track: "inbound", chunk: "1", timestamp: "20", payload: bytesToBase64(muLaw) } });
}

const TARGET: TelephonyTarget = {
  appId: "a".repeat(32),
  bearer: "sfu-bearer",
  sessionId: "sess-0001",
  trackName: "tel-STREAM1",
  endpoint: "wss://rt.wave.online/v1/realtime/agents/ingest/org/room/sess-0001/tel-STREAM1?t=x",
};

// ── INBOUND: parse → decode → ingest-frame (the send-side glue) ──────────────────────────────────
describe("TelephonyBridgeCore inbound: μ-law → 48k-stereo PCM → encodeIngestFrame on the SFU socket", () => {
  it("emits the EXACT packet-framed ingest wire bytes for a media frame", async () => {
    const { sent, sock } = makeIngestSocket();
    const { deps } = makeDeps({ ingestSocket: () => sock });
    const core = new TelephonyBridgeCore(deps, { target: TARGET });
    const muLaw = new Uint8Array([0xff, 0x7f, 0x00, 0x80, 0x2a, 0xd5]); // arbitrary 6 μ-law bytes
    await core.onTwilioFrame(startFrame("STREAM1"));
    await core.onTwilioFrame(mediaFrame("STREAM1", muLaw));

    const bytes = int16ToPcmS16Le(twilioMuLawToSfuPcm(muLaw));
    const expected = chunkPcm(bytes).map((chunk, i) => encodeIngestFrame(chunk, { sequenceNumber: i, timestamp: 0 }, "packet"));
    expect(sent.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(Array.from(sent[i]!)).toEqual(Array.from(expected[i]!));
  });

  it("respects a 'raw' framing override at the inject seam", async () => {
    const { sent, sock } = makeIngestSocket();
    const { deps } = makeDeps({ ingestSocket: () => sock });
    const core = new TelephonyBridgeCore(deps, { target: TARGET, framing: "raw" });
    const muLaw = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
    await core.onTwilioFrame(mediaFrame("STREAM1", muLaw));
    const bytes = int16ToPcmS16Le(twilioMuLawToSfuPcm(muLaw));
    const expected = chunkPcm(bytes).map((chunk, i) => encodeIngestFrame(chunk, { sequenceNumber: i, timestamp: 0 }, "raw"));
    for (let i = 0; i < expected.length; i++) expect(Array.from(sent[i]!)).toEqual(Array.from(expected[i]!));
  });

  it("DROPS media (no throw, no send) when the SFU ingest socket is not connected yet", async () => {
    const { deps, logs } = makeDeps({ ingestSocket: () => null });
    const core = new TelephonyBridgeCore(deps, { target: null });
    await core.onTwilioFrame(startFrame("STREAM1"));
    await core.onTwilioFrame(mediaFrame("STREAM1", new Uint8Array([1, 2, 3])));
    expect(logs.some((l) => l.msg === "telephony-target-pending")).toBe(true);
    // no ingest socket → nothing sent, and no error thrown
  });
});

// ── start / createIngest ─────────────────────────────────────────────────────────────────────────
describe("TelephonyBridgeCore start", () => {
  it("creates a location:'local' ingest adapter when a target is resolved (idempotent)", async () => {
    const tracks: unknown[] = [];
    const d = makeDeps({ createIngest: async (t) => { tracks.push(...t); return { raw: {} }; } });
    const core = new TelephonyBridgeCore(d.deps, { target: TARGET });
    await core.onTwilioFrame(startFrame("STREAM1"));
    await core.onTwilioFrame(startFrame("STREAM1")); // second start → no-op
    expect(tracks.length).toBe(1);
    expect(tracks[0]).toMatchObject({ location: "local", sessionId: TARGET.sessionId, trackName: TARGET.trackName, inputCodec: "pcm", mode: "buffer" });
    expect(core.currentStreamSid).toBe("STREAM1");
  });

  it("does NOT create an adapter when the target is pending (INERT)", async () => {
    const d = makeDeps();
    let calls = 0;
    const core = new TelephonyBridgeCore({ ...d.deps, createIngest: async () => { calls++; return { raw: {} }; } }, { target: null });
    await core.onTwilioFrame(startFrame("STREAM1"));
    expect(calls).toBe(0);
  });
});

// ── OUTBOUND: room PCM → μ-law → twilioMediaFrame ─────────────────────────────────────────────────
describe("TelephonyBridgeCore outbound: room 48k-stereo PCM → μ-law → Twilio media frame", () => {
  it("sends the EXACT twilioMediaFrame for room audio after start", async () => {
    const d = makeDeps();
    const core = new TelephonyBridgeCore(d.deps, { target: TARGET });
    await core.onTwilioFrame(startFrame("STREAM1"));
    const pcm = new Int16Array([100, -100, 200, -200, 300, -300, 0, 0, 500, -500, 12, -12]); // 12 samples = 6 stereo pairs
    core.pushRoomAudio(pcm);
    expect(d.twilioSent.length).toBe(1);
    expect(d.twilioSent[0]).toBe(twilioMediaFrame("STREAM1", sfuPcmToTwilioMuLaw(pcm)));
  });

  it("is a no-op before start (no streamSid to address)", () => {
    const d = makeDeps();
    const core = new TelephonyBridgeCore(d.deps, { target: TARGET });
    core.pushRoomAudio(new Int16Array([1, 2, 3, 4]));
    expect(d.twilioSent.length).toBe(0);
  });
});

// ── parse-error + stop safety ─────────────────────────────────────────────────────────────────────
describe("TelephonyBridgeCore protocol safety", () => {
  it("swallows a malformed frame (logs, never throws)", async () => {
    const d = makeDeps();
    const core = new TelephonyBridgeCore(d.deps, { target: null });
    await expect(core.onTwilioFrame("{not json")).resolves.toBeUndefined();
    expect(d.logs.some((l) => l.msg === "telephony-parse-error")).toBe(true);
  });

  it("closes on a stop frame", async () => {
    const d = makeDeps();
    const core = new TelephonyBridgeCore(d.deps, { target: TARGET });
    await core.onTwilioFrame(startFrame("STREAM1"));
    await core.onTwilioFrame(JSON.stringify({ event: "stop", streamSid: "STREAM1", stop: {} }));
    expect(d.logs.some((l) => l.msg === "telephony-close")).toBe(true);
  });
});

// ── flag gate + route guards ───────────────────────────────────────────────────────────────────────
describe("telephonyStreamEnabled", () => {
  it("is off by default and for falsy values", () => {
    expect(telephonyStreamEnabled({} as Env)).toBe(false);
    expect(telephonyStreamEnabled({ WAVE_TELEPHONY_STREAM: "0" } as Env)).toBe(false);
    expect(telephonyStreamEnabled({ WAVE_TELEPHONY_STREAM: "false" } as Env)).toBe(false);
  });
  it("arms for truthy values", () => {
    expect(telephonyStreamEnabled({ WAVE_TELEPHONY_STREAM: "1" } as Env)).toBe(true);
    expect(telephonyStreamEnabled({ WAVE_TELEPHONY_STREAM: true } as Env)).toBe(true);
    expect(telephonyStreamEnabled({ WAVE_TELEPHONY_STREAM: "true" } as Env)).toBe(true);
  });
});

describe("maybeHandleTelephonyStream route guards (INERT off; guarded on)", () => {
  const req = (init: { path?: string; upgrade?: boolean } = {}) =>
    new Request(`https://rt.wave.online${init.path ?? "/?room=demo"}`, init.upgrade ? { headers: { Upgrade: "websocket" } } : undefined);

  it("returns null when the flag is off (falls through to the 501 catch-all)", async () => {
    expect(await maybeHandleTelephonyStream(req({ upgrade: true }), {} as Env, undefined)).toBeNull();
  });

  it("returns null for a non-root path even when armed", async () => {
    const env = { WAVE_TELEPHONY_STREAM: "1" } as Env;
    expect(await maybeHandleTelephonyStream(req({ path: "/health", upgrade: true }), env, undefined)).toBeNull();
  });

  it("returns null when there is no ?room (not a telephony stream)", async () => {
    const env = { WAVE_TELEPHONY_STREAM: "1" } as Env;
    expect(await maybeHandleTelephonyStream(req({ path: "/" }), env, undefined)).toBeNull();
  });

  it("400s an invalid room", async () => {
    const env = { WAVE_TELEPHONY_STREAM: "1" } as Env;
    const res = await maybeHandleTelephonyStream(req({ path: "/?room=bad%2Froom", upgrade: true }), env, undefined);
    expect(res?.status).toBe(400);
  });

  it("426s a non-WebSocket request on the armed route", async () => {
    const env = { WAVE_TELEPHONY_STREAM: "1" } as Env;
    const res = await maybeHandleTelephonyStream(req({ path: "/?room=demo" }), env, undefined);
    expect(res?.status).toBe(426);
  });
});
