// Selection-policy tests (ADR §Capability detection + §Mux constraint): hardware-first, software fallback,
// honest-fail on an unavailable codec (NO silent substitution), and codec-aware container selection.
import { describe, it, expect } from "vitest";
import {
  selectEncoder,
  selectContainer,
  negotiateCodec,
  CodecUnavailableError,
  UnknownCodecError,
} from "../server/select.mjs";

const HW = new Set([
  "libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libx265", "libopus", "aac",
  "h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_videotoolbox", "hevc_videotoolbox",
]);
const SW_ONLY = new Set(["libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libx265", "libopus", "aac"]);
const NO_AV1 = new Set(["libvpx", "libx264", "libopus", "aac"]); // deliberately no av1 encoder of any kind

describe("selectEncoder — hardware preference", () => {
  it("H.264 with NVENC available → picks h264_nvenc (hardware)", () => {
    const sel = selectEncoder("video", "h264", HW);
    expect(sel.encoder).toBe("h264_nvenc");
    expect(sel.kind).toBe("hw");
    expect(sel.accel).toBe("nvenc");
    expect(sel.container).toBe("mp4");
  });

  it("H.264 on a software-only host → falls back to libx264 (software)", () => {
    const sel = selectEncoder("video", "h264", SW_ONLY);
    expect(sel.encoder).toBe("libx264");
    expect(sel.kind).toBe("sw");
    expect(sel.accel).toBe("none");
  });

  it("H.265 with VideoToolbox (no NVENC for it) → hevc_nvenc preferred when present", () => {
    // HW set has hevc_nvenc which is first in registry order → chosen over hevc_videotoolbox
    const sel = selectEncoder("video", "h265", HW);
    expect(sel.encoder).toBe("hevc_nvenc");
    expect(sel.kind).toBe("hw");
  });

  it("preferHardware:false forces the software encoder even when hardware exists", () => {
    const sel = selectEncoder("video", "h264", HW, { preferHardware: false });
    expect(sel.encoder).toBe("libx264");
    expect(sel.kind).toBe("sw");
  });

  it("VP9 software-only → libvpx-vp9", () => {
    const sel = selectEncoder("video", "vp9", SW_ONLY);
    expect(sel.encoder).toBe("libvpx-vp9");
    expect(sel.container).toBe("webm");
  });

  it("Opus → libopus (audio, software)", () => {
    const sel = selectEncoder("audio", "opus", HW);
    expect(sel.encoder).toBe("libopus");
    expect(sel.container).toBe("webm");
  });
});

describe("selectEncoder — honest-fail (NO silent substitution)", () => {
  it("AV1 with NO av1 encoder available → throws CodecUnavailableError (does not return another codec)", () => {
    expect(() => selectEncoder("video", "av1", NO_AV1)).toThrow(CodecUnavailableError);
    try {
      selectEncoder("video", "av1", NO_AV1);
    } catch (e) {
      expect(e.code).toBe("CODEC_UNAVAILABLE");
      expect(e.codec).toBe("av1");
      // it tried every av1 encoder and none were present — and it did NOT fall through to e.g. libvpx/libx264
      expect(e.tried).toContain("libsvtav1");
      expect(e.tried).toContain("av1_nvenc");
    }
  });

  it("unknown codec → UnknownCodecError", () => {
    expect(() => selectEncoder("video", "theora", HW)).toThrow(UnknownCodecError);
  });

  it("requesting an audio codec under kind=video → UnknownCodecError (media mismatch)", () => {
    expect(() => selectEncoder("video", "opus", HW)).toThrow(UnknownCodecError);
  });
});

describe("selectContainer — codec-aware muxer", () => {
  it("VP9 + Opus → webm", () => {
    expect(selectContainer("vp9", "opus")).toBe("webm");
  });
  it("VP8 + Opus → webm (the default recorder pairing)", () => {
    expect(selectContainer("vp8", "opus")).toBe("webm");
  });
  it("AV1 + Opus → webm", () => {
    expect(selectContainer("av1", "opus")).toBe("webm");
  });
  it("H.264 + AAC → mp4", () => {
    expect(selectContainer("h264", "aac")).toBe("mp4");
  });
  it("H.265 + AAC → mp4", () => {
    expect(selectContainer("h265", "aac")).toBe("mp4");
  });
  it("mismatched pairing (VP9 + AAC) → mkv fallback (never drops/transcodes audio)", () => {
    expect(selectContainer("vp9", "aac")).toBe("mkv");
  });
  it("H.264 + Opus → mkv fallback", () => {
    expect(selectContainer("h264", "opus")).toBe("mkv");
  });
  it("audio-only Opus → webm; audio-only AAC → mp4; audio-only FLAC → mkv", () => {
    expect(selectContainer(null, "opus")).toBe("webm");
    expect(selectContainer(null, "aac")).toBe("mp4");
    expect(selectContainer(null, "flac")).toBe("mkv");
  });
});

describe("negotiateCodec — scored fallback ladder (#86 P2)", () => {
  it("top preference available → depth 0, score 1.0, nothing demoted", () => {
    const n = negotiateCodec("video", ["av1", "vp9", "vp8"], SW_ONLY);
    expect(n.codec).toBe("av1");
    expect(n.encoder).toBe("libsvtav1");
    expect(n.depth).toBe(0);
    expect(n.score).toBe(1);
    expect(n.demoted).toEqual([]);
  });

  it("top unavailable → scores DOWN to the first working rung (never hard-fails on top)", () => {
    // no av1/vp9 encoder present → ladder demotes to vp8 (libvpx).
    const n = negotiateCodec("video", ["av1", "vp9", "vp8"], NO_AV1);
    expect(n.codec).toBe("vp8");
    expect(n.encoder).toBe("libvpx");
    expect(n.depth).toBe(2);
    expect(n.demoted).toEqual(["av1", "vp9"]);
    expect(n.score).toBeCloseTo(1 - 2 / 3); // 1 - depth/ladderLength
  });

  it("hardware preference still applies within the chosen rung", () => {
    const n = negotiateCodec("video", ["h264"], HW);
    expect(n.encoder).toBe("h264_nvenc");
    expect(n.kind).toBe("hw");
    expect(n.depth).toBe(0);
  });

  it("a single codec string is a one-rung ladder", () => {
    const n = negotiateCodec("audio", "opus", SW_ONLY);
    expect(n.codec).toBe("opus");
    expect(n.score).toBe(1);
  });

  it("unknown codecs in the ladder are skipped, not fatal", () => {
    const n = negotiateCodec("video", ["theora", "vp8"], SW_ONLY);
    expect(n.codec).toBe("vp8");
    expect(n.demoted).toEqual(["theora"]);
  });

  it("entire ladder unavailable → honest-fail (throws, never returns nothing)", () => {
    const noVideo = new Set(["libopus", "aac"]); // audio encoders only
    expect(() => negotiateCodec("video", ["av1", "vp9", "vp8", "h264"], noVideo)).toThrow(
      CodecUnavailableError,
    );
  });

  it("empty preference list → throws", () => {
    expect(() => negotiateCodec("video", [], SW_ONLY)).toThrow(/empty preference list/);
  });
});
