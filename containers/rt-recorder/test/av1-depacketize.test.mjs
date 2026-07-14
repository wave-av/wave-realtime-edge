// #154 — Av1FrameAssembler pure logic (buffer-until-marker, reset, malformed safety). No werift: the real
// AV1RtpPayload.deSerialize/getFrame are injected, so this locks the ASSEMBLY behaviour deterministically.
// The real-werift byte round-trip (RTP → depacketize → IVF → ffmpeg av1) is proven in harness/av1-depacketize-proof.mjs.
import { describe, it, expect } from "vitest";
import { Av1FrameAssembler } from "../server/av1-depacketize.mjs";

/** Fake werift AV1 depacketizer: deSerialize tags each payload; getFrame concatenates their bytes. */
function fakes({ throwOnDeser = new Set(), throwOnGetFrame = false } = {}) {
  return {
    deSerialize: (buf) => {
      if (throwOnDeser.has(buf[0])) throw new Error("malformed");
      return { isKeyframe: buf[0] === 0xff, data: buf };
    },
    getFrame: (payloads) => {
      if (throwOnGetFrame) throw new Error("lost fragment");
      return Buffer.concat(payloads.map((p) => p.data));
    },
  };
}

describe("Av1FrameAssembler — reassemble RTP packets into temporal units", () => {
  it("requires both injected werift functions", () => {
    expect(() => new Av1FrameAssembler({})).toThrow(/deSerialize and getFrame/);
  });

  it("buffers packets until the marker bit closes the temporal unit", () => {
    const a = new Av1FrameAssembler(fakes());
    expect(a.push(Buffer.from([1, 10]), false)).toBeNull(); // mid-TU
    expect(a.hasPending).toBe(true);
    const frame = a.push(Buffer.from([2, 20]), true); // marker → emit
    expect(frame).toEqual(Buffer.from([1, 10, 2, 20])); // both packets' bytes, in order
    expect(a.frames).toBe(1);
    expect(a.hasPending).toBe(false); // reset for the next TU
  });

  it("emits one frame per marker across consecutive TUs", () => {
    const a = new Av1FrameAssembler(fakes());
    expect(a.push(Buffer.from([1, 1]), true)).toEqual(Buffer.from([1, 1]));
    expect(a.push(Buffer.from([2, 2]), true)).toEqual(Buffer.from([2, 2]));
    expect(a.frames).toBe(2);
  });

  it("counts a keyframe once, at the TU's first packet (N bit)", () => {
    const a = new Av1FrameAssembler(fakes());
    a.push(Buffer.from([0xff, 0]), false); // keyframe start (N bit)
    a.push(Buffer.from([0x00, 1]), true); // continuation, marker
    expect(a.keyframes).toBe(1);
    a.push(Buffer.from([0x00, 2]), true); // inter frame → not a keyframe
    expect(a.keyframes).toBe(1);
  });

  it("drops a malformed packet without aborting the TU or throwing", () => {
    const a = new Av1FrameAssembler(fakes({ throwOnDeser: new Set([0x99]) }));
    expect(a.push(Buffer.from([0x99, 0]), false)).toBeNull(); // malformed → dropped
    expect(a.dropped).toBe(1);
    expect(a.hasPending).toBe(false); // it was skipped, not buffered
    const frame = a.push(Buffer.from([0x01, 5]), true); // the good TU still completes
    expect(frame).toEqual(Buffer.from([0x01, 5]));
    expect(a.frames).toBe(1);
  });

  it("drops a TU whose reassembly fails (lost fragment) and keeps recording", () => {
    const a = new Av1FrameAssembler(fakes({ throwOnGetFrame: true }));
    expect(a.push(Buffer.from([1, 0]), true)).toBeNull();
    expect(a.dropped).toBe(1);
    expect(a.frames).toBe(0);
    expect(a.hasPending).toBe(false); // pending cleared even on getFrame failure
  });
});
