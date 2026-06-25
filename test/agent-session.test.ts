// Task #81 — AgentSessionCore + the flag gate + the PCM echo round-trip. Proves: voiceAgentEnabled gate;
// bind validation + idempotency + conflicting-rebind rejection; openAdapters creates BOTH adapters (the
// two-adapters-on-one-DO proof) with the right endpoints; the echo harness decodes egress PCM and re-sends
// it on the ingest socket (round-trip via the real decode/encode, not a faked protocol); timing samples are
// recorded for both directions; fail-safe on a bad frame. The adapter WS is MOCKED (no live SFU).
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  AgentSessionCore,
  AgentSessionDO,
  voiceAgentEnabled,
  type AgentMediaDeps,
  type IngestSocket,
} from "../src/agent-session.js";
import { encodeIngestFrame } from "../src/agent-ingest-adapter.js";
import { decodePacket } from "../src/encoders/container-adapter.js";

const SESSION = "sess_ABCdef12345678";

function mkDeps(over: Partial<AgentMediaDeps> = {}) {
  const sent: Uint8Array[] = [];
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  let t = 1000;
  const sock: IngestSocket = { send: (d) => sent.push(new Uint8Array(d as ArrayBuffer)), close: () => {} };
  const deps: AgentMediaDeps = {
    createEgress: vi.fn(async (tracks) => ({ adapterId: "eg_1", raw: { tracks } })),
    createIngest: vi.fn(async (tracks) => ({ adapterId: "in_1", raw: { tracks } })),
    ingestSocket: () => sock,
    now: () => t++,
    log: (msg, fields) => logs.push({ msg, fields }),
    ...over,
  };
  return { deps, sent, logs };
}

const goodCfg = {
  roomId: "room1", org: "org1", agentId: "a1",
  participantSessionId: SESSION, participantTrackName: "mic",
};

describe("voiceAgentEnabled gate", () => {
  it("true ONLY for VOICE_AGENT_PROVIDER=wave", () => {
    expect(voiceAgentEnabled({ VOICE_AGENT_PROVIDER: "wave" })).toBe(true);
    expect(voiceAgentEnabled({ VOICE_AGENT_PROVIDER: "livekit" })).toBe(false);
    expect(voiceAgentEnabled({})).toBe(false);
  });
});

describe("AgentSessionCore.bind", () => {
  it("binds, defaults agentTrackName, is idempotent for the same config", () => {
    const { deps } = mkDeps();
    const core = new AgentSessionCore(deps);
    const b = core.bind(goodCfg);
    expect(b.agentTrackName).toBe("agent-a1");
    expect(core.bind(goodCfg)).toMatchObject({ roomId: "room1" });
  });
  it("rejects bad config and a conflicting rebind", () => {
    const { deps } = mkDeps();
    const core = new AgentSessionCore(deps);
    expect(() => core.bind({ ...goodCfg, org: "bad org!" })).toThrow();
    expect(() => core.bind({ ...goodCfg, participantSessionId: "x" })).toThrow();
    core.bind(goodCfg);
    expect(() => core.bind({ ...goodCfg, roomId: "other" })).toThrow(/different room/);
  });
});

describe("AgentSessionCore.openAdapters — two adapters on one DO", () => {
  it("creates BOTH egress + ingest with correct endpoints", async () => {
    const { deps } = mkDeps();
    const core = new AgentSessionCore(deps);
    core.bind(goodCfg);
    const { egress, ingest } = await core.openAdapters({ baseWss: "wss://rt.wave.online", egressToken: "tok" });
    expect(egress.adapterId).toBe("eg_1");
    expect(ingest.adapterId).toBe("in_1");
    const egTracks = (deps.createEgress as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const inTracks = (deps.createIngest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(egTracks[0].endpoint).toContain("/v1/realtime/agents/egress/org1/room1/");
    expect(egTracks[0].endpoint).toContain("?t=tok");
    expect(egTracks[0].outputCodec).toBe("pcm");
    expect(inTracks[0].endpoint).toContain("/v1/realtime/agents/ingest/org1/room1/");
    expect(inTracks[0].location).toBe("local");
  });
  it("requires bind first and a wss base", async () => {
    const { deps } = mkDeps();
    const core = new AgentSessionCore(deps);
    await expect(core.openAdapters({ baseWss: "wss://x" })).rejects.toMatchObject({ code: "NOT_BOUND" });
    core.bind(goodCfg);
    await expect(core.openAdapters({ baseWss: "http://x" })).rejects.toMatchObject({ code: "BAD_ENDPOINT" });
  });
});

describe("echo harness PCM round-trip", () => {
  it("decodes an egress Packet and re-sends the SAME PCM on the ingest socket", async () => {
    const { deps, sent } = mkDeps();
    const core = new AgentSessionCore(deps); // default framing "packet"
    core.bind(goodCfg);
    const pcm = new Uint8Array([10, 20, 30, 40]);
    // An inbound egress frame is a Packet (same wire the SFU pushes) — build it with the verified encoder.
    const inbound = encodeIngestFrame(pcm, { sequenceNumber: 7, timestamp: 4800 }, "packet");
    await core.echoFrame(inbound);
    expect(sent.length).toBe(1);
    // The sent frame is itself a Packet carrying the same PCM (decode it back).
    const decoded = (await import("../src/encoders/container-adapter.js")).decodePacket(sent[0]);
    expect(Array.from(decoded.payload)).toEqual([10, 20, 30, 40]);
    const samples = core.timingSamples();
    expect(samples.map((s) => s.direction)).toEqual(["in", "out"]);
    expect(samples[0].sequenceNumber).toBe(7);
  });
  it("drops empty/keep-alive frames and is fail-safe on garbage", async () => {
    const { deps, sent, logs } = mkDeps();
    const core = new AgentSessionCore(deps);
    core.bind(goodCfg);
    await core.echoFrame(encodeIngestFrame(new Uint8Array(0), { sequenceNumber: 1, timestamp: 1 }));
    expect(sent.length).toBe(0); // empty payload → no send
    await core.echoFrame(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])); // bad varint
    expect(logs.some((l) => l.msg === "agent-echo-error")).toBe(true); // logged, never thrown
  });
  it("does not send when the ingest socket is not connected yet", async () => {
    const { deps } = mkDeps({ ingestSocket: () => null });
    const core = new AgentSessionCore(deps);
    core.bind(goodCfg);
    await core.echoFrame(encodeIngestFrame(new Uint8Array([1, 2]), { sequenceNumber: 1, timestamp: 1 }));
    expect(core.timingSamples().map((s) => s.direction)).toEqual(["in"]); // recorded in, no out
  });
});

describe("AgentSessionDO ingest WS wiring — the DO owns the publish socket", () => {
  let serverWS: { sent: Uint8Array[] };
  class FakeWS {
    binaryType = "blob";
    sent: Uint8Array[] = [];
    accept() {}
    addEventListener() {}
    send(d: ArrayBufferView | ArrayBuffer) { this.sent.push(new Uint8Array(d as ArrayBuffer)); }
    close() {}
  }
  beforeAll(() => {
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
      0 = new FakeWS();
      1 = (serverWS = new FakeWS());
    } as unknown;
  });

  const mkState = () => ({ storage: { get: async () => undefined, put: async () => {} } }) as never;

  it("installs the ingest socket on upgrade, then echo frames publish on it (egress→ingest closes the loop)", async () => {
    const session = new AgentSessionDO(mkState(), { VOICE_AGENT_PROVIDER: "wave" } as never);
    // 1) The SFU dials the ingest WS → DO performs the upgrade and holds the server socket as this.ingest.
    const up = await session.fetch(new Request("https://agent/ingest", { headers: { Upgrade: "websocket" } }));
    expect(up.status).toBeLessThan(400);
    // 2) An egress frame arrives (NOT bound → turn core is null → the echo harness runs) → the SAME PCM is
    //    published back out the installed ingest socket. Before this route, this.ingest was always null and
    //    every outbound frame was dropped at AgentSessionCore.echoFrame's `if (!sock) return`.
    const pcm = new Uint8Array([5, 6, 7, 8]);
    const frame = encodeIngestFrame(pcm, { sequenceNumber: 3, timestamp: 9600 }, "packet");
    await session.fetch(new Request("https://agent/echo-frame", { method: "POST", body: frame }));
    expect(serverWS.sent.length).toBe(1);
    expect(Array.from(decodePacket(serverWS.sent[0]).payload)).toEqual([5, 6, 7, 8]);
  });

  it("returns 503 when WebSocketPair is unavailable (config-no-silent-noop)", async () => {
    const saved = (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair;
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = undefined;
    const session = new AgentSessionDO(mkState(), { VOICE_AGENT_PROVIDER: "wave" } as never);
    const res = await session.fetch(new Request("https://agent/ingest", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(503);
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = saved;
  });

  it("ingest upgrade is inert (501) without VOICE_AGENT_PROVIDER=wave", async () => {
    const session = new AgentSessionDO(mkState(), {} as never);
    const res = await session.fetch(new Request("https://agent/ingest", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(501);
  });
});
