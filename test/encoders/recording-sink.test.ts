// RT-R10 (#72) — RecordingSink seam tests. Proves: default 'r2' → ONE canonical R2 object; 'fanout' writes
// the SAME bytes to BOTH sinks and finalize() returns ONE canonical result (the primary/R2 one); single-writer
// invariant (the fanout's secondary is an exact replica, never a divergent writer); fail-open (a secondary error
// never blocks the primary). Uses the same FakeBucket shape as video-seam.test.ts. No live net, no fs.
import { describe, it, expect } from "vitest";
import {
  selectSink,
  R2Sink,
  LocalFsSink,
  FanoutSink,
  type LocalFileWriter,
  type SinkSession,
} from "../../src/encoders/recording-sink.js";

class FakeUpload {
  parts: Uint8Array[] = [];
  completed = false;
  aborted = false;
  constructor(public key: string, public uploadId: string) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push(data);
    return { partNumber, etag: `e-${partNumber}` };
  }
  async complete() {
    this.completed = true;
    return {} as R2Object;
  }
  async abort() {
    this.aborted = true;
  }
}
class FakeBucket {
  created: FakeUpload[] = [];
  putCalls = 0;
  getCalls = 0;
  deleteCalls = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `u-${this.created.length + 1}`);
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
  bytesWritten(): number {
    return this.created[0]?.parts.reduce((n, p) => n + p.length, 0) ?? 0;
  }
}

// A WebM-magic-leading part so the recorder picks the .webm extension (sniffWebm).
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const MORE = Uint8Array.from([9, 9, 9, 9]);
const session: SinkSession = { org: "org_x", sessionId: "sess_SINK1" };

class FakeLocalWriter implements LocalFileWriter {
  chunks: Uint8Array[] = [];
  closed = false;
  discarded = false;
  constructor(public path: string) {}
  async append(part: Uint8Array) {
    this.chunks.push(part);
  }
  async close() {
    this.closed = true;
    const bytes = this.chunks.reduce((n, p) => n + p.length, 0);
    return bytes > 0 ? { path: this.path, bytes } : null;
  }
  async discard() {
    this.discarded = true;
  }
}

describe("R2Sink — one canonical object", () => {
  it("writes via RealtimeRecorder and finalize returns the canonical webm key", async () => {
    const bucket = new FakeBucket();
    const sink = new R2Sink(bucket as unknown as R2Bucket, session);
    await sink.write(WEBM);
    await sink.write(MORE);
    const r = await sink.finalize();
    expect(r!.key).toBe("org_x/realtime-recordings/sess_SINK1/recording.webm");
    expect(bucket.created).toHaveLength(1);
    expect(bucket.created[0].completed).toBe(true);
    expect(bucket.bytesWritten()).toBe(WEBM.length + MORE.length);
    // SKIP-clean: no get/put/delete on the dedup-index path.
    expect(bucket.getCalls).toBe(0);
    expect(bucket.putCalls).toBe(0);
    expect(bucket.deleteCalls).toBe(0);
  });

  it("no bytes → null, no object", async () => {
    const bucket = new FakeBucket();
    const sink = new R2Sink(bucket as unknown as R2Bucket, session);
    expect(await sink.finalize()).toBeNull();
    expect(bucket.created).toHaveLength(0);
  });
});

describe("selectSink — default + selection", () => {
  it("defaults to r2 (RECORDER_SINK unset)", () => {
    const bucket = new FakeBucket();
    const sink = selectSink({ RT_RECORDINGS: bucket as unknown as R2Bucket }, session);
    expect(sink.kind).toBe("r2");
  });

  it("RECORDER_SINK='r2' → R2Sink", () => {
    const bucket = new FakeBucket();
    const sink = selectSink({ RECORDER_SINK: "r2", RT_RECORDINGS: bucket as unknown as R2Bucket }, session);
    expect(sink).toBeInstanceOf(R2Sink);
  });

  it("RECORDER_SINK='fanout' with a local writer → FanoutSink([R2,Local])", () => {
    const bucket = new FakeBucket();
    const sink = selectSink(
      { RECORDER_SINK: "fanout", RT_RECORDINGS: bucket as unknown as R2Bucket, RECORDER_LOCAL_DIR: "/rec" },
      session,
      { localWriterFor: (dir, s) => new FakeLocalWriter(`${dir}/${s.sessionId}.webm`) },
    );
    expect(sink.kind).toBe("fanout");
  });

  it("RECORDER_SINK='localfs' but no local writer configured → degrade to R2 (never silently record nothing)", () => {
    const bucket = new FakeBucket();
    const sink = selectSink({ RECORDER_SINK: "localfs", RT_RECORDINGS: bucket as unknown as R2Bucket }, session);
    expect(sink.kind).toBe("r2");
  });
});

describe("FanoutSink — same bytes to both, ONE canonical result", () => {
  it("writes identical bytes to R2 + local, finalize returns the PRIMARY (R2) result", async () => {
    const bucket = new FakeBucket();
    const local = new FakeLocalWriter("/rec/sess_SINK1.webm");
    const fan = new FanoutSink([new R2Sink(bucket as unknown as R2Bucket, session), new LocalFsSink(local, session)]);
    await fan.write(WEBM);
    await fan.write(MORE);
    const r = await fan.finalize();
    // ONE canonical result = the R2 primary.
    expect(r!.key).toBe("org_x/realtime-recordings/sess_SINK1/recording.webm");
    // Both sinks got the SAME bytes (exact replica, single-writer invariant — not a divergent writer).
    expect(bucket.bytesWritten()).toBe(WEBM.length + MORE.length);
    const localBytes = local.chunks.reduce((n, p) => n + p.length, 0);
    expect(localBytes).toBe(WEBM.length + MORE.length);
    expect(local.closed).toBe(true);
  });

  it("fail-open: a SECONDARY write error never blocks the primary canonical write", async () => {
    const bucket = new FakeBucket();
    const brokenSecondary: LocalFileWriter = {
      append: async () => {
        throw new Error("disk full");
      },
      close: async () => null,
      discard: async () => {},
    };
    const fan = new FanoutSink([
      new R2Sink(bucket as unknown as R2Bucket, session),
      new LocalFsSink(brokenSecondary, session),
    ]);
    await fan.write(WEBM); // must NOT throw despite the secondary failing
    const r = await fan.finalize();
    expect(r!.key).toBe("org_x/realtime-recordings/sess_SINK1/recording.webm");
    expect(bucket.created[0].completed).toBe(true);
  });
});
