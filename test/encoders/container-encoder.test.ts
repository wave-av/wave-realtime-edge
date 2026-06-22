// RT-R8/RT-R9 P1 — ContainerEncoder (adapter A) audio-first INERT impl. Fake fetch + fake R2; no live network.
// Proves: gating (containerRecordingConfigured), begin never throws (null when unconfigured), onPublish('audio')
// → a tap + a create-adapter POST to the right wss endpoint, onPublish('video') → no-op, finalize/abort
// fail-open, toMeta → null, and a synthetic Packet flowing through a tap yields ONE canonical EBML object.
import { describe, it, expect, vi } from "vitest";
import {
  ContainerEncoder,
  ContainerHandle,
  containerRecordingConfigured,
  DEFAULT_RECORDER_ENDPOINT_BASE,
} from "../../src/encoders/container.js";
import type { EncoderEnv } from "../../src/encoders/encoder.js";
import { sniffWebm } from "../../src/recording-writer.js";

const APP_ID = "a".repeat(32);
const SESSION = { org: "org_x", room: "r1", sessionId: "sess_ABC12345" };

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
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${this.created.length + 1}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return new FakeUpload(key, uploadId) as unknown as R2MultipartUpload;
  }
  async get() {
    return null;
  }
  async head() {
    return null;
  }
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
function packet(seq: number, ts: number, payload: number[]): Uint8Array {
  return Uint8Array.from([0x08, ...encodeVarint(seq), 0x10, ...encodeVarint(ts), 0x2a, ...encodeVarint(payload.length), ...payload]);
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function configuredEnv(bucket: FakeBucket): EncoderEnv {
  return {
    RT_RECORD: "1",
    RT_ENCODER: "container",
    RT_RECORDINGS: bucket as unknown as R2Bucket,
    CF_CALLS_APP_ID: APP_ID,
    CF_CALLS_APP_SECRET: "sfu-secret",
  };
}

describe("containerRecordingConfigured — gates on armed + bucket + app creds", () => {
  it("false when disarmed / no bucket / no app / bad app id", () => {
    const b = new FakeBucket() as unknown as R2Bucket;
    expect(containerRecordingConfigured({})).toBe(false);
    expect(containerRecordingConfigured({ RT_RECORD: "1" })).toBe(false);
    expect(containerRecordingConfigured({ RT_RECORD: "1", RT_RECORDINGS: b })).toBe(false);
    expect(containerRecordingConfigured({ RT_RECORD: "1", RT_RECORDINGS: b, CF_CALLS_APP_ID: "short", CF_CALLS_APP_SECRET: "s" })).toBe(false);
  });
  it("true when armed + bucket + 32-hex app id + secret", () => {
    expect(containerRecordingConfigured(configuredEnv(new FakeBucket()))).toBe(true);
  });
});

describe("ContainerEncoder.begin — fail-open, never throws", () => {
  it("unconfigured → null + a loud warn (no throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const enc = new ContainerEncoder({ RT_RECORD: "1", RT_ENCODER: "container" });
    await expect(enc.begin(SESSION)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("configured → a ContainerHandle with the org-rooted keyPrefix", async () => {
    const enc = new ContainerEncoder(configuredEnv(new FakeBucket()), { fetchImpl: async () => jsonResponse({ adapterId: "a" }) });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    expect(handle).toBeInstanceOf(ContainerHandle);
    expect(handle.keyPrefix).toBe(`org_x/realtime-recordings/${SESSION.sessionId}/`);
    expect(handle.toMeta()).toBeNull();
  });
});

describe("ContainerHandle.onPublish — audio opens a tap + posts the create-adapter contract", () => {
  it("onPublish('audio') → create-adapter POST to OUR recorder wss endpoint", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ adapterId: "adp_1" });
    };
    const bucket = new FakeBucket();
    const enc = new ContainerEncoder(configuredEnv(bucket), { fetchImpl });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    await handle.onPublish("mic", "audio");
    expect(seen.url).toBe(`https://rtc.live.cloudflare.com/v1/apps/${APP_ID}/adapters/websocket/new`);
    const body = JSON.parse(String(seen.init?.body));
    expect(body.tracks[0].endpoint).toBe(`${DEFAULT_RECORDER_ENDPOINT_BASE}/org_x/${SESSION.sessionId}/mic`);
    expect(body.tracks[0].outputCodec).toBe("pcm");
    expect(handle.tapsByTrack.has("mic")).toBe(true);
  });

  it("onPublish('video') → NO tap, NO adapter (audio-first; video is the deferred ◆)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ adapterId: "x" }));
    const enc = new ContainerEncoder(configuredEnv(new FakeBucket()), { fetchImpl });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    await handle.onPublish("cam", "video");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(handle.tapsByTrack.size).toBe(0);
  });

  it("onPublish is idempotent per track (one tap, one adapter)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ adapterId: "x" }));
    const enc = new ContainerEncoder(configuredEnv(new FakeBucket()), { fetchImpl });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    await handle.onPublish("mic", "audio");
    await handle.onPublish("mic", "audio");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(handle.tapsByTrack.size).toBe(1);
  });

  it("a create-adapter failure is swallowed (fail-open) — onPublish still resolves, tap stays", async () => {
    const fetchImpl = async () => jsonResponse({ error: "nope" }, 503); // → SfuAdapterError UPSTREAM
    const enc = new ContainerEncoder(configuredEnv(new FakeBucket()), { fetchImpl });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    await expect(handle.onPublish("mic", "audio")).resolves.toBeUndefined();
    expect(handle.tapsByTrack.has("mic")).toBe(true);
  });
});

describe("ContainerHandle frames → ONE canonical EBML object via the tap", () => {
  it("frames fed to the tap finalize to one valid Matroska object", async () => {
    const bucket = new FakeBucket();
    const enc = new ContainerEncoder(configuredEnv(bucket), { fetchImpl: async () => jsonResponse({ adapterId: "a" }) });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    await handle.onPublish("mic", "audio");
    const tap = handle.tapsByTrack.get("mic")!;
    for (let i = 0; i < 4; i++) await tap.onFrame(packet(i, i * 20, [0x10, 0x20, 0x30, 0x40]));
    const result = await handle.finalize();
    expect(bucket.created).toHaveLength(1);
    expect(result!.key).toBe(`org_x/realtime-recordings/${SESSION.sessionId}/recording.webm`);
    expect(sniffWebm(bucket.objectBytes())).toBe("webm");
  });

  it("finalize/abort fail-open when a tap throws (never propagates)", async () => {
    const enc = new ContainerEncoder(configuredEnv(new FakeBucket()), { fetchImpl: async () => jsonResponse({ adapterId: "a" }) });
    const handle = (await enc.begin(SESSION)) as ContainerHandle;
    await handle.onPublish("mic", "audio");
    const tap = handle.tapsByTrack.get("mic")!;
    (tap as unknown as { finalize: () => Promise<never> }).finalize = async () => {
      throw new Error("boom");
    };
    await expect(handle.finalize()).resolves.toBeNull();
    await expect(handle.abort()).resolves.toBeUndefined();
  });
});
