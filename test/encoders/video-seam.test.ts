// RT-R8 P3 SCAFFOLD — the JPEG→VP8 video seam in RawSfuTap. A fake VP8 encoder + synthetic JPEG Packets → the
// muxed WebM contains a VIDEO SimpleBlock, still SKIP-clean (no get/put/delete), still ONE canonical object.
// Also proves the DEFAULT (no videoEncoder) drops video frames so the audio-only path is unchanged.
import { describe, it, expect } from "vitest";
import { RawSfuTap, type VideoEncoder } from "../../src/encoders/container-adapter.js";
import { sniffWebm } from "../../src/recording-writer.js";

class FakeUpload {
  parts: Uint8Array[] = [];
  constructor(public key: string, public uploadId: string) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push(data);
    return { partNumber, etag: `e-${partNumber}` };
  }
  async complete() {
    return {} as R2Object;
  }
  async abort() {}
}
class FakeBucket {
  created: FakeUpload[] = [];
  getCalls = 0;
  putCalls = 0;
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

// The first byte of a SimpleBlock (id 0xA3) payload is the track-number VINT: video = track 1 (0x81), audio = 2 (0x82).
function hasVideoSimpleBlock(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xa3) {
      // skip the element-size VINT (1 octet for our small blocks) then read the track-number VINT
      const track = bytes[i + 2];
      if (track === 0x81) return true; // VINT-encoded track number 1 (video)
    }
  }
  return false;
}

// A trivial fake VP8 encoder: maps a JPEG payload → a marker VP8 byte-run (proves the seam, no libvpx).
const fakeVp8: VideoEncoder = { codec: "vp8", encode: (jpeg) => Uint8Array.from([0x9d, 0x01, 0x2a, ...jpeg]) };

const target = (bucket: FakeBucket) => ({ bucket: bucket as unknown as R2Bucket, org: "org_x", sessionId: "sess_VID123" });

describe("RawSfuTap video seam — JPEG → VP8 → video SimpleBlock", () => {
  it("with a videoEncoder + outputCodec 'jpeg', the muxed object has a VIDEO SimpleBlock + is one canonical webm", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket), outputCodec: "jpeg", videoEncoder: fakeVp8 });
    for (let i = 0; i < 3; i++) await tap.onFrame(packet(i, i * 33, [0xff, 0xd8, 0xff, 0xe0, i])); // JPEG SOI-ish
    const result = await tap.finalize();
    expect(bucket.created).toHaveLength(1);
    expect(result!.key).toBe("org_x/realtime-recordings/sess_VID123/recording.webm");
    const bytes = bucket.objectBytes();
    expect(sniffWebm(bytes)).toBe("webm");
    expect(hasVideoSimpleBlock(bytes)).toBe(true);
  });

  it("stays SKIP-clean (no get/put/delete) on the video path", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket), outputCodec: "jpeg", videoEncoder: fakeVp8 });
    await tap.onFrame(packet(0, 0, [1, 2, 3]));
    await tap.finalize();
    expect(bucket.getCalls).toBe(0);
    expect(bucket.putCalls).toBe(0);
    expect(bucket.deleteCalls).toBe(0);
  });

  it("DEFAULT (no videoEncoder) drops video frames → no object (audio-only path unchanged)", async () => {
    const bucket = new FakeBucket();
    const tap = new RawSfuTap({ target: target(bucket), outputCodec: "jpeg" }); // no videoEncoder
    for (let i = 0; i < 3; i++) await tap.onFrame(packet(i, i * 33, [0xff, 0xd8, i]));
    const result = await tap.finalize();
    expect(result).toBeNull();
    expect(bucket.created).toHaveLength(0);
  });
});
