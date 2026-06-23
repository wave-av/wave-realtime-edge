// RT-R10 (#79) — EMBEDDED real-ffmpeg VP8 IVF regression (no ffmpeg dependency in CI).
//
// The synthetic ivf.test.ts builds an IVF buffer by hand, so it can only ever confirm the parser agrees with
// ITS OWN assumptions — it cannot catch a drift between our IVF reader and the bytes a REAL `ffmpeg ... -c:v
// libvpx -f ivf` actually emits (the live rt-encoder container's exact output). This test embeds a genuine
// ffmpeg-produced IVF (`ffmpeg -f lavfi -i color=c=blue:size=320x240:rate=10 -frames:v 8 -c:v libvpx -f ivf`),
// base64'd, decodes it in-test, and runs the ACTUAL parseIvf + WebmMuxer end-to-end against it.
//
// Guards: exactly 8 frames; frame[0] is the keyframe and the rest are inter; the real keyframe yields real
// 320×240 dims; and a muxed WebM starts with the EBML magic + declares V_VP8 — i.e. the whole IVF→VP8→WebM
// glue survives real libvpx framing. Pure (no I/O, no env): the fixture is a literal string.
import { describe, it, expect } from "vitest";
import { parseIvf, vp8KeyframeDimensions } from "../../src/encoders/ivf.js";
import { WebmMuxer } from "../../src/muxer/webm.js";

// A REAL ffmpeg VP8 IVF (495 bytes): DKIF header + 8 frames at 320×240, 10fps, libvpx, ~50kb/s, solid blue.
// Produced with: ffmpeg -y -f lavfi -i color=c=blue:size=320x240:rate=10 -frames:v 8 -c:v libvpx -b:v 50k -f ivf
const REAL_VP8_IVF_B64 =
  "REtJRgAAIABWUDgwQAHwAAoAAAABAAAACAAAAAAAAAC5AAAAAAAAAAAAAADQEgCdASpAAfAAAEcIhYWIhYSIAgICdaoD+AIGhoT3BoFkn2vbmyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4evQA/v9NEv/8WFfxYV/FhX/xYV/8/M7txfzmABoAAAABAAAAAAAAANECAAEQEAAYABhYL/QACIAEM1+tck+ccwAAGgAAAAIAAAAAAAAA0QIAARAQABgAGFgv9AAIgAQzX61yT5xzAAAaAAAAAwAAAAAAAADRAgABEBAAGAAYWC/0AAiABDNfrXJPnHMAABoAAAAEAAAAAAAAANECAAEQEAAYABhYL/QACIAEM1+tck+ccwAAGgAAAAUAAAAAAAAA0QIAARAQABgAGFgv9AAIgAQzX61yT5xzAAAaAAAABgAAAAAAAADRAgABEBAAGAAYWC/0AAiABDNfrXJPnHMAABoAAAAHAAAAAAAAANECAAEQEBRgAGFgv9AAIgAQzX61yT5xzAAA";

/** Decode the embedded base64 fixture to a Uint8Array (no Buffer/Node dependency in the assert path). */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** First index of a byte sequence (for EBML id / CodecID assertions). */
function indexOfSeq(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe("real ffmpeg VP8 IVF — parseIvf + WebmMuxer survive live libvpx framing (#79)", () => {
  const ivf = decodeBase64(REAL_VP8_IVF_B64);

  it("decodes to a non-trivial DKIF buffer", () => {
    expect(ivf.length).toBeGreaterThan(64);
    expect(Array.from(ivf.subarray(0, 4))).toEqual([0x44, 0x4b, 0x49, 0x46]); // "DKIF"
  });

  it("parseIvf yields exactly 8 frames; frame[0] is a keyframe, the rest are inter", () => {
    const frames = parseIvf(ivf);
    expect(frames).toHaveLength(8);
    expect(frames[0].keyframe).toBe(true);
    for (let i = 1; i < frames.length; i++) expect(frames[i].keyframe).toBe(false);
  });

  it("the real keyframe self-describes 320×240 (vp8KeyframeDimensions reads the live header)", () => {
    const frames = parseIvf(ivf);
    expect(vp8KeyframeDimensions(frames[0].data)).toEqual({ width: 320, height: 240 });
  });

  it("muxing the real frames produces a WebM with the EBML magic and a V_VP8 CodecID", () => {
    const frames = parseIvf(ivf);
    const dims = vp8KeyframeDimensions(frames[0].data);
    const m = new WebmMuxer();
    if (dims) m.setVideoDimensions(dims.width, dims.height);
    for (const f of frames) m.addFrame({ kind: "video", data: f.data, timestampMs: f.timestamp, keyframe: f.keyframe });
    m.finish();
    const out = m.drain();
    expect(Array.from(out.subarray(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML magic
    expect(indexOfSeq(out, Array.from(new TextEncoder().encode("V_VP8")))).toBeGreaterThan(0);
  });
});
