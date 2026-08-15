// W1 slice-1b (Zoom Live Media epic, wave-zoom#46) — tests for emitEgressLegUsage.
// Mirrors test/metering.test.ts's emitParticipantUsage coverage: envelope shape, stable/idempotent
// event_id, fail-open (throwing fetch + non-2xx never propagate), and each leg's SKU mapping.

import { describe, it, expect, vi } from "vitest";
import {
  ZOOM_EGRESS_LEGS,
  zoomLegEventId,
  isEgressLegEmitProvisioned,
  emitEgressLegUsage,
  type ZoomEgressLeg,
  type EgressLegMeterEnv,
} from "../src/egress-leg-metering.js";

const provisioned: EgressLegMeterEnv = {
  GATEWAY_BASE_URL: "https://api.wave.online",
  WAVE_SERVICE_TOKEN: "svc-tok",
};

describe("zoomLegEventId — stable, namespaced, per (meetingUuid, leg)", () => {
  it("formula matches gateway's zoomLegEventId verbatim", () => {
    expect(zoomLegEventId("meeting-abc", "ingest")).toBe("zoom-egress:meeting-abc:ingest");
  });

  it("stable across repeated calls for the same (meetingUuid, leg) — redelivery-safe", () => {
    const a = zoomLegEventId("meeting-abc", "rtms");
    const b = zoomLegEventId("meeting-abc", "rtms");
    expect(a).toBe(b);
  });

  it("distinct legs of the same meeting → distinct ids (no cross-leg collision)", () => {
    const legs: ZoomEgressLeg[] = ["ingest", "rtms", "rtmp-out", "srt-out"];
    const ids = legs.map((leg) => zoomLegEventId("meeting-x", leg));
    expect(new Set(ids).size).toBe(4);
  });
});

describe("ZOOM_EGRESS_LEGS — leg → SKU mapping matches gateway catalog", () => {
  it("ingest → wave_zoom_ingest_minutes", () => {
    expect(ZOOM_EGRESS_LEGS.ingest).toBe("wave_zoom_ingest_minutes");
  });
  it("rtms → wave_zoom_rtms_minutes", () => {
    expect(ZOOM_EGRESS_LEGS.rtms).toBe("wave_zoom_rtms_minutes");
  });
  it("rtmp-out → wave_zoom_rtmp_out_minutes", () => {
    expect(ZOOM_EGRESS_LEGS["rtmp-out"]).toBe("wave_zoom_rtmp_out_minutes");
  });
  it("srt-out → wave_zoom_srt_out_minutes", () => {
    expect(ZOOM_EGRESS_LEGS["srt-out"]).toBe("wave_zoom_srt_out_minutes");
  });
});

describe("isEgressLegEmitProvisioned — INERT until BOTH url and token", () => {
  it("both set → provisioned", () => {
    expect(isEgressLegEmitProvisioned(provisioned)).toBe(true);
  });
  it("missing token → inert", () => {
    expect(isEgressLegEmitProvisioned({ GATEWAY_BASE_URL: "https://api.wave.online" })).toBe(false);
  });
  it("missing url → inert", () => {
    expect(isEgressLegEmitProvisioned({ WAVE_SERVICE_TOKEN: "x" })).toBe(false);
  });
  it("empty env → inert", () => {
    expect(isEgressLegEmitProvisioned({})).toBe(false);
  });
});

describe("emitEgressLegUsage — server-to-server /v1/internal/usage, fail-open", () => {
  it("INERT: no fetch when not provisioned", async () => {
    const fetchFn = vi.fn();
    await emitEgressLegUsage(
      {},
      { org: "org_a", meetingUuid: "meeting-1", leg: "ingest", durationMs: 5 * 60_000 },
      { fetchFn },
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("no fetch for zero/negative duration (clock skew / zero-length leg)", async () => {
    const fetchFn = vi.fn();
    await emitEgressLegUsage(
      provisioned,
      { org: "org_a", meetingUuid: "meeting-1", leg: "ingest", durationMs: 0 },
      { fetchFn },
    );
    await emitEgressLegUsage(
      provisioned,
      { org: "org_a", meetingUuid: "meeting-1", leg: "ingest", durationMs: -1 },
      { fetchFn },
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs the correct envelope: org, meter=SKU, meter_value=minutes, event_id=zoomLegEventId, Bearer auth", async () => {
    const calls: { url: string; body: any; auth: string | null }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(null, { status: 200 });
    });

    await emitEgressLegUsage(
      provisioned,
      { org: "org_a", meetingUuid: "meeting-1", leg: "rtmp-out", durationMs: 5 * 60_000 },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe("https://api.wave.online/v1/internal/usage");
    expect(c.auth).toBe("Bearer svc-tok");
    expect(c.body.org).toBe("org_a");
    expect(c.body.usage.meter).toBe("wave_zoom_rtmp_out_minutes");
    expect(c.body.usage.meter_value).toBe(5);
    expect(c.body.usage.event_id).toBe(zoomLegEventId("meeting-1", "rtmp-out"));
  });

  it("each of the 4 legs maps to its correct SKU in the emitted envelope", async () => {
    const legs: { leg: ZoomEgressLeg; sku: string }[] = [
      { leg: "ingest", sku: "wave_zoom_ingest_minutes" },
      { leg: "rtms", sku: "wave_zoom_rtms_minutes" },
      { leg: "rtmp-out", sku: "wave_zoom_rtmp_out_minutes" },
      { leg: "srt-out", sku: "wave_zoom_srt_out_minutes" },
    ];
    for (const { leg, sku } of legs) {
      const calls: any[] = [];
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      });
      await emitEgressLegUsage(
        provisioned,
        { org: "org_a", meetingUuid: "meeting-2", leg, durationMs: 60_000 },
        { fetchFn: fetchFn as unknown as typeof fetch },
      );
      expect(calls[0].usage.meter).toBe(sku);
      expect(calls[0].usage.event_id).toBe(zoomLegEventId("meeting-2", leg));
    }
  });

  it("event_id is stable across repeated calls for the same (meetingUuid, leg) — redelivery-safe", async () => {
    const ids: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      ids.push(JSON.parse(String(init?.body)).usage.event_id);
      return new Response(null, { status: 200 });
    });
    const args = { org: "org_a", meetingUuid: "meeting-3", leg: "srt-out" as ZoomEgressLeg, durationMs: 120_000 };
    await emitEgressLegUsage(provisioned, args, { fetchFn: fetchFn as unknown as typeof fetch });
    await emitEgressLegUsage(provisioned, args, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("FAIL-OPEN: a throwing fetch never propagates (media safety)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      emitEgressLegUsage(
        provisioned,
        { org: "org_a", meetingUuid: "meeting-1", leg: "ingest", durationMs: 60_000 },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
  });

  it("FAIL-OPEN: a non-2xx gateway response never throws", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      emitEgressLegUsage(
        provisioned,
        { org: "org_a", meetingUuid: "meeting-1", leg: "ingest", durationMs: 60_000 },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).resolves.toBeUndefined();
  });
});
