// Command-builder tests: the DEFAULT path must emit the EXACT historical VP8/Opus command (byte-unchanged
// proof), and explicit target codecs must produce the correct `-c:v`/`-c:a <encoder>` + container args.
import { describe, it, expect } from "vitest";
import { buildCommand, DEFAULT_FFMPEG_ARGS } from "../server/command.mjs";
import { CodecUnavailableError } from "../server/select.mjs";

// The ORIGINAL hardcoded commands from the pre-matrix index.mjs — pinned here so any drift fails the test.
const ORIGINAL_JPEG = ["-hide_banner", "-loglevel", "error", "-f", "mjpeg", "-i", "-", "-c:v", "libvpx", "-f", "ivf", "-"];
const ORIGINAL_PCM = ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-c:a", "libopus", "-f", "ogg", "-"];

const HW = new Set(["libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libx265", "libopus", "aac", "h264_nvenc"]);

describe("buildCommand — DEFAULT path is byte-unchanged", () => {
  it("jpeg with NO target → exactly the original VP8/IVF command", () => {
    const cmd = buildCommand({ sourceCodec: "jpeg" });
    expect(cmd.args).toEqual(ORIGINAL_JPEG);
    expect(cmd.target).toBe("vp8");
    expect(cmd.encoder).toBe("libvpx");
    expect(cmd.container).toBe("ivf");
  });

  it("pcm with NO target → exactly the original Opus/Ogg command", () => {
    const cmd = buildCommand({ sourceCodec: "pcm" });
    expect(cmd.args).toEqual(ORIGINAL_PCM);
    expect(cmd.target).toBe("opus");
    expect(cmd.encoder).toBe("libopus");
    expect(cmd.container).toBe("ogg");
  });

  it("the DEFAULT_FFMPEG_ARGS constants themselves match the original commands", () => {
    expect(DEFAULT_FFMPEG_ARGS.jpeg).toEqual(ORIGINAL_JPEG);
    expect(DEFAULT_FFMPEG_ARGS.pcm).toEqual(ORIGINAL_PCM);
  });

  it("default path ignores capability (works even with an empty available set)", () => {
    const cmd = buildCommand({ sourceCodec: "jpeg", available: new Set() });
    expect(cmd.args).toEqual(ORIGINAL_JPEG);
  });
});

describe("buildCommand — explicit target codec", () => {
  it("jpeg → vp9 (software) builds -c:v libvpx-vp9 in a webm muxer", () => {
    const cmd = buildCommand({ sourceCodec: "jpeg", targetCodec: "vp9", available: HW });
    expect(cmd.args).toContain("-c:v");
    expect(cmd.args[cmd.args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(cmd.args.slice(-3)).toEqual(["-f", "webm", "-"]); // ends with -f webm -
    expect(cmd.container).toBe("webm");
    // input args preserved from the jpeg source
    expect(cmd.args).toContain("mjpeg");
  });

  it("jpeg → h264 with NVENC available → -c:v h264_nvenc, fragmented mp4 output", () => {
    const cmd = buildCommand({ sourceCodec: "jpeg", targetCodec: "h264", available: HW });
    expect(cmd.args[cmd.args.indexOf("-c:v") + 1]).toBe("h264_nvenc");
    expect(cmd.encoder).toBe("h264_nvenc");
    expect(cmd.kind).toBe("hw");
    expect(cmd.args).toContain("-movflags"); // fragmented mp4 for pipe streaming
    expect(cmd.container).toBe("mp4");
  });

  it("pcm → aac builds -c:a <aac encoder>", () => {
    const cmd = buildCommand({ sourceCodec: "pcm", targetCodec: "aac", available: HW });
    expect(cmd.args).toContain("-c:a");
    expect(cmd.args[cmd.args.indexOf("-c:a") + 1]).toBe("aac");
    expect(cmd.args).toContain("s16le"); // pcm input format preserved
  });

  it("jpeg → av1 with no av1 encoder available → honest-fail (throws, no substitution)", () => {
    const noav1 = new Set(["libvpx", "libx264", "libopus"]);
    expect(() => buildCommand({ sourceCodec: "jpeg", targetCodec: "av1", available: noav1 })).toThrow(
      CodecUnavailableError,
    );
  });

  it("unsupported SOURCE codec → throws", () => {
    // theora is not in the source allowlist (jpeg|pcm raw, or h264|vp8|vp9|av1|opus|aac encoded).
    expect(() => buildCommand({ sourceCodec: "theora" })).toThrow(/unsupported source codec/);
  });

  it("ENCODED source (h264) with NO target → throws (never re-emits source codec)", () => {
    // #86: h264 is now a valid ENCODED source, but cross-codec negotiation requires an explicit target —
    // there is no honest default (we won't silently re-encode h264→h264).
    expect(() => buildCommand({ sourceCodec: "h264" })).toThrow(/requires an explicit target codec/);
  });
});
