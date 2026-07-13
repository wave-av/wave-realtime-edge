// Zoom RTMS video transcode (#88 WAVE_RTMS_VIDEO ingest leg) — JPEG passthrough + validation.
import { describe, it, expect } from "vitest";
import { isLikelyJpeg, rtmsVideoToSfuJpeg, RtmsVideoError } from "../src/rtms-video.js";

const JPEG_LIKE = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);

describe("isLikelyJpeg", () => {
  it("true for bytes starting with the JPEG SOI marker (0xFFD8)", () => {
    expect(isLikelyJpeg(JPEG_LIKE)).toBe(true);
  });

  it("false for non-JPEG bytes and for too-short input", () => {
    expect(isLikelyJpeg(Uint8Array.from([0, 1, 2]))).toBe(false);
    expect(isLikelyJpeg(Uint8Array.from([0xff]))).toBe(false);
    expect(isLikelyJpeg(new Uint8Array(0))).toBe(false);
  });
});

describe("rtmsVideoToSfuJpeg", () => {
  it("passes a valid JPEG-framed payload through unchanged", () => {
    const out = rtmsVideoToSfuJpeg(JPEG_LIKE);
    expect(Array.from(out)).toEqual(Array.from(JPEG_LIKE));
  });

  it("throws RtmsVideoError on an empty frame", () => {
    expect(() => rtmsVideoToSfuJpeg(new Uint8Array(0))).toThrow(RtmsVideoError);
  });

  it("throws RtmsVideoError on a non-JPEG frame (missing SOI marker)", () => {
    expect(() => rtmsVideoToSfuJpeg(Uint8Array.from([1, 2, 3, 4]))).toThrow(RtmsVideoError);
  });
});
