// Task #81 — voice-agent INGEST adapter primitives. Proves: create-ingest REST shape (location:"local",
// inputCodec, wss guard, app-id/session guards, bearer-required, upstream error mapping); the send-side
// Packet framing is symmetric with the VERIFIED egress decodePacket (round-trips); "raw" framing is verbatim;
// the 32KB ceiling is enforced; chunkPcm splits to the ceiling. Models the contract — does NOT fake the wire.
import { describe, it, expect } from "vitest";
import {
  createIngestAdapter,
  encodeIngestFrame,
  chunkPcm,
  MAX_PCM_MESSAGE_BYTES,
} from "../src/agent-ingest-adapter.js";
import { decodePacket, SfuAdapterError } from "../src/encoders/container-adapter.js";

const APP = "0123456789abcdef0123456789abcdef";
const SESSION = "sess_ABCdef12345678";

function jsonFetch(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createIngestAdapter", () => {
  it("POSTs the local/inputCodec track and returns the adapter id", async () => {
    let seen: { url?: string; body?: unknown } = {};
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ adapterId: "ad_1" }), { status: 200 });
    };
    const r = await createIngestAdapter({ fetchImpl }, {
      appId: APP, bearer: "b",
      tracks: [{ location: "local", sessionId: SESSION, trackName: "agent-a", endpoint: "wss://rt.wave.online/x", inputCodec: "pcm" }],
    });
    expect(r.adapterId).toBe("ad_1");
    expect(seen.url).toContain(`/apps/${APP}/adapters/websocket/new`);
    expect((seen.body as { tracks: { location: string; inputCodec: string }[] }).tracks[0]).toMatchObject({ location: "local", inputCodec: "pcm" });
  });

  it("rejects a bad app id, missing bearer, non-wss endpoint, bad session, empty tracks", async () => {
    const f = jsonFetch(200, {});
    await expect(createIngestAdapter({ fetchImpl: f }, { appId: "nope", bearer: "b", tracks: [{ location: "local", sessionId: SESSION, trackName: "t", endpoint: "wss://x/y", inputCodec: "pcm" }] })).rejects.toMatchObject({ code: "BAD_APP_ID" });
    await expect(createIngestAdapter({ fetchImpl: f }, { appId: APP, bearer: "", tracks: [{ location: "local", sessionId: SESSION, trackName: "t", endpoint: "wss://x/y", inputCodec: "pcm" }] })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(createIngestAdapter({ fetchImpl: f }, { appId: APP, bearer: "b", tracks: [{ location: "local", sessionId: SESSION, trackName: "t", endpoint: "http://x/y", inputCodec: "pcm" }] })).rejects.toMatchObject({ code: "BAD_ENDPOINT" });
    await expect(createIngestAdapter({ fetchImpl: f }, { appId: APP, bearer: "b", tracks: [{ location: "local", sessionId: "!", trackName: "t", endpoint: "wss://x/y", inputCodec: "pcm" }] })).rejects.toMatchObject({ code: "BAD_SESSION" });
    await expect(createIngestAdapter({ fetchImpl: f }, { appId: APP, bearer: "b", tracks: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps an upstream non-2xx to SfuAdapterError UPSTREAM", async () => {
    await expect(createIngestAdapter({ fetchImpl: jsonFetch(500, { err: 1 }) }, {
      appId: APP, bearer: "b",
      tracks: [{ location: "local", sessionId: SESSION, trackName: "t", endpoint: "wss://x/y", inputCodec: "pcm" }],
    })).rejects.toMatchObject({ code: "UPSTREAM" });
  });
});

describe("encodeIngestFrame round-trips against the VERIFIED egress decoder", () => {
  it('framing "packet" produces a Packet that decodePacket reads back identically', () => {
    const pcm = new Uint8Array([1, 2, 3, 0, 255, 128, 64, 7]);
    const wire = encodeIngestFrame(pcm, { sequenceNumber: 42, timestamp: 9000 }, "packet");
    const back = decodePacket(wire);
    expect(back.sequenceNumber).toBe(42);
    expect(back.timestamp).toBe(9000);
    expect(Array.from(back.payload)).toEqual(Array.from(pcm));
  });

  it("encodes large seq/ts (>2^31) without 32-bit corruption", () => {
    const pcm = new Uint8Array([9]);
    const wire = encodeIngestFrame(pcm, { sequenceNumber: 5_000_000_000, timestamp: 4_000_000_000 }, "packet");
    const back = decodePacket(wire);
    expect(back.sequenceNumber).toBe(5_000_000_000);
    expect(back.timestamp).toBe(4_000_000_000);
  });

  it('framing "raw" sends the PCM verbatim', () => {
    const pcm = new Uint8Array([5, 6, 7]);
    expect(Array.from(encodeIngestFrame(pcm, { sequenceNumber: 1, timestamp: 1 }, "raw"))).toEqual([5, 6, 7]);
  });

  it("enforces the 32KB per-message ceiling", () => {
    const tooBig = new Uint8Array(MAX_PCM_MESSAGE_BYTES + 1);
    expect(() => encodeIngestFrame(tooBig, { sequenceNumber: 1, timestamp: 1 })).toThrow(SfuAdapterError);
  });
});

describe("chunkPcm", () => {
  it("splits to the ceiling and returns [] for empty", () => {
    expect(chunkPcm(new Uint8Array(0))).toEqual([]);
    const big = new Uint8Array(MAX_PCM_MESSAGE_BYTES * 2 + 10);
    const chunks = chunkPcm(big);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(MAX_PCM_MESSAGE_BYTES);
    expect(chunks[2].length).toBe(10);
  });
});
