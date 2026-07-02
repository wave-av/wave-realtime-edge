// E-INGRESS P1 (#77) — the inbound-ingest decision core. Proves the epic's hard-gate: the router picks the CHEAPEST
// CAPABLE ingest plane first (native WHIP → managed CF Stream → self-hosted container), escalates only on need
// (RIST/MoQ, which CF Stream can't carry), honors a cost ceiling, maps LiveKit ingress modes onto wave-native source
// kinds, flags the URL-pull path as SSRF-guard-required, and rejects a malformed job with a reason (never a silent
// default). Pure engine, no env / clock / network.
import { describe, it, expect } from "vitest";
import {
  ingressRoute,
  validateIngestJob,
  mapLiveKitIngress,
  pushProtocolOf,
  INGEST_ROUTING_TABLE,
  INGEST_SOURCE_KINDS,
  LIVEKIT_INGRESS_MODES,
  type IngestJob,
  type IngestSourceKind,
} from "../src/ingress-router.js";

/** A job for a given source kind, into a valid room, with the pull URL auto-supplied for urlPull. */
function job(sourceKind: IngestSourceKind, overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    sourceKind,
    room: "room-1",
    ...(sourceKind === "urlPull" ? { sourceUrl: "https://src.example/live.m3u8" } : {}),
    ...overrides,
  };
}

describe("ingressRoute — cheapest capable plane first", () => {
  it("native WHIP → cfCallsSfu (most direct, no transcode)", () => {
    expect(ingressRoute(job("whip"))).toEqual({
      ok: true,
      backend: "cfCallsSfu",
      costRank: 0,
      protocol: null,
      requiresSsrfGuard: false,
    });
  });

  it("RTMP push → cfStreamLive (free managed ingest, NOT the owned container)", () => {
    const d = ingressRoute(job("rtmpPush"));
    expect(d).toMatchObject({ ok: true, backend: "cfStreamLive", costRank: 1, protocol: "rtmp" });
  });

  it("SRT push → cfStreamLive (caller-mode managed) over the also-capable container — cheapest-capable-first", () => {
    const d = ingressRoute(job("srtPush"));
    // the container tier can ALSO carry srt; the router must take the cheaper managed path.
    expect(d).toMatchObject({ ok: true, backend: "cfStreamLive", protocol: "srt" });
  });

  it("URL pull → cfStreamLive and flags requiresSsrfGuard (the only remote-fetch path)", () => {
    const d = ingressRoute(job("urlPull"));
    expect(d).toMatchObject({ ok: true, backend: "cfStreamLive", protocol: null, requiresSsrfGuard: true });
  });
});

describe("ingressRoute — escalation to the container only on need", () => {
  it("RIST push → containerBridge (CF Stream can't carry RIST)", () => {
    expect(ingressRoute(job("ristPush"))).toEqual({
      ok: true,
      backend: "containerBridge",
      costRank: 2,
      protocol: "rist",
      requiresSsrfGuard: false,
    });
  });

  it("MoQ push → containerBridge (CF Stream can't carry MoQ)", () => {
    expect(ingressRoute(job("moqPush"))).toMatchObject({ ok: true, backend: "containerBridge", protocol: "moq" });
  });
});

describe("ingressRoute — cost ceiling (maxCostRank)", () => {
  it("caps escalation: a RIST push capped at the managed rank is REJECTED, not silently sent to the container", () => {
    const d = ingressRoute(job("ristPush", { maxCostRank: 1 }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/containerBridge: costRank 2 > ceiling 1/);
  });

  it("a WHIP source under a rank-0 cap still routes to the SFU", () => {
    expect(ingressRoute(job("whip", { maxCostRank: 0 }))).toMatchObject({ ok: true, backend: "cfCallsSfu" });
  });

  it("an RTMP push capped at rank 0 (WHIP-only) is rejected — managed ingest is above the ceiling", () => {
    expect(ingressRoute(job("rtmpPush", { maxCostRank: 0 })).ok).toBe(false);
  });
});

describe("mapLiveKitIngress — legacy ingress modes → wave-native source kinds (E-DECOMMISSION cutover)", () => {
  it("maps the three LiveKit modes and every mapped kind is routable", () => {
    expect(mapLiveKitIngress("RTMP_INPUT")).toBe("rtmpPush");
    expect(mapLiveKitIngress("WHIP_INPUT")).toBe("whip");
    expect(mapLiveKitIngress("URL_INPUT")).toBe("urlPull");
    for (const mode of LIVEKIT_INGRESS_MODES) {
      expect(ingressRoute(job(mapLiveKitIngress(mode))).ok).toBe(true);
    }
  });
});

describe("pushProtocolOf — container-bridge handoff reuses the IngestProtocol SSOT", () => {
  it("push kinds map to their ingest-bridge protocol; WebRTC / URL kinds map to null", () => {
    expect(pushProtocolOf("rtmpPush")).toBe("rtmp");
    expect(pushProtocolOf("srtPush")).toBe("srt");
    expect(pushProtocolOf("ristPush")).toBe("rist");
    expect(pushProtocolOf("moqPush")).toBe("moq");
    expect(pushProtocolOf("whip")).toBeNull();
    expect(pushProtocolOf("urlPull")).toBeNull();
  });
});

describe("validateIngestJob — reject malformed jobs at the boundary", () => {
  it("an out-of-set sourceKind is rejected before routing (TS types don't guard parsed JSON)", () => {
    const bad = { ...job("whip"), sourceKind: "rtsp" } as unknown as IngestJob;
    expect(validateIngestJob(bad)).toMatch(/sourceKind must be one of/);
    expect(ingressRoute(bad).ok).toBe(false);
  });

  it("an unsafe/empty room is rejected (no injection into a DO id / container payload)", () => {
    expect(validateIngestJob(job("whip", { room: "" }))).toMatch(/room/);
    expect(validateIngestJob(job("whip", { room: "srt:evil" }))).toMatch(/room/); // reserved namespace separator
  });

  it("a urlPull without a sourceUrl is rejected; a push source WITH a sourceUrl is rejected", () => {
    expect(validateIngestJob({ sourceKind: "urlPull", room: "room-1" })).toMatch(/urlPull requires/);
    expect(validateIngestJob(job("rtmpPush", { sourceUrl: "https://x.example" }))).toMatch(/only valid for a urlPull/);
  });

  it("a negative cost ceiling is rejected", () => {
    expect(validateIngestJob(job("whip", { maxCostRank: -1 }))).toMatch(/maxCostRank/);
  });

  it("well-formed jobs validate to null", () => {
    expect(validateIngestJob(job("whip"))).toBeNull();
    expect(validateIngestJob(job("urlPull"))).toBeNull();
  });
});

describe("routing table integrity", () => {
  it("each tier's capability predicate is TOTAL and self-consistent (independent of walk order)", () => {
    const byBackend = Object.fromEntries(INGEST_ROUTING_TABLE.map((t) => [t.backend, t]));
    // cfCallsSfu carries ONLY whip; the other tiers never claim a whip job (it belongs to the SFU).
    expect(byBackend.cfCallsSfu!.capable(job("whip"))).toBeNull();
    expect(byBackend.cfCallsSfu!.capable(job("rtmpPush"))).not.toBeNull();
    expect(byBackend.cfStreamLive!.capable(job("whip"))).not.toBeNull();
    expect(byBackend.cfStreamLive!.capable(job("ristPush"))).not.toBeNull(); // CF Stream can't carry RIST
    expect(byBackend.containerBridge!.capable(job("whip"))).not.toBeNull(); // WebRTC is not a container push
    // the container is the push backstop: it accepts every push protocol.
    for (const k of ["rtmpPush", "srtPush", "ristPush", "moqPush"] as const)
      expect(byBackend.containerBridge!.capable(job(k))).toBeNull();
  });

  it("cost ranks are strictly ascending in table order (cheapest first)", () => {
    const ranks = INGEST_ROUTING_TABLE.map((t) => t.costRank);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });

  it("every valid source kind routes to some backend — the router never strands a valid job", () => {
    for (const sourceKind of INGEST_SOURCE_KINDS) {
      expect(ingressRoute(job(sourceKind)).ok).toBe(true);
    }
  });
});
