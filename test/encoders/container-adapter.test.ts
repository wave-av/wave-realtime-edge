// RT-R8 — unit tests for adapter A primitives (WS media-transport client + Packet decoder + RawSfuTap).
// Synthetic Packets + injected fetch + in-memory R2 multipart fakes — NO live network, NO live media. Proves:
//   • createWebsocketAdapter posts the verified contract (URL/method/Bearer/body) and fails closed on bad input;
//   • decodePacket round-trips seq/ts/payload, is order- + unknown-field-robust, and rejects truncation;
//   • RawSfuTap drives PCM → Matroska (A_PCM) → ONE canonical SKIP object, idempotent, no-media → no object,
//     and NEVER touches a dedup path (get/put/delete spied) — the load-bearing SKIP invariant.
import { describe, it, expect } from "vitest";
import {
  createWebsocketAdapter,
  decodePacket,
  RawSfuTap,
  PassthroughPcmEncoder,
  SfuAdapterError,
  DEFAULT_SFU_API_BASE,
  type WsAdapterTrack,
} from "../../src/encoders/container-adapter.js";
import { sniffWebm } from "../../src/recording-writer.js";

const APP_ID = "a".repeat(32); // 32-hex passes APPID guard
const SESSION = "sess_ABC12345";
const ENDPOINT = "wss://rt.wave.online/v1/realtime/recorder/sess_ABC12345";

const track = (over: Partial<WsAdapterTrack> = {}): WsAdapterTrack => ({
  location: "remote",
  sessionId: SESSION,
  trackName: "mic",
  endpoint: ENDPOINT,
  outputCodec: "pcm",
  ...over,
});

// ── proto3 Packet wire helpers (mirror the on-wire encoding the SFU emits) ──────────────────────────────
function encodeVarint(v: number): number[] {
  const out: number[] = [];
  let x = v;
  do {
    let b = x & 0x7f;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    out.push(b);
  } while (x > 0);
  return out;
}
/** One Packet: field1(seq,varint) field2(ts,varint) field5(payload,len-delim). */
function packet(seq: number, ts: number, payload: number[]): Uint8Array {
  return Uint8Array.from([
    0x08, ...encodeVarint(seq),
    0x10, ...encodeVarint(ts),
    0x2a, ...encodeVarint(payload.length), ...payload,
  ]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ── in-memory R2 multipart fakes (dedup-path spies; a SKIP writer must never call get/put/delete) ───────
class FakeUpload {
  parts: Uint8Array[] = [];
  completed: unknown = null;
  aborted = false;
  constructor(public key: string, public uploadId: string) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push(data);
    return { partNumber, etag: `etag-${partNumber}` };
  }
  async complete(parts: unknown) {
    this.completed = parts;
    return {} as R2Object;
  }
  async abort() {
    this.aborted = true;
  }
}
class FakeBucket {
  created: FakeUpload[] = [];
  getCalls = 0;
  putCalls = 0;
  deleteCalls = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${this.created.length + 1}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return new FakeUpload(key, uploadId) as unknown as R2MultipartUpload;
  }
  async get() {
    this.getCalls += 1;
    return null;
  }
  async put() {
    this.putCalls += 1;
    return {} as R2Object;
  }
  async delete() {
    this.deleteCalls += 1;
  }
  async head() {
    return null;
  }
  /** Concatenate every uploaded part of the single created upload → the canonical object bytes. */
  objectBytes(): Uint8Array {
    const u = this.created[0];
    const parts = u ? u.parts : [];
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

function indexOfSeq(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ── 1. createWebsocketAdapter ───────────────────────────────────────────────────────────────────────────
describe("createWebsocketAdapter — verified create-adapter REST", () => {
  it("POSTs the contract URL/method/Bearer/body and returns the adapter id", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ adapterId: "adp_1" });
    };
    const r = await createWebsocketAdapter({ fetchImpl }, { appId: APP_ID, bearer: "tok", tracks: [track()] });
    expect(r.adapterId).toBe("adp_1");
    expect(seen.url).toBe(`${DEFAULT_SFU_API_BASE}/apps/${APP_ID}/adapters/websocket/new`);
    expect(seen.init?.method).toBe("POST");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(seen.init?.body));
    expect(body.tracks[0]).toMatchObject({ location: "remote", outputCodec: "pcm", endpoint: ENDPOINT });
  });

  it("honors a custom sfuApiBase (staging) and strips a trailing slash", async () => {
    let url = "";
    const fetchImpl = async (u: string) => {
      url = u;
      return jsonResponse({ id: 9 }); // id (not adapterId) is also accepted
    };
    const r = await createWebsocketAdapter(
      { fetchImpl },
      { appId: APP_ID, bearer: "t", tracks: [track()], sfuApiBase: "https://stg.example/v1/" },
    );
    expect(url).toBe(`https://stg.example/v1/apps/${APP_ID}/adapters/websocket/new`);
    expect(r.adapterId).toBe("9");
  });

  it("throws UPSTREAM on a non-2xx (never leaks the body)", async () => {
    const fetchImpl = async () => jsonResponse({ error: "nope" }, 503);
    await expect(
      createWebsocketAdapter({ fetchImpl }, { appId: APP_ID, bearer: "t", tracks: [track()] }),
    ).rejects.toMatchObject({ code: "UPSTREAM", status: 502 });
  });

  it("fails closed on bad app id / missing bearer / non-wss endpoint / bad session / no tracks", async () => {
    const fetchImpl = async () => jsonResponse({});
    await expect(createWebsocketAdapter({ fetchImpl }, { appId: "short", bearer: "t", tracks: [track()] }))
      .rejects.toMatchObject({ code: "BAD_APP_ID" });
    await expect(createWebsocketAdapter({ fetchImpl }, { appId: APP_ID, bearer: "", tracks: [track()] }))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(
      createWebsocketAdapter({ fetchImpl }, { appId: APP_ID, bearer: "t", tracks: [track({ endpoint: "https://evil/x" })] }),
    ).rejects.toMatchObject({ code: "BAD_ENDPOINT" });
    await expect(
      createWebsocketAdapter({ fetchImpl }, { appId: APP_ID, bearer: "t", tracks: [track({ sessionId: "x" })] }),
    ).rejects.toMatchObject({ code: "BAD_SESSION" });
    await expect(createWebsocketAdapter({ fetchImpl }, { appId: APP_ID, bearer: "t", tracks: [] }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ── 1b. createWebsocketAdapter — publish-race retry (not_found_track_error) ─────────────────────────────
describe("createWebsocketAdapter — retries the create-time publish race", () => {
  // The SFU's "track not on remote peer yet" response (publisher media not flowing at create time).
  const notReady = () =>
    jsonResponse(
      { tracks: [{ errorCode: "not_found_track_error", errorDescription: "Track not found on remote peer. Make sure the publisher peer is connected and sending packets" }] },
      503,
    );

  it("retries on not_found_track_error, then succeeds once the track starts sending", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls < 3 ? notReady() : jsonResponse({ adapterId: "adp_ok" });
    };
    const r = await createWebsocketAdapter(
      { fetchImpl, retry: { maxAttempts: 6, delayMs: () => 7, sleep: async (ms) => void sleeps.push(ms) } },
      { appId: APP_ID, bearer: "t", tracks: [track()] },
    );
    expect(r.adapterId).toBe("adp_ok");
    expect(calls).toBe(3); // failed twice, then succeeded
    expect(sleeps).toEqual([7, 7]); // slept before attempts 2 and 3
  });

  it("gives up with UPSTREAM after the attempt budget if the track never sends", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return notReady();
    };
    await expect(
      createWebsocketAdapter(
        { fetchImpl, retry: { maxAttempts: 4, delayMs: () => 1, sleep: async (ms) => void sleeps.push(ms) } },
        { appId: APP_ID, bearer: "t", tracks: [track()] },
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM", status: 502 });
    expect(calls).toBe(4); // first + 3 retries
    expect(sleeps).toHaveLength(3); // slept between the 4 attempts, not after the last
  });

  it("does NOT retry a non-race failure (other 503) even with a retry budget", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ error: "boom" }, 503);
    };
    await expect(
      createWebsocketAdapter(
        { fetchImpl, retry: { maxAttempts: 5, delayMs: () => 0, sleep: async () => {} } },
        { appId: APP_ID, bearer: "t", tracks: [track()] },
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM" });
    expect(calls).toBe(1); // terminal on the first non-race error
  });

  it("succeeds on the first try without sleeping when the track is already live", async () => {
    const sleeps: number[] = [];
    const fetchImpl = async () => jsonResponse({ adapterId: "adp_1" });
    const r = await createWebsocketAdapter(
      { fetchImpl, retry: { maxAttempts: 6, delayMs: () => 9, sleep: async (ms) => void sleeps.push(ms) } },
      { appId: APP_ID, bearer: "t", tracks: [track()] },
    );
    expect(r.adapterId).toBe("adp_1");
    expect(sleeps).toHaveLength(0);
  });
});

// ── 2. decodePacket ─────────────────────────────────────────────────────────────────────────────────────
describe("decodePacket — proto3 Packet wire decoder", () => {
  it("round-trips sequenceNumber, timestamp, and payload", () => {
    const p = decodePacket(packet(7, 1234, [1, 2, 3, 4]));
    expect(p.sequenceNumber).toBe(7);
    expect(p.timestamp).toBe(1234);
    expect(Array.from(p.payload)).toEqual([1, 2, 3, 4]);
  });

  it("decodes large (multi-byte varint) timestamps without 32-bit overflow", () => {
    const big = 5_000_000_000; // > 2^32
    const p = decodePacket(packet(1, big, [9]));
    expect(p.timestamp).toBe(big);
  });

  it("is field-order independent and skips unknown fields", () => {
    // payload(field5) first, then an unknown field3 varint, then ts(field2), then seq(field1).
    const frame = Uint8Array.from([
      0x2a, 0x02, 0xaa, 0xbb, // field5 len=2
      0x18, 0x05, // field3 varint=5 (unknown → skipped)
      0x10, 0x09, // field2 ts=9
      0x08, 0x03, // field1 seq=3
    ]);
    const p = decodePacket(frame);
    expect(p.sequenceNumber).toBe(3);
    expect(p.timestamp).toBe(9);
    expect(Array.from(p.payload)).toEqual([0xaa, 0xbb]);
  });

  it("an empty frame decodes to zero-length payload (keep-alive)", () => {
    const p = decodePacket(new Uint8Array(0));
    expect(p.payload.length).toBe(0);
  });

  it("throws BAD_PACKET on a truncated length-delimited field", () => {
    // field5 claims len=5 but only 2 bytes follow.
    expect(() => decodePacket(Uint8Array.from([0x2a, 0x05, 0x01, 0x02]))).toThrow(SfuAdapterError);
  });
});

// ── 3. RawSfuTap ────────────────────────────────────────────────────────────────────────────────────────
describe("RawSfuTap — PCM Packets → one canonical SKIP object", () => {
  const target = (bucket: FakeBucket) => ({ bucket: bucket as unknown as R2Bucket, org: "org_x", sessionId: SESSION });

  it("writes ONE object whose bytes are valid Matroska (EBML magic + A_PCM codec)", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket) });
    for (let i = 0; i < 5; i++) await tap.onFrame(packet(i, i * 20, [0x10, 0x20, 0x30, 0x40]));
    const result = await tap.finalize();

    expect(bucket.created).toHaveLength(1);
    expect(result).not.toBeNull();
    expect(result!.key).toBe(`org_x/realtime-recordings/${SESSION}/recording.webm`);
    const bytes = bucket.objectBytes();
    expect(sniffWebm(bytes)).toBe("webm"); // shared EBML magic → .webm extension
    expect(indexOfSeq(bytes, [0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61])).toBeGreaterThan(0); // "matroska"
    expect(indexOfSeq(bytes, Array.from(new TextEncoder().encode("A_PCM/INT/LIT")))).toBeGreaterThan(0);
  });

  it("NEVER touches a dedup path (SKIP invariant: no get/put/delete)", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket) });
    await tap.onFrame(packet(0, 0, [1, 2, 3]));
    await tap.finalize();
    expect(bucket.getCalls).toBe(0);
    expect(bucket.putCalls).toBe(0);
    expect(bucket.deleteCalls).toBe(0);
  });

  it("a track with no media uploads NOTHING (no 0-byte object) and finalize → null", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket) });
    await tap.onFrame(packet(0, 0, [])); // keep-alive only
    const result = await tap.finalize();
    expect(result).toBeNull();
    expect(bucket.created).toHaveLength(0);
  });

  it("finalize is idempotent (one complete, same result)", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket) });
    await tap.onFrame(packet(0, 0, [7, 7, 7]));
    const a = await tap.finalize();
    const b = await tap.finalize();
    expect(a).toEqual(b);
    expect(bucket.created).toHaveLength(1);
  });

  it("applies tsToMs and exposes the key once the recorder begins (lazy, on first flush)", async () => {
    const bucket = new FakeBucket();
    // flushBytes:1 forces a flush on the first frame → the recorder begins eagerly so we can read its key.
    const tap = new RawSfuTap({ target: target(bucket), tsToMs: (t) => t / 48, flushBytes: 1 });
    expect(tap.key).toBeNull(); // lazy: no object until the first flush
    await tap.onFrame(packet(0, 0, [1]));
    await tap.onFrame(packet(1, 48000, [2])); // 1s later expressed in 48kHz samples → tsToMs → 1000ms
    expect(tap.key).toBe(`org_x/realtime-recordings/${SESSION}/recording.webm`);
    await tap.finalize();
    expect(bucket.created).toHaveLength(1);
  });

  it("the default encoder is the no-WASM PCM passthrough", () => {
    expect(new PassthroughPcmEncoder().codec).toBe("pcm");
    expect(Array.from(new PassthroughPcmEncoder().encode(Uint8Array.from([5, 6])))).toEqual([5, 6]);
  });
});
