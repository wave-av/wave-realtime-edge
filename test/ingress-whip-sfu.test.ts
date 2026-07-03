// E-INGRESS P3 (#77) — the WHIP/WebRTC ingest backend. Proves the backend OWNS EXACTLY the `cfCallsSfu` plane: it
// negotiates a WHIP publish into the SFU (carrying room + org + SDP offer) when the router routes there, DEFERS every
// other verdict (never negotiating a source routed to CF Stream Live or the container), refuses a job with no org or a
// non-SDP offer, and stays inert until the flag is armed. Pure engine + an injected fake SFU client — no CF Calls, no
// clock.
import { describe, it, expect } from "vitest";
import {
  WhipSfuIngestBackend,
  isValidSdpOffer,
  ingressRouterEnabled,
  WHIP_SFU_INGEST_ID,
  type WhipSfuClient,
  type WhipPublishRequest,
  type WhipPublishResult,
} from "../src/ingress-whip-sfu.js";
import type { IngestJob, IngestSourceKind } from "../src/ingress-router.js";

const OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

/** A fake SFU: records the publish requests it received and returns a canned session (or a canned non-2xx). */
function fakeClient(
  reply: WhipPublishResult = { ok: true, session: { sdpAnswer: "v=0\r\n...answer", resourceId: "whip-res-1" } },
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

/** An ingest job for a given source kind into a valid room (pull URL auto-supplied for urlPull). */
function job(sourceKind: IngestSourceKind, overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    sourceKind,
    room: "room-1",
    ...(sourceKind === "urlPull" ? { sourceUrl: "https://src.example/live.m3u8" } : {}),
    ...overrides,
  };
}

const CTX = { org: "org-acme", sdpOffer: OFFER };

describe("WhipSfuIngestBackend — owns the cfCallsSfu plane, defers the rest", () => {
  it("negotiates a WHIP publish, passing room + org + the SDP offer to the SFU", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    const outcome = await be.admit(job("whip"), CTX);
    expect(outcome.status).toBe("admitted");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({ room: "room-1", org: "org-acme", sdpOffer: OFFER });
    if (outcome.status === "admitted" && outcome.result.ok) expect(outcome.result.session.resourceId).toBe("whip-res-1");
  });

  it("surfaces a non-2xx SFU reply (e.g. offer the SFU rejects, 422) without mistaking it for a session", async () => {
    const client = fakeClient({ ok: false, status: 422, reason: "sfu rejected the offer" });
    const be = new WhipSfuIngestBackend(client);
    const outcome = await be.admit(job("whip"), CTX);
    expect(outcome.status).toBe("admitted");
    if (outcome.status === "admitted") {
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) expect(outcome.result.status).toBe(422);
    }
  });

  it("DEFERS an rtmp push to cfStreamLive — never negotiates a WHIP session for it", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    expect(await be.admit(job("rtmpPush"), CTX)).toEqual({ status: "deferred", backend: "cfStreamLive" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS a RIST push to the containerBridge backstop", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    expect(await be.admit(job("ristPush"), CTX)).toEqual({ status: "deferred", backend: "containerBridge" });
    expect(client.calls).toHaveLength(0);
  });

  it("DEFERS a URL pull to cfStreamLive", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    expect((await be.admit(job("urlPull"), CTX)).status).toBe("deferred");
    expect(client.calls).toHaveLength(0);
  });
});

describe("WhipSfuIngestBackend — refuses a source that can't be admitted", () => {
  it("is `unroutable` for a malformed job (unsafe room) — never negotiates on garbage", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    const outcome = await be.admit(job("whip", { room: "bad:room" }), CTX);
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/room/);
    expect(client.calls).toHaveLength(0);
  });

  it("is `unroutable` when the org is missing — no anonymous SFU publish", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    const outcome = await be.admit(job("whip"), { org: "", sdpOffer: OFFER });
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/org/);
    expect(client.calls).toHaveLength(0);
  });

  it("is `unroutable` for a non-SDP offer body — the SFU never sees garbage", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    const outcome = await be.admit(job("whip"), { org: "org-acme", sdpOffer: "not an sdp" });
    expect(outcome.status).toBe("unroutable");
    if (outcome.status === "unroutable") expect(outcome.reason).toMatch(/SDP/);
    expect(client.calls).toHaveLength(0);
  });

  it("caps escalation: a whip source is rank 0, so it is never affected — but a non-whip capped below its tier is unroutable", async () => {
    const client = fakeClient();
    const be = new WhipSfuIngestBackend(client);
    // rtmpPush (rank 1) capped at rank 0 → no capable tier → unroutable (and not this backend's plane anyway).
    const outcome = await be.admit(job("rtmpPush", { maxCostRank: 0 }), CTX);
    expect(outcome.status).toBe("unroutable");
    expect(client.calls).toHaveLength(0);
  });
});

describe("isValidSdpOffer + ingressRouterEnabled + defaults", () => {
  it("isValidSdpOffer accepts a v=0 body (with leading whitespace tolerance), rejects non-SDP/empty", () => {
    expect(isValidSdpOffer(OFFER)).toBe(true);
    expect(isValidSdpOffer("  \n v=0\r\n...")).toBe(true);
    expect(isValidSdpOffer("v=1\r\n")).toBe(false);
    expect(isValidSdpOffer("not an sdp")).toBe(false);
    expect(isValidSdpOffer("")).toBe(false);
    expect(isValidSdpOffer(undefined)).toBe(false);
  });

  it("uses the canonical id by default", () => {
    expect(new WhipSfuIngestBackend(fakeClient()).id).toBe(WHIP_SFU_INGEST_ID);
  });

  it("ingressRouterEnabled is strict: only true / '1' / 'true' arm it; absent / '0' / other → OFF (inert)", () => {
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "1" })).toBe(true);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: true })).toBe(true);
    expect(ingressRouterEnabled({})).toBe(false);
    expect(ingressRouterEnabled({ INGRESS_ROUTER_ENABLED: "0" })).toBe(false);
  });
});
