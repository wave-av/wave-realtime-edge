// RT-R10 (#72) — IVF → raw-VP8 reframing unit test (UNKNOWN U4). A synthetic IVF buffer (DKIF header + 2 frames,
// one keyframe + one inter) → exactly 2 raw VP8 frames with the right keyframe flags + sizes. Plus the fail-soft
// edges (non-IVF, truncated tail, zero-length frame). Pure: no env, no I/O, no muxer.
import { describe, it, expect } from "vitest";
import { parseIvf, isVp8Keyframe } from "../../src/encoders/ivf.js";

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
