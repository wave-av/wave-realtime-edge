// RT-P1.5 — WAVE WebM muxer unit tests. Synthetic VP8/Opus frames only (no live media): assert the output
// is structurally valid Matroska/WebM (EBML magic → sniffWebm "webm"), carries the right DocType + tracks,
// and streams blocks into Clusters. The muxer ships green and proven before any real WS frame exists.
import { describe, it, expect } from "vitest";
import { WebmMuxer, type EncodedFrame } from "../../src/muxer/webm.js";
import { sniffWebm } from "../../src/recording-writer.js";

const vp8 = (n: number, keyframe = false, ts = 0): EncodedFrame => ({
  kind: "video",
  data: new Uint8Array(n).fill(0x42),
  timestampMs: ts,
  keyframe,
});
const opus = (n: number, ts = 0): EncodedFrame => ({
  kind: "audio",
  data: new Uint8Array(n).fill(0x17),
  timestampMs: ts,
});

/** Find the first occurrence of a byte sequence in a buffer (for EBML id assertions). */
function indexOfSeq(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

describe("WebmMuxer — valid EBML/WebM header", () => {
  it("starts with the EBML magic so the recorder's sniffWebm tags it 'webm'", () => {
    const m = new WebmMuxer();
    m.header();
    const out = m.drain();
    expect(out[0]).toBe(0x1a);
    expect(out[1]).toBe(0x45);
    expect(out[2]).toBe(0xdf);
    expect(out[3]).toBe(0xa3);
    expect(sniffWebm(out)).toBe("webm");
  });

  it("declares DocType 'webm' and a Segment", () => {
    const m = new WebmMuxer();
    m.header();
    const out = m.drain();
    // DocType element id 0x42 0x82, then size 0x84, then "webm".
    const docType = indexOfSeq(out, [0x42, 0x82]);
    expect(docType).toBeGreaterThan(0);
    expect(indexOfSeq(out, [0x77, 0x65, 0x62, 0x6d])).toBeGreaterThan(0); // "webm" ascii
    expect(indexOfSeq(out, [0x18, 0x53, 0x80, 0x67])).toBeGreaterThan(0); // Segment id
  });

  it("declares a VP8 video track and an Opus audio track", () => {
    const m = new WebmMuxer({ width: 640, height: 480, sampleRate: 48000, channels: 2 });
    m.header();
    const out = m.drain();
    expect(indexOfSeq(out, [0x16, 0x54, 0xae, 0x6b])).toBeGreaterThan(0); // Tracks id
    expect(indexOfSeq(out, [0x56, 0x5f, 0x56, 0x50, 0x38])).toBeGreaterThan(0); // "V_VP8"
    expect(indexOfSeq(out, [0x41, 0x5f, 0x4f, 0x50, 0x55, 0x53])).toBeGreaterThan(0); // "A_OPUS"
  });

  it("header() is idempotent (a second call writes nothing more)", () => {
    const m = new WebmMuxer();
    m.header();
    const a = m.drain();
    m.header();
    const b = m.drain();
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(0);
  });
});

describe("WebmMuxer — frames stream into Clusters", () => {
  it("addFrame opens a Cluster and writes SimpleBlocks", () => {
    const m = new WebmMuxer();
    m.header();
    m.addFrame(vp8(100, true, 0)); // keyframe → Cluster
    m.addFrame(opus(40, 20));
    m.addFrame(vp8(120, false, 33));
    const out = m.drain();
    expect(indexOfSeq(out, [0x1f, 0x43, 0xb6, 0x75])).toBeGreaterThan(-1); // Cluster id present
    expect(indexOfSeq(out, [0xa3])).toBeGreaterThan(-1); // SimpleBlock id present
  });

  it("a video keyframe forces a fresh Cluster (≥2 Clusters across two keyframes)", () => {
    const m = new WebmMuxer();
    m.header();
    m.drain(); // discard header bytes
    m.addFrame(vp8(50, true, 0));
    m.addFrame(vp8(50, false, 33));
    m.addFrame(vp8(50, true, 66)); // second keyframe → second Cluster
    const out = m.drain();
    // Count Cluster ids in the post-header byte-stream.
    let count = 0;
    for (let i = 0; i + 4 <= out.length; i++) {
      if (out[i] === 0x1f && out[i + 1] === 0x43 && out[i + 2] === 0xb6 && out[i + 3] === 0x75) count++;
    }
    expect(count).toBe(2);
  });

  it("addFrame before header() auto-writes the header (output still sniffs 'webm')", () => {
    const m = new WebmMuxer();
    m.addFrame(vp8(64, true, 0));
    const out = m.drain();
    expect(sniffWebm(out)).toBe("webm");
  });

  it("drain clears the buffer; pending tracks unflushed bytes", () => {
    const m = new WebmMuxer();
    m.header();
    expect(m.pending).toBeGreaterThan(0);
    m.drain();
    expect(m.pending).toBe(0);
  });

  it("finish() is a no-op terminator (unknown-size stream needs no backfill)", () => {
    const m = new WebmMuxer();
    m.header();
    m.addFrame(opus(40, 0));
    expect(() => m.finish()).not.toThrow();
    expect(sniffWebm(m.drain())).toBe("webm");
  });
});
