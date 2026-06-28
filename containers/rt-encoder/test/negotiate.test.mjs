// NEGOTIATION WIRING tests (#86 R3) — prove the default-OFF flag gate, the descriptor parse contract, the
// flag-ON codec negotiation, and the honest-fail on no-viable-leg. PURE (no HTTP, no ffmpeg): mirrors the
// leg-select fixtures so the wiring is verified against the same capability surfaces the selector uses.
import { describe, it, expect } from "vitest";
import { buildCapabilityDescriptor } from "../server/descriptor.mjs";
import { LegExclusionReason } from "../server/leg-select.mjs";
import {
  negotiationEnabled,
  parseDstDescriptor,
  negotiateTargetCodec,
  NegotiationInputError,
} from "../server/negotiate.mjs";

const SW_ENC = new Set(["libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libx265", "libopus", "aac"]);
const HW_ENC = new Set([...SW_ENC, "h264_nvenc", "hevc_nvenc", "av1_nvenc"]);
const dec = (...c) => new Set(c);

function node({ enc = SW_ENC, decode = dec("av1", "h265", "h264", "opus"), region = "us-east", transports = {} } = {}) {
  const env = { RT_REGION: region };
  for (const [p, on] of Object.entries(transports)) if (on) env[`RT_TRANSPORT_${p.toUpperCase().replace(/-/g, "_")}`] = "1";
  return buildCapabilityDescriptor({ capability: { encoders: enc, hwaccels: new Set() }, decode: { decodeCodecs: decode }, env });
}
const moqOn = { moq: true };
const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

describe("negotiationEnabled — default-OFF gate", () => {
  it("absent → false", () => expect(negotiationEnabled({})).toBe(false));
  it('"false" → false', () => expect(negotiationEnabled({ NEGOTIATION_ENABLED: "false" })).toBe(false));
  it('arbitrary value → false (only literal "true" opts in)', () =>
    expect(negotiationEnabled({ NEGOTIATION_ENABLED: "1" })).toBe(false));
  it('"true" (any case) → true', () => {
    expect(negotiationEnabled({ NEGOTIATION_ENABLED: "true" })).toBe(true);
    expect(negotiationEnabled({ NEGOTIATION_ENABLED: "TRUE" })).toBe(true);
  });
});

describe("parseDstDescriptor — request descriptor parse contract", () => {
  it("absent header → null (caller falls through to legacy behavior)", () => {
    expect(parseDstDescriptor(undefined)).toBeNull();
    expect(parseDstDescriptor("")).toBeNull();
    expect(parseDstDescriptor("   ")).toBeNull();
  });
  it("valid base64 JSON object → parsed descriptor", () => {
    const d = node({ transports: moqOn });
    expect(parseDstDescriptor(b64(d))).toMatchObject({ region: "us-east" });
  });
  it("present-but-non-JSON → NegotiationInputError (never silently skipped)", () => {
    const notJson = Buffer.from("not json", "utf8").toString("base64");
    expect(() => parseDstDescriptor(notJson)).toThrow(NegotiationInputError);
  });
  it("present-but-non-object JSON → NegotiationInputError", () => {
    expect(() => parseDstDescriptor(b64(42))).toThrow(NegotiationInputError);
  });
});

describe("negotiateTargetCodec — flag-ON drives the codec", () => {
  it("AV1-capable both ends → negotiates av1 (registry key), carries transport", () => {
    const src = node({ enc: HW_ENC, transports: moqOn });
    const dst = node({ decode: dec("av1", "h265", "h264"), transports: moqOn });
    const r = negotiateTargetCodec(src, dst, {});
    expect(r.negotiated).toBe(true);
    expect(r.targetCodec).toBe("av1");
    expect(r.transport).toBe("moq");
  });
  it("dst drops AV1 → HEVC negotiated, mapped to registry key h265 (NOT ladder name 'hevc')", () => {
    const src = node({ enc: HW_ENC, transports: moqOn });
    const dst = node({ decode: dec("h265", "h264"), transports: moqOn });
    const r = negotiateTargetCodec(src, dst, {});
    expect(r.negotiated).toBe(true);
    expect(r.targetCodec).toBe("h265");
  });
});

describe("negotiateTargetCodec — HONEST-FAIL (no silent downgrade)", () => {
  it("dst decodes nothing the src can encode → negotiated:false with TYPED reason", () => {
    const src = node({ enc: new Set(["libsvtav1", "libopus"]), transports: moqOn });
    const dst = node({ decode: dec("h264"), transports: moqOn });
    const r = negotiateTargetCodec(src, dst, {});
    expect(r.negotiated).toBe(false);
    expect(r.reason).toBe(LegExclusionReason.DST_DECODE_UNSUPPORTED);
  });
  it("cross-continent LIVE leg → negotiated:false REGION_PLACEMENT_VIOLATION", () => {
    const src = node({ enc: HW_ENC, region: "us-east", transports: moqOn });
    const dst = node({ region: "eu-west", transports: moqOn });
    const r = negotiateTargetCodec(src, dst, { live: true });
    expect(r.negotiated).toBe(false);
    expect(r.reason).toBe(LegExclusionReason.REGION_PLACEMENT_VIOLATION);
  });
});
