// Decode PROBE parser tests (#86 R1) — fixtures only, NO ffmpeg spawn (CI has no GPU, must not shell out).
// Proves parseDecoders/decodableCodecs extract decoder names + map them to registry codec keys, including
// the headline asymmetry: an Ampere fixture DECODES av1 (NVDEC) even though it cannot ENCODE av1.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDecoders, decodableCodecs } from "../server/decode.mjs";

const AMPERE = readFileSync(fileURLToPath(new URL("./fixtures/ffmpeg-decoders-ampere.txt", import.meta.url)), "utf8");
const H264_ONLY = readFileSync(fileURLToPath(new URL("./fixtures/ffmpeg-decoders-h264only.txt", import.meta.url)), "utf8");

describe("parseDecoders", () => {
  it("extracts decoder names past the header, including HW (cuvid) decoders", () => {
    const set = parseDecoders(AMPERE);
    expect(set.has("av1")).toBe(true);
    expect(set.has("av1_cuvid")).toBe(true); // Ampere NVDEC AV1 decode
    expect(set.has("libdav1d")).toBe(true);
    expect(set.has("h264")).toBe(true);
    expect(set.has("opus")).toBe(true);
  });
  it("ignores the legend block and the dashed separator", () => {
    const set = parseDecoders(AMPERE);
    expect(set.has("Video")).toBe(false);
    expect(set.has("=")).toBe(false);
  });
  it("empty/garbage input → empty set", () => {
    expect(parseDecoders("").size).toBe(0);
    expect(parseDecoders(undefined).size).toBe(0);
  });
});

describe("decodableCodecs — maps ffmpeg decoders to registry codec keys", () => {
  it("Ampere fixture decodes av1 + h265 (hevc→h265) + h264 + audio codecs", () => {
    const set = decodableCodecs(AMPERE);
    expect(set.has("av1")).toBe(true); // THE asymmetry: decodes AV1 …
    expect(set.has("h265")).toBe(true); // ffmpeg "hevc" → registry "h265"
    expect(set.has("h264")).toBe(true);
    expect(set.has("vp8")).toBe(true);
    expect(set.has("vp9")).toBe(true);
    expect(set.has("opus")).toBe(true);
    expect(set.has("aac")).toBe(true);
    expect(set.has("pcm")).toBe(true); // pcm_s16le → pcm
  });
  it("H.264-only fixture decodes ONLY h264 (+ its audio), NOT av1/hevc", () => {
    const set = decodableCodecs(H264_ONLY);
    expect(set.has("h264")).toBe(true);
    expect(set.has("av1")).toBe(false);
    expect(set.has("h265")).toBe(false);
    expect(set.has("opus")).toBe(true);
  });
  it("empty input → empty set", () => {
    expect(decodableCodecs("").size).toBe(0);
  });
});
