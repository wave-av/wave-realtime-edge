// Capability PARSER tests — fixtures only, NO ffmpeg spawn (CI has no GPU and must not shell out). Proves
// parseEncoders/parseHwaccels extract the right encoder/hwaccel sets from real `ffmpeg -encoders` output.
import { describe, it, expect } from "vitest";
import { parseEncoders, parseHwaccels } from "../server/capability.mjs";

// A host WITH hardware: NVENC (h264/hevc/av1), VideoToolbox (h264/hevc/prores), QuickSync av1.
const HW_ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libvpx               libvpx VP8 (codec vp8)
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 V..... libsvtav1            SVT-AV1 (codec av1)
 V....D libx264              libx264 H.264 (codec h264)
 V....D libx265              libx265 H.265 (codec hevc)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V....D av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 V....D prores_videotoolbox  VideoToolbox ProRes Encoder (codec prores)
 V....D av1_qsv              AV1 (Intel Quick Sync Video acceleration) (codec av1)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus (codec opus)
 A....D libmp3lame           libmp3lame MP3 (codec mp3)
 A....D flac                 FLAC (Free Lossless Audio Codec)
`;

// A software-only host (e.g. CF Containers x86 Linux): no *_nvenc / *_videotoolbox / *_qsv.
const SW_ONLY_ENCODERS = `Encoders:
 V..... = Video
 ------
 V....D libvpx               libvpx VP8 (codec vp8)
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 V..... libsvtav1            SVT-AV1 (codec av1)
 V....D libx264              libx264 H.264 (codec h264)
 V....D libx265              libx265 H.265 (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus (codec opus)
`;

const HWACCELS = `Hardware acceleration methods:
cuda
videotoolbox
qsv
vaapi
`;

describe("parseEncoders", () => {
  it("includes hardware encoders when the fixture has them", () => {
    const set = parseEncoders(HW_ENCODERS);
    expect(set.has("h264_nvenc")).toBe(true);
    expect(set.has("hevc_videotoolbox")).toBe(true);
    expect(set.has("av1_qsv")).toBe(true);
    expect(set.has("prores_videotoolbox")).toBe(true);
    // software too
    expect(set.has("libvpx")).toBe(true);
    expect(set.has("libopus")).toBe(true);
  });

  it("a software-only fixture yields ONLY software encoders (no hw)", () => {
    const set = parseEncoders(SW_ONLY_ENCODERS);
    expect(set.has("libvpx")).toBe(true);
    expect(set.has("libvpx-vp9")).toBe(true);
    expect(set.has("libsvtav1")).toBe(true);
    expect(set.has("libx264")).toBe(true);
    expect(set.has("libopus")).toBe(true);
    // none of the hardware encoders are present
    expect(set.has("h264_nvenc")).toBe(false);
    expect(set.has("hevc_videotoolbox")).toBe(false);
    expect(set.has("av1_qsv")).toBe(false);
  });

  it("ignores the header/legend block and the dashed separator", () => {
    const set = parseEncoders(HW_ENCODERS);
    // legend tokens like 'Video'/'Audio' from the header must NOT be parsed as encoder names
    expect(set.has("Video")).toBe(false);
    expect(set.has("=")).toBe(false);
  });

  it("returns an empty set for empty/garbage input", () => {
    expect(parseEncoders("").size).toBe(0);
    expect(parseEncoders(undefined).size).toBe(0);
  });
});

describe("parseHwaccels", () => {
  it("extracts each hwaccel method, skipping the header", () => {
    const set = parseHwaccels(HWACCELS);
    expect([...set].sort()).toEqual(["cuda", "qsv", "vaapi", "videotoolbox"]);
    expect(set.has("Hardware")).toBe(false);
  });
  it("empty input → empty set", () => {
    expect(parseHwaccels("").size).toBe(0);
  });
});
