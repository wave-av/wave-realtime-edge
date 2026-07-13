import { describe, it, expect } from "vitest";
import {
  routeCodec,
  isMediaRecorderSafe,
  codecFromPayloadType,
  normalizeCodecName,
  CODEC_DESCRIPTORS,
} from "../server/codec-select.mjs";

describe("routeCodec — codec-complete routing (#153)", () => {
  it("routes the PROVEN codecs to werift MediaRecorder", () => {
    for (const c of ["VP8", "VP9", "H264", "OPUS"]) {
      const r = routeCodec(c);
      expect(r.supported).toBe(true);
      expect(r.recorder).toBe("mediarecorder");
    }
  });

  it("routes AV1 to native-transcode (werift MediaRecorder hangs on AV1)", () => {
    const r = routeCodec("AV1");
    expect(r.supported).toBe(true);
    expect(r.recorder).toBe("native-transcode");
    expect(r.reason).toMatch(/hang/i);
  });

  it("routes H265/HEVC to native-transcode (werift gap)", () => {
    expect(routeCodec("H265").recorder).toBe("native-transcode");
    expect(routeCodec("HEVC").recorder).toBe("native-transcode");
  });

  it("honest-fails an unknown codec (never guesses)", () => {
    const r = routeCodec("VP42");
    expect(r.supported).toBe(false);
    expect(r.recorder).toBe(null);
  });

  it("normalizes case and video/ audio/ prefixes", () => {
    expect(normalizeCodecName("video/vp8")).toBe("VP8");
    expect(normalizeCodecName(" audio/OPUS ")).toBe("OPUS");
    expect(routeCodec("video/vp9").recorder).toBe("mediarecorder");
  });

  it("isMediaRecorderSafe matches the routing", () => {
    expect(isMediaRecorderSafe("VP8")).toBe(true);
    expect(isMediaRecorderSafe("AV1")).toBe(false);
    expect(isMediaRecorderSafe("nope")).toBe(false);
  });
});

describe("codecFromPayloadType — pick codec from a negotiated offer", () => {
  it("maps each descriptor's payloadType back to its name", () => {
    for (const [name, d] of Object.entries(CODEC_DESCRIPTORS)) {
      expect(codecFromPayloadType(d.payloadType)).toBe(name);
    }
  });
  it("returns null for an unmapped payloadType", () => {
    expect(codecFromPayloadType(200)).toBe(null);
  });
});
