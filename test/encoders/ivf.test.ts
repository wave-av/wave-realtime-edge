// RT-R10 (#72) — IVF → raw-VP8 reframing unit test (UNKNOWN U4). A synthetic IVF buffer (DKIF header + 2 frames,
// one keyframe + one inter) → exactly 2 raw VP8 frames with the right keyframe flags + sizes. Plus the fail-soft
// edges (non-IVF, truncated tail, zero-length frame). Pure: no env, no I/O, no muxer.
import { describe, it, expect } from "vitest";
import { parseIvf, isVp8Keyframe, vp8KeyframeDimensions } from "../../src/encoders/ivf.js";

/** Build an IVF buffer: 32-byte DKIF file header + each frame as [u32 size LE][u64 ts LE][payload]. */
function buildIvf(frames: { payload: number[]; ts?: number }[]): Uint8Array {
  const header = new Uint8Array(32);
  header.set([0x44, 0x4b, 0x49, 0x46], 0); // "DKIF"
  header[6] = 32; // header length u16 LE = 32
  header.set([0x56, 0x50, 0x38, 0x30], 8); // "VP80" FourCC
  const parts: Uint8Array[] = [header];
  for (const f of frames) {
    const fh = new Uint8Array(12);
    const size = f.payload.length;
    fh[0] = size & 0xff;
    fh[1] = (size >> 8) & 0xff;
    fh[2] = (size >> 16) & 0xff;
    fh[3] = (size >> 24) & 0xff;
    const ts = f.ts ?? 0;
    fh[4] = ts & 0xff; // low byte of the u64 ts (rest 0)
    parts.push(fh, Uint8Array.from(f.payload));
  }
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// A VP8 keyframe: first byte bit0 = 0 (0x9d 0x01 0x2a is the keyframe start code at bytes 3-5).
const KEY = [0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01]; // byte0 0x10 → bit0=0 → keyframe
// A VP8 inter frame: first byte bit0 = 1.
const INTER = [0x11, 0x22, 0x33]; // byte0 0x11 → bit0=1 → inter

describe("parseIvf — IVF → raw VP8 frames", () => {
  it("a 2-frame IVF (one keyframe, one inter) → exactly 2 raw VP8 frames with correct flags + sizes", () => {
    const buf = buildIvf([{ payload: KEY, ts: 0 }, { payload: INTER, ts: 33 }]);
    const frames = parseIvf(buf);
    expect(frames).toHaveLength(2);
    expect(frames[0].keyframe).toBe(true);
    expect(Array.from(frames[0].data)).toEqual(KEY);
    expect(frames[0].data.length).toBe(KEY.length);
    expect(frames[1].keyframe).toBe(false);
    expect(Array.from(frames[1].data)).toEqual(INTER);
    expect(frames[1].data.length).toBe(INTER.length);
  });

  it("isVp8Keyframe reads bit0 of the first byte (0 = key, 1 = inter)", () => {
    expect(isVp8Keyframe(Uint8Array.from(KEY))).toBe(true);
    expect(isVp8Keyframe(Uint8Array.from(INTER))).toBe(false);
    expect(isVp8Keyframe(new Uint8Array(0))).toBe(false);
  });

  it("a non-IVF buffer (no DKIF signature) → [] (fail-soft, caller drops the frame)", () => {
    expect(parseIvf(Uint8Array.from([1, 2, 3, 4, 5]))).toEqual([]);
    const notDkif = buildIvf([{ payload: KEY }]);
    notDkif[0] = 0x00; // corrupt the signature
    expect(parseIvf(notDkif)).toEqual([]);
  });

  it("a truncated trailing frame is discarded; earlier whole frames are kept (never throws / OOB)", () => {
    const buf = buildIvf([{ payload: KEY }, { payload: INTER }]);
    const truncated = buf.slice(0, buf.length - 1); // drop the last payload byte of the inter frame
    const frames = parseIvf(truncated);
    expect(frames).toHaveLength(1); // only the complete keyframe survives
    expect(frames[0].keyframe).toBe(true);
  });

  it("a zero-length frame is skipped (no empty SimpleBlock)", () => {
    const buf = buildIvf([{ payload: [] }, { payload: KEY }]);
    const frames = parseIvf(buf);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].data)).toEqual(KEY);
  });
});

// RT-R10 (#78) — read REAL frame geometry from the VP8 keyframe header so the WebM Tracks declare the true
// PixelWidth/PixelHeight (the muxer's 1280×720 was a placeholder). dims live at bytes 6-9 (each u16 LE, mask
// &0x3fff to drop the 2-bit scale), right after the 0x9d 0x01 0x2a start code at bytes 3-5.
describe("vp8KeyframeDimensions — real geometry from a VP8 keyframe header", () => {
  /** A VP8 keyframe with width/height encoded LE at bytes 6-7 / 8-9 (optional 2-bit scale in the high bits). */
  const keyframe = (w: number, h: number, wScale = 0, hScale = 0): Uint8Array =>
    Uint8Array.from([
      0x10, 0x00, 0x00, // byte0 bit0=0 → key; (tag bytes)
      0x9d, 0x01, 0x2a, // keyframe start code
      w & 0xff, ((w >> 8) & 0x3f) | (wScale << 6), // width  u16 LE (low 14 bits) + 2-bit scale
      h & 0xff, ((h >> 8) & 0x3f) | (hScale << 6), // height u16 LE (low 14 bits) + 2-bit scale
    ]);

  it("reads 320×240 off a keyframe header", () => {
    expect(vp8KeyframeDimensions(keyframe(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it("masks off the 2-bit upscale factor in the high bits (1280×720 with scale set still reads 1280×720)", () => {
    expect(vp8KeyframeDimensions(keyframe(1280, 720, 0b11, 0b10))).toEqual({ width: 1280, height: 720 });
  });

  it("returns null for an inter frame (bit0 of byte0 = 1)", () => {
    const inter = keyframe(320, 240);
    inter[0] = 0x11; // bit0 = 1 → inter
    expect(vp8KeyframeDimensions(inter)).toBeNull();
  });

  it("returns null when the 0x9d 0x01 0x2a start code is absent (not a parseable keyframe header)", () => {
    const bad = keyframe(320, 240);
    bad[3] = 0x00; // corrupt the start code
    expect(vp8KeyframeDimensions(bad)).toBeNull();
  });

  it("fail-soft on a too-short payload and on a zero dimension (never throws)", () => {
    expect(vp8KeyframeDimensions(Uint8Array.from([0x10, 0x00, 0x00, 0x9d, 0x01]))).toBeNull(); // < 10 bytes
    expect(vp8KeyframeDimensions(keyframe(0, 240))).toBeNull(); // 0 width → keep muxer default
  });
});
