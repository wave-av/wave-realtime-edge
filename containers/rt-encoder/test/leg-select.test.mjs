// PER-LEG SELECTOR tests (#86 R2, design §3b/§3c) — the full negotiation matrix with FIXTURE descriptors
// (no GPU, no live calls). Honest-negative coverage: EVERY typed exclusion reason is exercised by ≥1 test.
import { describe, it, expect } from "vitest";
import { buildCapabilityDescriptor } from "../server/descriptor.mjs";
import { selectLeg, LegExclusionReason, CODEC_LADDER } from "../server/leg-select.mjs";

// ── descriptor fixtures ───────────────────────────────────────────────────────────────────────────────
const SW_ENC = new Set(["libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libx265", "libopus", "aac"]);
const HW_ENC = new Set([...SW_ENC, "h264_nvenc", "hevc_nvenc", "av1_nvenc"]);
const dec = (...codecs) => new Set(codecs);

/** Build a descriptor with a chosen encode set, decode set, transport overrides, and region. */
function node({ enc = SW_ENC, decode = dec("av1", "h265", "h264", "opus"), region = "us-east", transports = {} } = {}) {
  const env = { RT_REGION: region };
  for (const [p, on] of Object.entries(transports)) if (on) env[`RT_TRANSPORT_${p.toUpperCase().replace(/-/g, "_")}`] = "1";
  return buildCapabilityDescriptor({ capability: { encoders: enc, hwaccels: new Set() }, decode: { decodeCodecs: decode }, env });
}

// Both ends speak MoQ (default-off → force on) so transport doesn't shadow codec tests.
const moqOn = { moq: true };

describe("selectLeg — codec ladder (AV1 → HEVC → H.264)", () => {
  it("AV1-decode-capable dst + AV1-encode-capable runtime → picks AV1", () => {
    const src = node({ enc: HW_ENC, transports: moqOn });
    const dst = node({ decode: dec("av1", "h265", "h264"), transports: moqOn });
    const r = selectLeg(src, dst, {});
    expect(r.excluded).toBeUndefined();
    expect(r.encodeCodec).toBe("av1");
    expect(r.transport).toBe("moq");
    expect(r.container).toBe("webm");
  });

  it("dst drops AV1 decode → falls back to HEVC", () => {
    const src = node({ enc: HW_ENC, transports: moqOn });
    const dst = node({ decode: dec("h265", "h264"), transports: moqOn });
    expect(selectLeg(src, dst, {}).encodeCodec).toBe("hevc");
  });

  it("dst decodes H.264 only → falls back to H.264 (ladder narrows)", () => {
    const src = node({ enc: HW_ENC, transports: moqOn });
    const dst = node({ decode: dec("h264"), transports: moqOn });
    const r = selectLeg(src, dst, {});
    expect(r.encodeCodec).toBe("h264");
    expect(r.container).toBe("mp4");
  });

  it("ladder order is exactly [av1, hevc, h264]", () => {
    expect(CODEC_LADDER).toEqual(["av1", "hevc", "h264"]);
  });
});

describe("selectLeg — honest-negative: DST_DECODE_UNSUPPORTED (the asymmetric case)", () => {
  it("AV1-only source runtime + dst decodes H.264 only, no transcode runtime → EXCLUDED", () => {
    // Source can ONLY encode av1 (libsvtav1); dst decodes ONLY h264. No common codec → excluded.
    const src = node({ enc: new Set(["libsvtav1", "libopus"]), transports: moqOn });
    const dst = node({ decode: dec("h264"), transports: moqOn });
    const r = selectLeg(src, dst, {});
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe(LegExclusionReason.DST_DECODE_UNSUPPORTED);
  });
});

describe("selectLeg — honest-negative: CODEC_UNAVAILABLE", () => {
  it("no encode runtime can encode any ladder codec → EXCLUDED CODEC_UNAVAILABLE", () => {
    // src encodes neither av1/hevc/h264 (only vp8); dst decodes everything — but nothing can encode a
    // ladder codec → CODEC_UNAVAILABLE (distinct from dst not decoding).
    const src = node({ enc: new Set(["libvpx", "libopus"]), transports: moqOn });
    const dst = node({ decode: dec("av1", "h265", "h264"), transports: moqOn });
    const r = selectLeg(src, dst, {});
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe(LegExclusionReason.CODEC_UNAVAILABLE);
  });
});

describe("selectLeg — honest-negative: NO_COMMON_TRANSPORT", () => {
  it("ends list DISJOINT transports (no overlap) → EXCLUDED", () => {
    // A real rt-encoder node lists the full transport set, but a partial endpoint (e.g. a browser that
    // only does whip/whep, or a bridge that only does srt) may not. Construct genuinely disjoint lists:
    // src lists only ll-hls (activated), dst lists only srt (activated) → zero shared ladder transport.
    const src = { ...node({ enc: HW_ENC }), transports: [{ protocol: "ll-hls", activated: true, blockers: [] }] };
    const dst = { ...node({}), transports: [{ protocol: "srt", activated: true, blockers: [] }] };
    const r = selectLeg(src, dst, {});
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe(LegExclusionReason.NO_COMMON_TRANSPORT);
  });
});

describe("selectLeg — honest-negative: TRANSPORT_NOT_ACTIVATED", () => {
  it("both ends LIST a shared transport but it is not activated on both → EXCLUDED", () => {
    // Both list moq (it's in every descriptor) but neither activates it → shared-but-inactive.
    const src = node({ enc: HW_ENC }); // moq present, activated:false
    const dst = node({}); // moq present, activated:false
    const r = selectLeg(src, dst, {});
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe(LegExclusionReason.TRANSPORT_NOT_ACTIVATED);
  });
});

describe("selectLeg — honest-negative: REGION_PLACEMENT_VIOLATION (live legs)", () => {
  it("cross-continent LIVE leg → EXCLUDED", () => {
    const src = node({ enc: HW_ENC, region: "us-east", transports: moqOn });
    const dst = node({ region: "eu-west", transports: moqOn });
    const r = selectLeg(src, dst, { live: true });
    expect(r.excluded).toBe(true);
    expect(r.reason).toBe(LegExclusionReason.REGION_PLACEMENT_VIOLATION);
  });
  it("cross-continent NON-live leg is allowed (placement only enforced for live)", () => {
    const src = node({ enc: HW_ENC, region: "us-east", transports: moqOn });
    const dst = node({ region: "eu-west", transports: moqOn });
    expect(selectLeg(src, dst, { live: false }).excluded).toBeUndefined();
  });
  it("same-continent live leg passes", () => {
    const src = node({ enc: HW_ENC, region: "us-east", transports: moqOn });
    const dst = node({ region: "us-west", transports: moqOn });
    expect(selectLeg(src, dst, { live: true }).excluded).toBeUndefined();
  });
});

describe("selectLeg — objective scoring (deterministic)", () => {
  it("HW-encode + local + MoQ scores BELOW SW-encode + cross-continent + HLS", () => {
    // Tuple A: src self-HW (av1_nvenc), local, MoQ, same continent.
    const srcA = node({ enc: HW_ENC, region: "us-east", transports: moqOn });
    const dstA = node({ region: "us-west", transports: moqOn });
    const a = selectLeg(srcA, dstA, { live: false });

    // Tuple B: SW-only encode, cross-continent, only LL-HLS shared+activated.
    const srcB = node({ enc: SW_ENC, region: "us-east", transports: { "ll-hls": true } });
    const dstB = node({ region: "eu-west", transports: { "ll-hls": true } });
    const b = selectLeg(srcB, dstB, { live: false });

    expect(a.excluded).toBeUndefined();
    expect(b.excluded).toBeUndefined();
    expect(a.transport).toBe("moq");
    expect(b.transport).toBe("ll-hls");
    expect(a.score).toBeLessThan(b.score); // HW-local-MoQ cheaper + lower-latency than SW-cross-HLS
  });

  it("scoring is deterministic (same inputs → same score)", () => {
    const src = node({ enc: HW_ENC, transports: moqOn });
    const dst = node({ transports: moqOn });
    expect(selectLeg(src, dst, {}).score).toBe(selectLeg(src, dst, {}).score);
  });
});

describe("selectLeg — transport ladder prefers MoQ over SRT", () => {
  it("both moq and srt activated → picks moq (lowest latency rung)", () => {
    const src = node({ enc: HW_ENC, transports: { moq: true, srt: true } });
    const dst = node({ transports: { moq: true, srt: true } });
    expect(selectLeg(src, dst, {}).transport).toBe("moq");
  });
  it("only srt activated on both → picks srt", () => {
    const src = node({ enc: HW_ENC, transports: { srt: true } });
    const dst = node({ transports: { srt: true } });
    expect(selectLeg(src, dst, {}).transport).toBe("srt");
  });
});
