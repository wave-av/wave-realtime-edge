// #83/#75 — AV1-DEFAULT master-encode profile. Proves: FULLY INERT without AV1_DEFAULT (the default encode
// profile is byte-identical — target:null → jpeg→VP8); with AV1_DEFAULT armed, the eligible VIDEO frame
// source (jpeg) defaults to AV1 when the host has an AV1 encoder, surfaces a VISIBLE H.264 fallback reason
// when it does not, and keeps the proven VP8 default when neither is encodable; audio (pcm) is never
// AV1-defaulted; an explicit target still wins. PURE — no ffmpeg/process spawned.
import { describe, it, expect } from "vitest";
import { selectEncodeProfile, av1DefaultEnabled, buildCommand } from "../server/command.mjs";

const AV1_ENCODERS = new Set(["libsvtav1", "libvpx", "libopus", "libx264"]);
const NO_AV1 = new Set(["libvpx", "libopus", "libx264"]);
const NO_VIDEO = new Set(["libopus"]);

describe("av1DefaultEnabled flag (default-off)", () => {
  // Matches the repo's standing truthy-flag convention (residencyEnabled/cascadeEnabled): OFF only for
  // absent/empty/"0"/"false"; any other explicit value is ON (operators set "1").
  it("is off for absent/empty/0/false", () => {
    for (const v of [undefined, "", "0", "false", "FALSE", null]) {
      expect(av1DefaultEnabled({ AV1_DEFAULT: v })).toBe(false);
    }
  });
  it("is on for 1/true (case-insensitive) and boolean true", () => {
    for (const v of ["1", "true", "TRUE", true]) {
      expect(av1DefaultEnabled({ AV1_DEFAULT: v })).toBe(true);
    }
  });
});

describe("selectEncodeProfile INERT (AV1_DEFAULT off)", () => {
  it("returns the unchanged default (target null) even with an AV1 encoder present", () => {
    expect(selectEncodeProfile("jpeg", AV1_ENCODERS, {})).toEqual({ target: null, profile: "default" });
  });
  it("buildCommand on that null target is the proven byte-identical jpeg→VP8 default", () => {
    const { target: t } = selectEncodeProfile("jpeg", AV1_ENCODERS, {});
    const cmd = buildCommand({ sourceCodec: "jpeg", targetCodec: t });
    expect(cmd.target).toBe("vp8");
    expect(cmd.encoder).toBe("libvpx");
    expect(cmd.args).toContain("libvpx");
    expect(cmd.args).not.toContain("libsvtav1");
  });
});

describe("selectEncodeProfile ARMED (AV1_DEFAULT=1)", () => {
  const ENV = { AV1_DEFAULT: "1" };

  it("defaults the eligible jpeg video source to AV1 when the host can encode it", () => {
    expect(selectEncodeProfile("jpeg", AV1_ENCODERS, ENV)).toEqual({ target: "av1", profile: "av1-default" });
  });

  it("buildCommand on the AV1 target actually selects an AV1 encoder", () => {
    const { target } = selectEncodeProfile("jpeg", AV1_ENCODERS, ENV);
    const cmd = buildCommand({ sourceCodec: "jpeg", targetCodec: target, available: AV1_ENCODERS });
    expect(cmd.target).toBe("av1");
    expect(cmd.encoder).toBe("libsvtav1");
    expect(cmd.args).toContain("libsvtav1");
  });

  it("VISIBLE H.264 fallback (with reason) when the host has NO av1 encoder", () => {
    const p = selectEncodeProfile("jpeg", NO_AV1, ENV);
    expect(p.target).toBe("h264");
    expect(p.profile).toBe("av1-default");
    expect(p.fallbackReason).toMatch(/av1 encoder unavailable/i);
  });

  it("keeps the proven VP8 default when neither av1 nor h264 is encodable (never fabricate)", () => {
    const p = selectEncodeProfile("jpeg", NO_VIDEO, ENV);
    expect(p.target).toBeNull();
    expect(p.profile).toBe("default");
    expect(p.fallbackReason).toMatch(/kept default vp8/i);
  });

  it("does NOT AV1-default an audio source (pcm) — AV1 is a video codec", () => {
    expect(selectEncodeProfile("pcm", AV1_ENCODERS, ENV)).toEqual({ target: null, profile: "default" });
  });
});
