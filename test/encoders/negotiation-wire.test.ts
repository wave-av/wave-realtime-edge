// #135 — REAL-SESSION negotiation wiring tests. Proves the recorder /encode caller now actually drives the
// #86 negotiation path that PR #123 added on the server:
//   (a) FLAG-OFF ⇒ encodeInit attaches NO x-dst-capabilities header → the request is BYTE-IDENTICAL to today.
//   (b) FLAG-ON  ⇒ encodeInit emits a well-formed descriptor the REAL server parser (negotiate.mjs) accepts,
//       and selectLeg (leg-select.mjs) negotiates a leg from it (not a synthetic stub — the actual server code).
// The container fetch is mocked exactly as recorder-target.test.ts does (inject fetchImpl; capture headers).
import { describe, it, expect } from "vitest";
import { SelfHostTarget, type FrameMeta, type DstCapabilityDescriptor } from "../../src/encoders/recorder-target.js";
import { consumerDescriptor, negotiationArmed } from "../../src/encoders/consumer-caps.js";
// Import the REAL server-side parser + selector so the test proves cross-module shape agreement, not a copy.
import { parseDstDescriptor, negotiateTargetCodec } from "../../containers/rt-encoder/server/negotiate.mjs";

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const vp8 = Uint8Array.from([0x9d, 0x01, 0x2a, 4, 5]);

function captureFetch(): { calls: Array<{ url: string; init?: RequestInit }>; impl: (u: string, i?: RequestInit) => Promise<Response> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(vp8 as unknown as BodyInit, { status: 200 });
  };
  return { calls, impl };
}

describe("#135 negotiation wiring — flag-OFF is byte-identical", () => {
  it("FLAG-OFF: even with a dst descriptor present, NO x-dst-capabilities header is sent", async () => {
    const { calls, impl } = captureFetch();
    const t = new SelfHostTarget("https://studio:8080", impl);
    const dst = consumerDescriptor({ NEGOTIATION_ENABLED: "false", RT_CONSUMER_DECODE: "av1" });
    // negotiate:false (or absent) → header omitted regardless of a present descriptor.
    const meta: FrameMeta = { kind: "video", ts: 33, codec: "jpeg", negotiate: false, dst };
    await t.encode(jpeg, meta);
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h["x-dst-capabilities"]).toBeUndefined();
    expect(h["x-live"]).toBeUndefined();
    // Byte-identical proof: the exact legacy header set, nothing more.
    expect(Object.keys(h).sort()).toEqual(["content-type", "x-codec", "x-kind", "x-ts"]);
  });

  it("negotiate flag absent entirely → also byte-identical (no header)", async () => {
    const { calls, impl } = captureFetch();
    const t = new SelfHostTarget("https://studio:8080", impl);
    await t.encode(jpeg, { kind: "video", ts: 1, codec: "jpeg" });
    const h = calls[0].init!.headers as Record<string, string>;
    expect(Object.keys(h).sort()).toEqual(["content-type", "x-codec", "x-kind", "x-ts"]);
  });
});

describe("#135 negotiation wiring — flag-ON emits a server-parseable descriptor", () => {
  const env = { NEGOTIATION_ENABLED: "true", RT_REGION: "us-east", RT_CONSUMER_DECODE: "av1,h264", RT_CONSUMER_TRANSPORTS: "moq" };

  it("negotiationArmed reads the flag (default-off)", () => {
    expect(negotiationArmed({})).toBe(false);
    expect(negotiationArmed({ NEGOTIATION_ENABLED: "true" })).toBe(true);
    expect(negotiationArmed({ NEGOTIATION_ENABLED: "1" })).toBe(false); // strict "true" only
  });

  it("FLAG-ON: encodeInit attaches x-dst-capabilities (base64) the REAL server parser decodes back", async () => {
    const { calls, impl } = captureFetch();
    const t = new SelfHostTarget("https://studio:8080", impl);
    const dst = consumerDescriptor(env);
    const meta: FrameMeta = { kind: "video", ts: 33, codec: "jpeg", negotiate: true, dst, live: true };
    await t.encode(jpeg, meta);
    const h = calls[0].init!.headers as Record<string, string>;
    expect(typeof h["x-dst-capabilities"]).toBe("string");
    expect(h["x-live"]).toBe("1");
    // The REAL server parser accepts it and round-trips the exact descriptor shape.
    const parsed = parseDstDescriptor(h["x-dst-capabilities"]) as DstCapabilityDescriptor;
    expect(parsed.region).toBe("us-east");
    expect(parsed.decode).toEqual([
      { name: "av1", available: true },
      { name: "h264", available: true },
    ]);
    expect(parsed.transports).toEqual([{ protocol: "moq", activated: true }]);
  });

  it("FLAG-ON: the sourced descriptor actually negotiates a leg on the real selector (not just parses)", async () => {
    const dst = consumerDescriptor(env); // consumer decodes av1 + h264, speaks moq
    // src = a host that can encode av1 (hw) and speaks moq → expect a negotiated leg, not an exclusion.
    const src = {
      region: "us-west",
      encode: [{ name: "av1", media: "video", available: true, encoder: "av1_nvenc", encoderKind: "hw", accel: "cuda" }],
      decode: [],
      transports: [{ protocol: "moq", activated: true }],
    };
    const result = negotiateTargetCodec(src, dst, { live: false });
    expect(result.negotiated).toBe(true);
    if (!result.negotiated) throw new Error(`expected a negotiated leg, got ${result.reason}`);
    expect(result.targetCodec).toBe("av1");
    expect(result.transport).toBe("moq");
  });

  it("default baseline (no overrides) → VP8-decodable over local transport (safe, server-parseable)", () => {
    const dst = consumerDescriptor({ NEGOTIATION_ENABLED: "true" });
    expect(dst.decode).toEqual([{ name: "vp8", available: true }]);
    expect(dst.transports).toEqual([{ protocol: "moq", activated: true }]);
    expect(dst.region).toBeUndefined();
    // Server parser accepts the baseline too.
    const json = parseDstDescriptor(btoa(JSON.stringify(dst)));
    expect(json).toEqual(dst);
  });
});
