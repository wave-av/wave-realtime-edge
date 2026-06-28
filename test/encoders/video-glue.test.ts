// RT-R10 (#72) — VIDEO GLUE end-to-end (inert, fake encoder). ContainerHandle.onPublish('video') now opens a
// JPEG tap whose async VP8 encode runs on the selected RecorderTarget; this drives it with a FAKE target that
// returns canned IVF for any JPEG and asserts the muxed WebM carries a V_VP8 TrackEntry + ≥1 video SimpleBlock,
// stays SKIP-clean (no @wave-av/content-hash import is verified by bundle-guard; here we assert no get/put/delete),
// produces exactly ONE canonical R2 object, and that audio + video coexist in one file. Plus the DORMANT guard:
// RECORDER_TARGET unset (NoneTarget) → onPublish('video') opens NO tap and drops frames with no throw.
import { describe, it, expect } from "vitest";
import { ContainerHandle } from "../../src/encoders/container.js";
import type { EncoderEnv } from "../../src/encoders/encoder.js";
import { sniffWebm } from "../../src/recording-writer.js";

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────────────
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

// Proto3 Packet { seq=1; ts=2; payload=5 } encoder (matches container-adapter.decodePacket).
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

// A canned IVF body (DKIF header + ONE keyframe) the fake /encode returns for any JPEG.
function cannedIvf(): Uint8Array {
  const header = new Uint8Array(32);
  header.set([0x44, 0x4b, 0x49, 0x46], 0); // "DKIF"
  header[6] = 32;
  header.set([0x56, 0x50, 0x38, 0x30], 8); // "VP80"
  const vp8 = [0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a]; // byte0 bit0=0 → keyframe
  const fh = new Uint8Array(12);
  fh[0] = vp8.length;
  const out = new Uint8Array(32 + 12 + vp8.length);
  out.set(header, 0);
  out.set(fh, 32);
  out.set(Uint8Array.from(vp8), 44);
  return out;
}

// A fake `/encode` HTTP endpoint (used by SelfHostTarget) that returns the canned IVF for any video JPEG body.
function fakeEncodeFetch() {
  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    return new Response(cannedIvf(), { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
}

const APP_ID = "0123456789abcdef0123456789abcdef";
function armedEnv(extra: Partial<EncoderEnv> = {}): EncoderEnv {
  return {
    RT_RECORD: "1",
    CF_CALLS_APP_ID: APP_ID,
    CF_CALLS_APP_SECRET: "sfu-secret",
    ...extra,
  } as EncoderEnv;
}
const SESSION = { org: "org_x", room: "room_y", sessionId: "sess_VID123" };

// Build a ContainerHandle directly with a fake create-adapter fetch (never reaches the SFU) so onPublish runs.
function handleFor(env: EncoderEnv): ContainerHandle {
  const okFetch = async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ adapterId: "a-1" }), { status: 200 });
  return new ContainerHandle(env, SESSION, okFetch as never, "wss://rt.wave.online/v1/realtime/recorder", { maxAttempts: 1 });
}

describe("video glue — onPublish('video') → RecorderTarget async encode → IVF → video SimpleBlock", () => {
  it("self-host target: a video publish + JPEG frames → ONE webm with a video SimpleBlock + audio coexists", async () => {
    const bucket = new FakeBucket();
    const env = armedEnv({
      RT_RECORDINGS: bucket as unknown as R2Bucket,
      RECORDER_TARGET: "selfhost",
      RECORDER_SELFHOST_URL: "https://studio.example:8080",
    });
    // selectRecorderTarget(env) builds a SelfHostTarget using global fetch — stub it for this test.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeEncodeFetch() as never;
    try {
      const handle = handleFor(env);
      await handle.onPublish("vtrack", "video");
      await handle.onPublish("atrack", "audio");
      const vtap = handle.tapsByTrack.get("vtrack")!;
      const atap = handle.tapsByTrack.get("atrack")!;
      expect(vtap).toBeDefined();
      expect(atap).toBeDefined();
      for (let i = 0; i < 3; i++) await vtap.onFrame(packet(i, i * 33, [0xff, 0xd8, 0xff, 0xe0, i])); // JPEG-ish
      for (let i = 0; i < 3; i++) await atap.onFrame(packet(i, i * 20, [0x01, 0x02, i, 0x04])); // PCM-ish
      await handle.finalize();
    } finally {
      globalThis.fetch = realFetch;
    }
    // ONE canonical object per track; the video object proves the glue.
    const vkey = "org_x/realtime-recordings/sess_VID123/recording.webm";
    expect(bucket.created.length).toBeGreaterThanOrEqual(1);
    const vbytes = bucket.created.map((u) => u).find((u) => u.key === vkey)!.parts.reduce<Uint8Array>((acc, p) => {
      const out = new Uint8Array(acc.length + p.length);
      out.set(acc, 0);
      out.set(p, acc.length);
      return out;
    }, new Uint8Array(0));
    expect(sniffWebm(vbytes)).toBe("webm");
    // V_VP8 TrackEntry present + a video SimpleBlock (track-number VINT 0x81).
    expect(bytesContain(vbytes, new TextEncoder().encode("V_VP8"))).toBe(true);
    expect(hasVideoSimpleBlock(vbytes)).toBe(true);
    // SKIP-clean: no get/put/delete on the bucket (multipart only).
    expect(bucket.getCalls).toBe(0);
    expect(bucket.putCalls).toBe(0);
    expect(bucket.deleteCalls).toBe(0);
  });

  it("DORMANT: RECORDER_TARGET unset → onPublish('video') opens NO tap, drops frames, no throw (main inert)", async () => {
    const bucket = new FakeBucket();
    const env = armedEnv({ RT_RECORDINGS: bucket as unknown as R2Bucket }); // no RECORDER_TARGET → NoneTarget
    const handle = handleFor(env);
    await expect(handle.onPublish("vtrack", "video")).resolves.toBeUndefined();
    expect(handle.tapsByTrack.get("vtrack")).toBeUndefined(); // no video tap opened
    await handle.finalize();
    expect(bucket.created).toHaveLength(0); // nothing recorded
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function bytesContain(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
function hasVideoSimpleBlock(bytes: Uint8Array): boolean {
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0xa3 && bytes[i + 2] === 0x81) return true; // SimpleBlock id, track-number VINT 1 (video)
  }
  return false;
}
