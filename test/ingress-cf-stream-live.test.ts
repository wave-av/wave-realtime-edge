// E-INGRESS P2 (#77) — the CF Stream Live ingest backend. Proves the backend OWNS EXACTLY the `cfStreamLive` plane:
// it provisions a live input (carrying the caller's room + org + the right feed) when the router routes there,
// DEFERS every other verdict (never provisioning a source routed to the SFU or the container), refuses a job that
// can't be bridged (malformed / missing org), and stays inert until the flag is armed. Pure engine + an injected
// fake client — no CF API, no KV, no clock.
import { describe, it, expect } from "vitest";
import {
  CfStreamLiveIngestBackend,
  buildCfStreamLiveFeed,
  ingressRouterEnabled,
  CF_STREAM_LIVE_INGEST_ID,
  type CfStreamLiveClient,
  type CfStreamLiveIngestRequest,
  type CfStreamLiveResult,
} from "../src/ingress-cf-stream-live.js";
import type { IngestJob, IngestSourceKind } from "../src/ingress-router.js";

/** A fake origin: records the create-input requests it received and returns a canned input (or a canned non-2xx). */
function fakeClient(
  reply: CfStreamLiveResult = { ok: true, input: { uid: "li-abc123", endpoints: [] } },
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

/** An ingest job for a given source kind into a valid room, with the pull URL auto-supplied for urlPull. */
function job(sourceKind: IngestSourceKind, overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    sourceKind,
    room: "room-1",
    ...(sourceKind === "urlPull" ? { sourceUrl: "https://src.example/live.m3u8" } : {}),
    ...overrides,
  };
}

const CTX = { org: "org-acme" };

describe("CfStreamLiveIngestBackend — owns the cfStreamLive plane, defers the rest", () => {
  it("provisions an RTMP push, passing room + org + the rtmp push feed to the client", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    const outcome = await be.provision(job("rtmpPush"), CTX);
    expect(outcome.status).toBe("provisioned");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({ room: "room-1", org: "org-acme", feed: { mode: "push", protocol: "rtmp" } });
    if (outcome.status === "provisioned" && outcome.result.ok) expect(outcome.result.input.uid).toBe("li-abc123");
  });

  it("provisions an SRT push with the srt push feed", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    await be.provision(job("srtPush"), CTX);
    expect(client.calls[0]!.feed).toEqual({ mode: "push", protocol: "srt" });
  });

  it("provisions a URL pull with the pull feed carrying the source URL", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    await be.provision(job("urlPull", { sourceUrl: "https://src.example/live.m3u8" }), CTX);
    expect(client.calls[0]!.feed).toEqual({ mode: "pull", sourceUrl: "https://src.example/live.m3u8" });
  });

  it("surfaces a non-2xx origin reply (e.g. CF API 401) without mistaking it for a provisioned input", async () => {
    const client = fakeClient({ ok: false, status: 401, reason: "cf api unauthorized" });
    const be = new CfStreamLiveIngestBackend(client);
    const outcome = await be.provision(job("rtmpPush"), CTX);
    expect(outcome.status).toBe("provisioned");
    if (outcome.status === "provisioned") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(401);
    }
  });

  it("DEFERS a native WHIP source to cfCallsSfu — never provisions a CF Stream input for it", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    expect(await be.provision(job("whip"), CTX)).toEqual({ status: "deferred", backend: "cfCallsSfu" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS RIST / MoQ push to the containerBridge backstop (CF Stream can't carry them)", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    expect(await be.provision(job("ristPush"), CTX)).toEqual({ status: "deferred", backend: "containerBridge" });
    expect(await be.provision(job("moqPush"), CTX)).toEqual({ status: "deferred", backend: "containerBridge" });
    expect(client.calls).toHaveLength(0);
  });
});

describe("CfStreamLiveIngestBackend — refuses a job that could never be bridged", () => {
  it("is `unroutable` for a malformed job (unsafe room) — never provisions on garbage", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    const outcome = await be.provision(job("rtmpPush", { room: "bad:room" }), CTX);
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/room/);
    expect(client.calls).toHaveLength(0);
  });

  it("is `unroutable` when the org is missing — the receiver would fail-close, so no orphan input is created", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    const outcome = await be.provision(job("rtmpPush"), { org: "" });
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/org/);
    expect(client.calls).toHaveLength(0);
  });

  it("caps escalation: an rtmpPush capped at rank 0 (WHIP-only) is unroutable, not provisioned", async () => {
    const client = fakeClient();
    const be = new CfStreamLiveIngestBackend(client);
    const outcome = await be.provision(job("rtmpPush", { maxCostRank: 0 }), CTX);
    expect(outcome.status).toBe("unroutable");
    expect(client.calls).toHaveLength(0);
  });
});

describe("buildCfStreamLiveFeed + ingressRouterEnabled + defaults", () => {
  it("buildCfStreamLiveFeed maps cfStreamLive source kinds to their feed", () => {
    expect(buildCfStreamLiveFeed(job("rtmpPush"))).toEqual({ mode: "push", protocol: "rtmp" });
    expect(buildCfStreamLiveFeed(job("srtPush"))).toEqual({ mode: "push", protocol: "srt" });
    expect(buildCfStreamLiveFeed(job("urlPull"))).toEqual({ mode: "pull", sourceUrl: "https://src.example/live.m3u8" });
  });

  it("buildCfStreamLiveFeed returns null for a non-cfStreamLive kind (precondition violated)", () => {
    expect(buildCfStreamLiveFeed(job("whip"))).toBeNull();
    expect(buildCfStreamLiveFeed(job("ristPush"))).toBeNull(); // rist has a push protocol but is NOT a cfStreamLive kind
  });

  it("uses the canonical id by default", () => {
    expect(new CfStreamLiveIngestBackend(fakeClient()).id).toBe(CF_STREAM_LIVE_INGEST_ID);
  });

  it("ingressRouterEnabled is strict: only true / '1' / 'true' arm it; absent / '0' / other → OFF (inert)", () => {
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "1" })).toBe(true);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "true" })).toBe(true);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: true })).toBe(true);
    expect(ingressRouterEnabled({})).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "0" })).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "yes" })).toBe(false);
  });
});
