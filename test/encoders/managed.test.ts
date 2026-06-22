// RT-P1.5 — Adapter C (managed) streams a fixture WebM into the SKIP-tier RealtimeRecorder. Injected fakes
// only (no live network, no live media): a fake ManagedRecordingApi yields a finished WebM stream, an
// in-memory R2 multipart bucket (the same shape proven in recording-writer.test.ts) is the SKIP sink. The
// bucket spies on get/put/delete so we re-assert the SKIP invariant: C never touches a dedup path.
import { describe, it, expect } from "vitest";
import { ManagedEncoder, DefaultManagedRecordingApi, type ManagedRecordingApi } from "../../src/encoders/managed.js";
import type { EncoderEnv } from "../../src/encoders/encoder.js";
import { sniffWebm, extFor } from "../../src/recording-writer.js";

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

// ── RT-R1: the REAL RealtimeKit recording REST binding (fake fetch — no live network). ───────────────────
const ACC = "0123456789abcdef0123456789abcdef"; // HEX32
const APP = "6dee33e5-cd89-41e8-a81c-9a8cd48bb9c3"; // uuidish
const REC = "97cb480d-5840-4528-ace3-919b5e386c68"; // uuidish recording id
const rtkEnv: EncoderEnv = { CF_ACCOUNT_ID: ACC, RTK_APP_ID: APP, CF_API_TOKEN: "tok", RT_RECORD: "1" };
const RECORDINGS_URL = `https://api.cloudflare.com/client/v4/accounts/${ACC}/realtime/kit/${APP}/recordings`;

/** A fake fetch that scripts the recording lifecycle; records each call for assertion. */
function rtkFetch(script: { statusSequence?: string[]; startOk?: boolean; downloadUrl?: string }) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let statusIdx = 0;
  const seq = script.statusSequence ?? ["UPLOADING", "UPLOADED"];
  const impl = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: input, body });
    const json = (o: unknown, ok = true, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (method === "POST" && input === RECORDINGS_URL) {
      return script.startOk === false ? json({ success: false }, false, 400) : json({ success: true, data: { id: REC, status: "INVOKED" } });
    }
    if (method === "PUT" && input === `${RECORDINGS_URL}/${REC}`) {
      return json({ success: true, data: { id: REC, status: "RECORDING" } });
    }
    if (method === "GET" && input === `${RECORDINGS_URL}/${REC}`) {
      const status = seq[Math.min(statusIdx++, seq.length - 1)];
      return json({ success: true, data: { id: REC, status, download_url: script.downloadUrl ?? "https://cf/r.mp4" } });
    }
    return json({ success: false }, false, 404);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("DefaultManagedRecordingApi (RT-R1) — real RTK recording REST", () => {
  it("start POSTs meeting_id to the recordings endpoint and returns data.id", async () => {
    const { impl, calls } = rtkFetch({});
    const api = new DefaultManagedRecordingApi(rtkEnv, async () => {}, 5, 0, impl);
    const r = await api.start("meeting-xyz");
    expect(r.recordingId).toBe(REC);
    expect(calls[0]).toMatchObject({ method: "POST", url: RECORDINGS_URL, body: { meeting_id: "meeting-xyz" } });
  });

  it("stop PUTs action:stop, polls GET until UPLOADED, returns the download_url", async () => {
    const { impl, calls } = rtkFetch({ statusSequence: ["UPLOADING", "UPLOADING", "UPLOADED"], downloadUrl: "https://cf/final.mp4" });
    const api = new DefaultManagedRecordingApi(rtkEnv, async () => {}, 10, 0, impl);
    const r = await api.stop(REC);
    expect(r).toEqual({ webmUrl: "https://cf/final.mp4" });
    expect(calls[0]).toMatchObject({ method: "PUT", body: { action: "stop" } });
    expect(calls.filter((c) => c.method === "GET").length).toBe(3); // polled until UPLOADED
  });

  it("stop → null when the recording ERRORED", async () => {
    const { impl } = rtkFetch({ statusSequence: ["UPLOADING", "ERRORED"] });
    const api = new DefaultManagedRecordingApi(rtkEnv, async () => {}, 10, 0, impl);
    expect(await api.stop(REC)).toBeNull();
  });

  it("stop → null on poll timeout (webhook is the fallback)", async () => {
    const { impl, calls } = rtkFetch({ statusSequence: ["UPLOADING"] }); // never reaches UPLOADED
    const api = new DefaultManagedRecordingApi(rtkEnv, async () => {}, 3, 0, impl);
    expect(await api.stop(REC)).toBeNull();
    expect(calls.filter((c) => c.method === "GET").length).toBe(3); // bounded to maxPolls
  });

  it("start fails CLOSED (throws) when creds are unconfigured — caller's begin() catches → records nothing", async () => {
    const api = new DefaultManagedRecordingApi({ RT_RECORD: "1" }); // no acc/app/token
    await expect(api.start("m")).rejects.toThrow(/not configured/);
  });
});

describe("sniffWebm (RT-R1) — mp4 (RTK composite) detection", () => {
  it("detects an ISO-BMFF/MP4 ftyp box → container mp4 → .mp4 extension", () => {
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(sniffWebm(mp4)).toBe("mp4");
    expect(extFor("mp4")).toBe("mp4");
  });
  it("still detects webm EBML magic, and falls back to raw/.bin otherwise", () => {
    expect(sniffWebm(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(sniffWebm(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))).toBe("raw");
    expect(extFor("raw")).toBe("bin");
  });
});
