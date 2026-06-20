// RT-P1.2 — unit tests for the realtime recording writer (tier=SKIP). In-memory R2 multipart fakes,
// no live runtime. Proves: one object per session, append+finalize writes the bytes, nothing-written →
// no 0-byte object, idempotent finalize, and — the load-bearing SKIP invariant — NO dedup/claim/addRef
// path is ever touched (the bucket's get/put/delete are never called; only multipart methods are).
import { describe, it, expect } from "vitest";
import {
  RealtimeRecorder,
  sniffWebm,
  extFor,
  recordingKey,
  PART_SIZE,
} from "../src/recording-writer.js";

// ── Minimal R2 multipart fakes. The bucket spies on EVERY method a dedup writer would use (get/put/delete
//    for `_dup/` routing) so the tests can assert the SKIP tier never invokes them. ──────────────────────
class FakeUpload {
  parts: Array<{ partNumber: number; size: number }> = [];
  completed: Array<{ partNumber: number; etag: string }> | null = null;
  aborted = false;
  completeCalls = 0;
  throwOnNextComplete = false;
  constructor(
    public key: string,
    public uploadId: string,
  ) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push({ partNumber, size: data.length });
    return { partNumber, etag: `etag-${partNumber}` };
  }
  async complete(parts: Array<{ partNumber: number; etag: string }>) {
    this.completeCalls += 1;
    if (this.throwOnNextComplete) {
      this.throwOnNextComplete = false;
      throw new Error("network error: ACK lost");
    }
    this.completed = parts;
    return {} as R2Object;
  }
  async abort() {
    this.aborted = true;
  }
}

class FakeBucket {
  created: FakeUpload[] = [];
  resumed: FakeUpload[] = [];
  // Dedup-path spies — a SKIP writer must NEVER call these (no content move, no `_dup/` copy-then-delete).
  getCalls = 0;
  putCalls = 0;
  deleteCalls = 0;
  headResult: R2Object | null = null;
  private seq = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${++this.seq}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const u = new FakeUpload(key, uploadId);
    this.resumed.push(u);
    return u as unknown as R2MultipartUpload;
  }
  async get(_key: string) {
    this.getCalls += 1;
    return null;
  }
  async put(_key: string, _body: unknown) {
    this.putCalls += 1;
    return {} as R2Object;
  }
  async delete(_key: string) {
    this.deleteCalls += 1;
  }
  async head(_key: string) {
    return this.headResult;
  }
}
const bucket = () => new FakeBucket() as unknown as R2Bucket & FakeBucket;
const ORG = "11111111-1111-1111-1111-111111111111";
const mb = (n: number) => new Uint8Array(n * 1024 * 1024);
/** A buffer whose first 4 bytes are the EBML magic so sniffWebm returns 'webm'. */
function webm(n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0); // EBML header magic
  return b;
}
/** Assert no dedup/claim/addRef path was touched — the load-bearing SKIP invariant. */
function expectNoDedup(b: FakeBucket) {
  expect(b.getCalls).toBe(0);
  expect(b.putCalls).toBe(0);
  expect(b.deleteCalls).toBe(0);
}

describe("sniffWebm / extFor / recordingKey", () => {
  it("detects WebM/Matroska from the EBML magic", () => {
    expect(sniffWebm(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]))).toBe("webm");
  });
  it("falls back to raw for anything else (bytes still preserved)", () => {
    expect(sniffWebm(new Uint8Array([0, 0, 0, 1, 0x67]))).toBe("raw"); // an h264 start code is NOT webm here
    expect(sniffWebm(new Uint8Array([1, 2, 3]))).toBe("raw"); // too short
  });
  it("extFor + recordingKey are org-prefixed with the right extension", () => {
    expect(extFor("webm")).toBe("webm");
    expect(extFor("raw")).toBe("bin");
    expect(recordingKey(ORG, "sess-1", "webm")).toBe(`${ORG}/realtime-recordings/sess-1/recording.webm`);
    expect(recordingKey(ORG, "sess-1", "raw")).toBe(`${ORG}/realtime-recordings/sess-1/recording.bin`);
  });
});

describe("RealtimeRecorder — one object per session, tier=SKIP", () => {
  it("a small (< one part) session writes ONE canonical object and completes once", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", webm(1024));
    const done = await rec.finalize();
    expect(done).not.toBeNull();
    expect(done!.key).toBe(`${ORG}/realtime-recordings/sess-1/recording.webm`);
    expect(done!.bytes).toBe(1024);
    expect(done!.container).toBe("webm");
    // Exactly ONE multipart upload → ONE object per session.
    expect(b.created).toHaveLength(1);
    expect(b.resumed).toHaveLength(0);
    const up = b.created[0];
    expect(up.parts).toEqual([{ partNumber: 1, size: 1024 }]); // one (last) part, may be < PART_SIZE
    expect(up.completed).toHaveLength(1);
    expect(up.completeCalls).toBe(1);
    expectNoDedup(b); // SKIP: no claim/addRef/_dup move
  });

  it("append + finalize streams the bytes — exact PART_SIZE parts, smaller final part", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", webm(1 * 1024 * 1024));
    for (let i = 0; i < 11; i++) await rec.append(mb(1)); // total = 12 MiB
    const done = await rec.finalize();
    const up = b.created[0];
    const sizes = up.parts.map((p) => p.size);
    expect(sizes).toEqual([PART_SIZE, PART_SIZE, 2 * 1024 * 1024]); // 5 + 5 + 2 MiB
    expect(done!.bytes).toBe(12 * 1024 * 1024);
    expect(up.completed).toHaveLength(3);
    expect(up.completed!.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expectNoDedup(b);
  });

  it("a session that recorded nothing aborts and returns null (never a 0-byte object)", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", new Uint8Array(0));
    const done = await rec.finalize();
    expect(done).toBeNull();
    expect(b.created[0].aborted).toBe(true);
    expect(b.created[0].completed).toBeNull();
    expect(b.created[0].completeCalls).toBe(0);
    expectNoDedup(b);
  });

  it("empty appends never create a 0-byte object", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", new Uint8Array(0));
    await rec.append(new Uint8Array(0));
    await rec.append(new Uint8Array(0));
    expect(rec.bytes).toBe(0);
    const done = await rec.finalize();
    expect(done).toBeNull();
    expect(b.created[0].aborted).toBe(true);
    expectNoDedup(b);
  });

  it("finalize is idempotent — a retried call returns the cached result, never a second complete", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", webm(2048));
    const first = await rec.finalize();
    const second = await rec.finalize();
    const third = await rec.finalize();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(b.created[0].completeCalls).toBe(1); // completed exactly once despite three finalize() calls
    expect(b.created[0].completed).toHaveLength(1);
    expectNoDedup(b);
  });

  it("preserves non-WebM bytes verbatim as raw .bin (robust to whatever the tap emits)", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-2", new Uint8Array([9, 8, 7, 6, 5]));
    const done = await rec.finalize();
    expect(done!.container).toBe("raw");
    expect(done!.key).toBe(`${ORG}/realtime-recordings/sess-2/recording.bin`);
    expect(done!.bytes).toBe(5);
    expectNoDedup(b);
  });

  it("toMeta → resume completes ONE object across a simulated hibernation wake (no hash caveat)", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", webm(1024));
    await rec.append(mb(6)); // crosses one PART_SIZE boundary → 1 flushed part persisted
    const meta = rec.toMeta()!;
    expect(meta.sessionId).toBe("sess-1");
    expect(meta.parts).toHaveLength(1);
    expect(meta.uploadId).toBe(b.created[0].uploadId);
    expect(meta.container).toBe("webm");

    // …DO evicted; a new instance resumes from meta and finalizes the SAME single object.
    const resumed = RealtimeRecorder.resume(b, meta);
    await resumed.append(mb(1));
    const done = await resumed.finalize();
    const up = b.resumed[0];
    expect(up.completed).toHaveLength(2); // persisted part 1 + the new tail part
    expect(done!.key).toBe(meta.key);
    expect(b.created).toHaveLength(1); // still ONE created upload (the resume reuses it, no new object)
    expectNoDedup(b); // resume is a normal write in SKIP — still no dedup path
  });

  it("toMeta returns null once finalized (nothing left to persist/resume)", async () => {
    const b = bucket();
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-1", webm(512));
    expect(rec.toMeta()).not.toBeNull();
    await rec.finalize();
    expect(rec.toMeta()).toBeNull();
  });
});

describe("RealtimeRecorder — finalize() idempotency + toMeta() byte accuracy", () => {
  it("complete() throws but object landed → finalize succeeds; second finalize returns cached result without re-completing", async () => {
    const b = bucket();
    b.headResult = {} as R2Object; // HEAD says object exists (complete landed but ACK lost)
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-fix1", webm(1024));
    const up = b.created[0] as unknown as FakeUpload;
    up.throwOnNextComplete = true;

    // First finalize: complete() throws, HEAD returns truthy → treated as success
    const result = await rec.finalize();
    expect(result).not.toBeNull();
    expect(result!.key).toBe(`${ORG}/realtime-recordings/sess-fix1/recording.webm`);
    expect(up.completeCalls).toBe(1);

    // Second finalize: returns cached result, does NOT call complete() again
    const result2 = await rec.finalize();
    expect(result2).toEqual(result);
    expect(up.completeCalls).toBe(1); // still 1 — no second complete
  });

  it("complete() throws and object absent → rethrows; retry succeeds; complete called exactly twice, tail uploaded once", async () => {
    const b = bucket();
    b.headResult = null; // HEAD says absent (genuine failure)
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-fix2", webm(1024));
    const up = b.created[0] as unknown as FakeUpload;
    up.throwOnNextComplete = true;

    // First finalize: complete() throws, HEAD returns null → rethrows
    await expect(rec.finalize()).rejects.toThrow("network error: ACK lost");
    expect(up.completeCalls).toBe(1);
    // Tail was uploaded exactly once (during the first finalize attempt)
    expect(up.parts).toHaveLength(1);

    // Retry: complete() now succeeds (throwOnNextComplete was reset to false)
    const result = await rec.finalize();
    expect(result).not.toBeNull();
    expect(up.completeCalls).toBe(2); // exactly two complete calls total
    // Still only one part uploaded (tail was NOT re-uploaded on retry)
    expect(up.parts).toHaveLength(1);
  });

  it("toMeta().totalBytes excludes the un-flushed tail; resumed recorder's result.bytes is accurate", async () => {
    const b = bucket();
    // Append PART_SIZE + 512 KiB: exactly one 5 MiB part flushes, 512 KiB stays in buf
    const tailSize = 512 * 1024;
    const rec = await RealtimeRecorder.begin(b, ORG, "sess-fix3", webm(PART_SIZE));
    await rec.append(new Uint8Array(tailSize));

    const meta = rec.toMeta()!;
    // toMeta().totalBytes must be flushed bytes only (PART_SIZE), NOT PART_SIZE + tailSize
    expect(meta.totalBytes).toBe(PART_SIZE);

    // Resume from meta, append more, finalize — result.bytes = flushed-at-eviction + post-resume bytes
    const postResumeSize = 256 * 1024;
    const resumed = RealtimeRecorder.resume(b, meta);
    await resumed.append(new Uint8Array(postResumeSize));
    const done = await resumed.finalize();
    expect(done!.bytes).toBe(PART_SIZE + postResumeSize);
  });
});
