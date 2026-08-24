// E-INGRESS receipt test — full ingest lifecycle proof through the real router state machine.
//
// Exercises the complete inbound ingest path with three source kinds:
//   1. RTMP push → routed to CF Stream Live (managed ingest) → provisions a live input
//   2. WHIP → routed to cfCallsSfu (native WebRTC) → admits a publish into the SFU
//   3. URL pull → routed to CF Stream Live → provisions with pull feed + SSRF guard required
//   4. RIST push → routed to containerBridge (backstop) → starts a container leg
//   5. Cost-ceiling rejection: RIST capped at managed rank → rejected, not escalated
//
// This is a HEADLESS receipt: mocked CF Stream API, mocked SFU, mocked container control plane,
// but exercises the REAL ingressRoute decision function, the REAL backend classes, and the
// REAL routing table. A live receipt requires an actual RTMP push or WHIP source — this is the
// closest automated equivalent.
//
// Born: E-INGRESS parity ledger row #2 arm crossing (2026-08-24).

import { describe, it, expect } from "vitest";
import { ingressRoute, type IngestJob } from "../src/ingress-router.js";
import {
  CfStreamLiveIngestBackend,
  buildCfStreamLiveFeed,
  ingressRouterEnabled,
  CF_STREAM_LIVE_INGEST_ID,
  type CfStreamLiveClient,
  type CfStreamLiveIngestRequest,
  type CfStreamLiveResult,
} from "../src/ingress-cf-stream-live.js";
import {
  WhipSfuIngestBackend,
  WHIP_SFU_INGEST_ID,
  type WhipSfuClient,
  type WhipPublishRequest,
  type WhipPublishResult,
} from "../src/ingress-whip-sfu.js";
import {
  ContainerBridgeIngestBackend,
  CONTAINER_BRIDGE_INGEST_ID,
  type ContainerBridgeClient,
  type ContainerBridgeStartRequest,
  type ContainerBridgeResult,
} from "../src/ingress-container-bridge.js";
import type { IngestSourceKind } from "../src/ingress-router.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const ORG = "org_ingress_receipt";
const ROOM = "room-e-ingress-receipt";

function cfStreamClient(
  reply: CfStreamLiveResult = { ok: true, input: { uid: "li-receipt-001", endpoints: [{ url: "rtmp://push.example.com/live/key", protocol: "rtmp" }] } },
): CfStreamLiveClient & { calls: CfStreamLiveIngestRequest[] } {
  const calls: CfStreamLiveIngestRequest[] = [];
  return {
    calls,
    async createLiveInput(req) {
      calls.push(req);
      return reply;
    },
  };
}

function whipSfuClient(
  reply: WhipPublishResult = { ok: true, session: { sdpAnswer: "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=whip-answer\r\n", resourceId: "whip-receipt-1" } },
): WhipSfuClient & { calls: WhipPublishRequest[] } {
  const calls: WhipPublishRequest[] = [];
  return {
    calls,
    async publish(req) {
      calls.push(req);
      return reply;
    },
  };
}

function containerBridgeClient(
  reply: ContainerBridgeResult = { ok: true, leg: { protocol: "rist", room: ROOM } },
): ContainerBridgeClient & { calls: ContainerBridgeStartRequest[] } {
  const calls: ContainerBridgeStartRequest[] = [];
  return {
    calls,
    async startBridge(req) {
      calls.push(req);
      return reply;
    },
  };
}

function rtmpJob(overrides: Partial<IngestJob> = {}): IngestJob {
  return { sourceKind: "rtmpPush", room: ROOM, ...overrides };
}

function whipJob(overrides: Partial<IngestJob> = {}): IngestJob {
  return { sourceKind: "whip", room: ROOM, ...overrides };
}

function urlPullJob(overrides: Partial<IngestJob> = {}): IngestJob {
  return { sourceKind: "urlPull", room: ROOM, sourceUrl: "https://broadcast.example.com/live/stream.m3u8", ...overrides };
}

function ristJob(overrides: Partial<IngestJob> = {}): IngestJob {
  return { sourceKind: "ristPush", room: ROOM, ...overrides };
}

// ── receipt ──────────────────────────────────────────────────────────────────

describe("E-INGRESS receipt: full ingest lifecycle through the real router", () => {
  // ── 1. RTMP push → CF Stream Live ──

  it("RTMP push: router → cfStreamLive → provisions live input with push feed", async () => {
    const job = rtmpJob();

    // Step 1: real router decides
    const decision = ingressRoute(job);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.backend).toBe("cfStreamLive");
    expect(decision.costRank).toBe(1);
    expect(decision.pushProtocol).toBe("rtmp");
    expect(decision.requiresSsrfGuard).toBe(false);

    // Step 2: real backend provisions with mocked CF Stream client
    const client = cfStreamClient();
    const backend = new CfStreamLiveIngestBackend(client);
    const outcome = await backend.provision(job, { org: ORG });
    expect(outcome.status).toBe("provisioned");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].room).toBe(ROOM);
    expect(client.calls[0].org).toBe(ORG);
    expect(client.calls[0].feed).toEqual({ mode: "push", protocol: "rtmp" });

    // Step 3: provisioned result carries the CF Stream input uid + push endpoints
    if (outcome.status === "provisioned" && outcome.result.ok) {
      expect(outcome.result.input.uid).toBe("li-receipt-001");
      expect(outcome.result.input.endpoints).toHaveLength(1);
      expect(outcome.result.input.endpoints[0].protocol).toBe("rtmp");
    }
  });

  // ── 2. WHIP → cfCallsSfu ──

  it("WHIP: router → cfCallsSfu → admits publish with SDP offer", async () => {
    const job = whipJob();
    const sdpOffer = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=whip-offer\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";

    // Step 1: real router decides
    const decision = ingressRoute(job);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.backend).toBe("cfCallsSfu");
    expect(decision.costRank).toBe(0);
    expect(decision.pushProtocol).toBeNull();
    expect(decision.requiresSsrfGuard).toBe(false);

    // Step 2: real backend admits with mocked SFU client
    const client = whipSfuClient();
    const backend = new WhipSfuIngestBackend(client);
    const outcome = await backend.admit(job, { org: ORG, sdpOffer });
    expect(outcome.status).toBe("admitted");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].room).toBe(ROOM);
    expect(client.calls[0].org).toBe(ORG);
    expect(client.calls[0].sdpOffer).toBe(sdpOffer);

    // Step 3: admitted result carries the SFU session + resource id
    if (outcome.status === "admitted" && outcome.result.ok) {
      expect(outcome.result.session.resourceId).toBe("whip-receipt-1");
      expect(outcome.result.session.sdpAnswer).toContain("whip-answer");
    }
  });

  // ── 3. URL pull → CF Stream Live with SSRF guard required ──

  it("URL pull: router → cfStreamLive → provisions with pull feed + SSRF guard flagged", async () => {
    const job = urlPullJob();

    // Step 1: real router decides
    const decision = ingressRoute(job);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.backend).toBe("cfStreamLive");
    expect(decision.pushProtocol).toBeNull();
    expect(decision.requiresSsrfGuard).toBe(true); // the critical security signal

    // Step 2: real backend provisions with pull feed
    const client = cfStreamClient();
    const backend = new CfStreamLiveIngestBackend(client);
    const outcome = await backend.provision(job, { org: ORG });
    expect(outcome.status).toBe("provisioned");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].feed).toEqual({ mode: "pull", sourceUrl: "https://broadcast.example.com/live/stream.m3u8" });

    // Step 3: provisioned result carries the CF Stream input
    if (outcome.status === "provisioned" && outcome.result.ok) {
      expect(outcome.result.input.uid).toBe("li-receipt-001");
    }
  });

  // ── 4. RIST push → containerBridge ──

  it("RIST push: router → containerBridge → starts container leg with inbound", async () => {
    const job = ristJob();
    const inbound = { host: "push.customer.example", port: 5004 };

    // Step 1: real router decides
    const decision = ingressRoute(job);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.backend).toBe("containerBridge");
    expect(decision.costRank).toBe(2);
    expect(decision.pushProtocol).toBe("rist");
    expect(decision.requiresSsrfGuard).toBe(false);

    // Step 2: real backend starts container leg with mocked client
    const client = containerBridgeClient();
    const backend = new ContainerBridgeIngestBackend(client);
    const outcome = await backend.admit(job, { org: ORG, inbound });
    expect(outcome.status).toBe("admitted");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].protocol).toBe("rist");
    expect(client.calls[0].room).toBe(ROOM);
    expect(client.calls[0].org).toBe(ORG);
    expect(client.calls[0].inbound).toEqual(inbound);

    // Step 3: admitted result carries the container leg
    if (outcome.status === "admitted" && outcome.result.ok) {
      expect(outcome.result.leg.protocol).toBe("rist");
      expect(outcome.result.leg.room).toBe(ROOM);
    }
  });

  // ── 5. Cost-ceiling rejection ──

  it("RIST push capped at managed rank: rejected, not escalated to container", () => {
    const job: IngestJob = { sourceKind: "ristPush", room: ROOM, maxCostRank: 1 };
    const decision = ingressRoute(job);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toMatch(/no capable ingest backend/);
      expect(decision.reason).toMatch(/containerBridge.*costRank 2 > ceiling 1/);
    }
  });

  // ── 6. Feed builder utility ──

  it("buildCfStreamLiveFeed maps all source kinds to the correct CF Stream feed shape", () => {
    expect(buildCfStreamLiveFeed(rtmpJob())).toEqual({ mode: "push", protocol: "rtmp" });
    expect(buildCfStreamLiveFeed({ sourceKind: "srtPush", room: ROOM })).toEqual({ mode: "push", protocol: "srt" });
    expect(buildCfStreamLiveFeed(urlPullJob())).toEqual({ mode: "pull", sourceUrl: "https://broadcast.example.com/live/stream.m3u8" });
    // WHIP and RIST don't go through CF Stream — feed builder returns null
    expect(buildCfStreamLiveFeed(whipJob())).toBeNull();
    expect(buildCfStreamLiveFeed(ristJob())).toBeNull();
  });

  // ── 7. Flag reader contract ──

  it("ingressRouterEnabled reads the shared flag strictly: only true/'1'/'true' arm it", () => {
    expect(ingressRouterEnabled({})).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "0" })).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "false" })).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "1" })).toBe(true);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "true" })).toBe(true);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: true })).toBe(true);
  });

  // ── 8. Backend ID constants ──

  it("each backend carries a stable identity constant", () => {
    expect(CF_STREAM_LIVE_INGEST_ID).toBe("ingress:cf-stream-live");
    expect(WHIP_SFU_INGEST_ID).toBe("ingress:whip-sfu");
    expect(CONTAINER_BRIDGE_INGEST_ID).toBe("ingress:container-bridge");
  });
});
