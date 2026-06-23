// CapabilityDescriptor tests (#86 R1): the full descriptor composes encode (EXISTING) + decode + transports
// + region, and the /capabilities response stays BYTE-STABLE on its existing {hwaccels, codecs} keys while
// adding region/decode/transports/maxResFps. PURE — fixture sets, no ffmpeg, no Worker.
import { describe, it, expect } from "vitest";
import { buildCapabilityDescriptor, toCapabilitiesResponse, buildEncodeList } from "../server/descriptor.mjs";

const SW_ONLY = new Set(["libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libx265", "libopus", "aac"]);
const HW = new Set([...SW_ONLY, "h264_nvenc", "hevc_nvenc", "av1_nvenc"]);
const DECODE_AMPERE = new Set(["vp8", "vp9", "av1", "h264", "h265", "opus", "aac", "pcm"]);

describe("buildEncodeList — reuses selectEncoder over the registry", () => {
  it("software-only host: h264→libx264 (sw), av1→libsvtav1 (sw), all available", () => {
    const list = buildEncodeList(SW_ONLY);
    const h264 = list.find((c) => c.name === "h264");
    expect(h264.available).toBe(true);
    expect(h264.encoder).toBe("libx264");
    expect(h264.encoderKind).toBe("sw");
    const av1 = list.find((c) => c.name === "av1");
    expect(av1.encoder).toBe("libsvtav1");
  });
  it("hardware host: h264→h264_nvenc (hw)", () => {
    const list = buildEncodeList(HW);
    expect(list.find((c) => c.name === "h264").encoder).toBe("h264_nvenc");
    expect(list.find((c) => c.name === "h264").encoderKind).toBe("hw");
  });
  it("honest-fail: a codec with no available encoder is available:false (no substitution)", () => {
    const list = buildEncodeList(new Set(["libvpx", "libopus"])); // no h264/av1 encoder
    expect(list.find((c) => c.name === "h264").available).toBe(false);
    expect(list.find((c) => c.name === "vp8").available).toBe(true);
  });
});

describe("buildCapabilityDescriptor — full descriptor", () => {
  const d = buildCapabilityDescriptor({
    capability: { encoders: SW_ONLY, hwaccels: new Set(["vaapi"]) },
    decode: { decodeCodecs: DECODE_AMPERE },
    env: { RT_REGION: "us-east" },
  });
  it("carries region from env", () => expect(d.region).toBe("us-east"));
  it("encode + decode are separate lists (the asymmetry)", () => {
    expect(d.encode.find((c) => c.name === "av1").available).toBe(true); // SW SVT-AV1 encode
    expect(d.decode.find((c) => c.name === "av1").available).toBe(true); // AV1 decode
    expect(d.decode.find((c) => c.name === "prores").available).toBe(false); // not in DECODE_AMPERE
  });
  it("transports include ws-adapter activated + moq not-activated with a blocker", () => {
    const ws = d.transports.find((t) => t.protocol === "ws-adapter");
    const moq = d.transports.find((t) => t.protocol === "moq");
    expect(ws.activated).toBe(true);
    expect(moq.activated).toBe(false);
    expect(moq.blockers.length).toBeGreaterThan(0);
  });
  it("env can force-activate a transport (RT_TRANSPORT_MOQ=1)", () => {
    const d2 = buildCapabilityDescriptor({ capability: { encoders: SW_ONLY, hwaccels: new Set() }, decode: { decodeCodecs: DECODE_AMPERE }, env: { RT_REGION: "eu-west", RT_TRANSPORT_MOQ: "1" } });
    const moq = d2.transports.find((t) => t.protocol === "moq");
    expect(moq.activated).toBe(true);
    expect(moq.blockers).toEqual([]);
  });
  it("maxResFps defaults to {} when not supplied (selector treats absence as 'unknown')", () => {
    expect(d.maxResFps).toEqual({});
  });
});

describe("toCapabilitiesResponse — encode output BYTE-STABLE, new fields additive", () => {
  const d = buildCapabilityDescriptor({
    capability: { encoders: SW_ONLY, hwaccels: new Set(["vaapi", "cuda"]) },
    decode: { decodeCodecs: DECODE_AMPERE },
    env: { RT_REGION: "us-east" },
  });
  const resp = toCapabilitiesResponse(d);
  it("preserves the EXACT existing {hwaccels, codecs} shape per codec", () => {
    // The pre-#86 handler emitted exactly this per-codec shape. Re-derive it independently and compare.
    const expectedCodecs = {};
    for (const c of d.encode) {
      expectedCodecs[c.name] = c.available
        ? { media: c.media, available: true, encoder: c.encoder, encoderKind: c.encoderKind, accel: c.accel }
        : { media: c.media, available: false };
    }
    expect(resp.codecs).toEqual(expectedCodecs);
    expect(resp.hwaccels).toEqual(["vaapi", "cuda"]);
    // a client reading ONLY {hwaccels, codecs} sees an available h264→libx264 (sw) exactly as before.
    expect(resp.codecs.h264).toEqual({ media: "video", available: true, encoder: "libx264", encoderKind: "sw", accel: "none" });
    expect(resp.codecs.av1).toEqual({ media: "video", available: true, encoder: "libsvtav1", encoderKind: "sw", accel: "none" });
  });
  it("ADDS region/decode/transports/maxResFps without touching codecs", () => {
    expect(resp.region).toBe("us-east");
    expect(Array.isArray(resp.decode)).toBe(true);
    expect(Array.isArray(resp.transports)).toBe(true);
    expect(resp.maxResFps).toEqual({});
    // new keys are strictly additive — the old keys are unchanged.
    expect(Object.keys(resp)).toEqual(expect.arrayContaining(["hwaccels", "codecs", "region", "decode", "transports", "maxResFps"]));
  });
});
