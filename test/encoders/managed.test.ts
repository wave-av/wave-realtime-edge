// RT-P1.5 — Adapter C (managed) streams a fixture WebM into the SKIP-tier RealtimeRecorder. Injected fakes
// only (no live network, no live media): a fake ManagedRecordingApi yields a finished WebM stream, an
// in-memory R2 multipart bucket (the same shape proven in recording-writer.test.ts) is the SKIP sink. The
// bucket spies on get/put/delete so we re-assert the SKIP invariant: C never touches a dedup path.
import { describe, it, expect } from "vitest";
import { ManagedEncoder, type ManagedRecordingApi } from "../../src/encoders/managed.js";
import type { EncoderEnv } from "../../src/encoders/encoder.js";

// ── In-memory R2 multipart fakes (dedup-path spies). ────────────────────────────────────────────────────
class FakeUpload {
  parts: Array<{ partNumber: number; size: number }> = [];
  completed: Array<{ partNumber: number; etag: string }> | null = null;
  aborted = false;
  constructor(
    public key: string,
    public uploadId: string,
  ) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push({ partNumber, size: data.length });
    return { partNumber, etag: `etag-${partNumber}` };
  }
  async complete(parts: Array<{ partNumber: number; etag: string }>) {
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
  private seq = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${++this.seq}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return new FakeUpload(key, uploadId) as unknown as R2MultipartUpload;
  }
  async get(_k: string) {
    this.getCalls += 1;
    return null;
  }
  async put(_k: string, _b: unknown) {
    this.putCalls += 1;
    return {} as R2Object;
  }
  async delete(_k: string) {
    this.deleteCalls += 1;
  }
  async head(_k: string) {
    return null;
  }
}

const ORG = "11111111-1111-1111-1111-111111111111";
const SESSION = { org: ORG, room: "r1", sessionId: "sess-1" };
const armed = (bucket: FakeBucket): EncoderEnv => ({
  RT_RECORD: "1",
  RT_ENCODER: "managed",
  RT_RECORDINGS: bucket as unknown as R2Bucket,
});

/** A finished WebM byte-stream (first 4 bytes = EBML magic so the recorder sniffs "webm"). */
function webmStream(totalBytes: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  let first = true;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= totalBytes) {
        c.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - offset);
      const buf = new Uint8Array(n);
      if (first) {
        buf.set([0x1a, 0x45, 0xdf, 0xa3], 0); // EBML magic on the leading chunk
        first = false;
      }
      offset += n;
      c.enqueue(buf);
    },
  });
}

/** Fake CF managed-recording API: records start/stop, hands back a fixture WebM stream on fetch. */
function fakeApi(opts: { bytes?: number; stopReturnsNull?: boolean; emptyStream?: boolean } = {}): {
  api: ManagedRecordingApi;
  calls: { start: number; stop: number; fetch: number };
} {
  const calls = { start: 0, stop: 0, fetch: 0 };
  const api: ManagedRecordingApi = {
    async start(_s) {
      calls.start += 1;
      return { recordingId: "rec-1" };
    },
    async stop(_r) {
      calls.stop += 1;
      return opts.stopReturnsNull ? null : { webmUrl: "https://cf/recording/rec-1.webm" };
    },
    async fetchRecording(_u) {
      calls.fetch += 1;
      if (opts.emptyStream) return webmStream(0);
      return webmStream(opts.bytes ?? 8 * 1024 * 1024);
    },
  };
  return { api, calls };
}

describe("ManagedEncoder (C) — disarm / binding gates", () => {
  it("begin → null when disarmed (RT_RECORD !== '1')", async () => {
    const { api } = fakeApi();
    const enc = new ManagedEncoder({ RT_RECORD: "0" }, api);
    expect(await enc.begin(SESSION)).toBeNull();
  });
  it("begin → null (fail-open) when armed but RT_RECORDINGS binding is absent", async () => {
    const { api } = fakeApi();
    const enc = new ManagedEncoder({ RT_RECORD: "1", RT_ENCODER: "managed" }, api);
    expect(await enc.begin(SESSION)).toBeNull();
  });
});

describe("ManagedEncoder (C) — streams a finished WebM into the SKIP sink", () => {
  it("finalize streams the fixture WebM into ONE canonical .webm object (tier=SKIP, no dedup path)", async () => {
    const b = new FakeBucket();
    const { api, calls } = fakeApi({ bytes: 8 * 1024 * 1024 }); // 8 MiB → 1 full part + tail
    const enc = new ManagedEncoder(armed(b), api);
    const handle = await enc.begin(SESSION);
    expect(handle).not.toBeNull();
    expect(calls.start).toBe(1);

    const done = await handle!.finalize();
    expect(calls.stop).toBe(1);
    expect(calls.fetch).toBe(1);
    expect(done).not.toBeNull();
    expect(done!.key).toBe(`${ORG}/realtime-recordings/sess-1/recording.webm`);
    expect(done!.container).toBe("webm");
    expect(done!.bytes).toBe(8 * 1024 * 1024);

    expect(b.created).toHaveLength(1); // ONE object per session
    expect(b.created[0].completed).not.toBeNull();
    // SKIP invariant: C never touches a dedup/claim/_dup move.
    expect(b.getCalls).toBe(0);
    expect(b.putCalls).toBe(0);
    expect(b.deleteCalls).toBe(0);
  });

  it("finalize is idempotent — a retried call returns the cached result, no second stop/object", async () => {
    const b = new FakeBucket();
    const { api, calls } = fakeApi({ bytes: 1024 });
    const enc = new ManagedEncoder(armed(b), api);
    const handle = await enc.begin(SESSION);
    const first = await handle!.finalize();
    const second = await handle!.finalize();
    expect(second).toEqual(first);
    expect(calls.stop).toBe(1); // stopped once
    expect(b.created).toHaveLength(1); // one object only
  });

  it("nothing recorded (empty stream) → null, never a 0-byte object", async () => {
    const b = new FakeBucket();
    const { api } = fakeApi({ emptyStream: true });
    const enc = new ManagedEncoder(armed(b), api);
    const handle = await enc.begin(SESSION);
    const done = await handle!.finalize();
    expect(done).toBeNull();
    expect(b.created).toHaveLength(0); // recorder.begin never called → no upload created
  });

  it("stop returns null (CF had no recording) → null, no object", async () => {
    const b = new FakeBucket();
    const { api } = fakeApi({ stopReturnsNull: true });
    const enc = new ManagedEncoder(armed(b), api);
    const handle = await enc.begin(SESSION);
    expect(await handle!.finalize()).toBeNull();
    expect(b.created).toHaveLength(0);
  });
});
