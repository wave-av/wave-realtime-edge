/**
 * E-INGRESS P1 (#77) — shadow decision-matrix proof for `ingressRoute` (INGRESS_ROUTER_ENABLED stays "0").
 *
 * This is a SHADOW test: it exercises the pure decision function directly, with no flag read and no env at
 * all (`ingressRoute` takes no env — it is a hermetic function over a typed `IngestJob`). It proves the
 * router's existing routing-table logic is correct BEFORE any prod arm (Task 3 ◆), so the arm crossing is a
 * flip of already-proven logic, not a leap of faith.
 *
 * Real `IngestJob` shape (src/ingress-router.ts): `{ sourceKind, room, sourceUrl?, maxCostRank? }` — NOT the
 * plan's illustrative `{ kind }`. `room` is REQUIRED (validated as a safe path segment); `sourceUrl` is
 * REQUIRED for `urlPull` and FORBIDDEN otherwise. Adapted here to the real signature per the plan's own
 * instruction ("if the real function signatures differ from the plan's illustrative shapes, adapt the TEST").
 *
 * The routing-table matrix also differs from the plan's illustrative grouping: the authoritative table walks
 * cost-ascending (cfCallsSfu → cfStreamLive → containerBridge) and takes the FIRST capable tier. `cfStreamLive`
 * is capable for `rtmpPush` AND `srtPush` (not just `urlPull`), so those two land on the managed tier BEFORE
 * the container backstop — only `ristPush`/`moqPush` (which CF Stream cannot carry) fall through to
 * `containerBridge`. This test encodes that REAL behavior, not the plan's illustrative (incorrect) grouping.
 */
import { describe, it, expect } from "vitest";
import { ingressRoute, validateIngestJob, type IngestJob } from "./ingress-router.js";

const ROOM = "shadow-room-1";

describe("ingressRoute decision matrix (shadow — INGRESS_ROUTER_ENABLED stays off)", () => {
  it("routes WHIP direct to the SFU (cheapest, most-direct tier)", () => {
    const job: IngestJob = { sourceKind: "whip", room: ROOM };
    const decision = ingressRoute(job);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("cfCallsSfu");
      expect(decision.costRank).toBe(0);
      expect(decision.pushProtocol).toBeNull();
      expect(decision.requiresSsrfGuard).toBe(false);
    }
  });

  it("routes RTMP push and SRT (caller-mode) push to the managed CF Stream Live tier", () => {
    for (const sourceKind of ["rtmpPush", "srtPush"] as const) {
      const decision = ingressRoute({ sourceKind, room: ROOM });
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.backend).toBe("cfStreamLive");
        expect(decision.costRank).toBe(1);
        expect(decision.pushProtocol).toBe(sourceKind === "rtmpPush" ? "rtmp" : "srt");
      }
    }
  });

  it("routes RIST/MoQ push through the container bridge — the backstop CF Stream cannot carry", () => {
    for (const sourceKind of ["ristPush", "moqPush"] as const) {
      const decision = ingressRoute({ sourceKind, room: ROOM });
      expect(decision.ok).toBe(true);
      if (decision.ok) {
        expect(decision.backend).toBe("containerBridge");
        expect(decision.costRank).toBe(2);
        expect(decision.pushProtocol).toBe(sourceKind === "ristPush" ? "rist" : "moq");
      }
    }
  });

  it("routes a urlPull to CF Stream Live and flags it as requiring the SSRF guard", () => {
    const decision = ingressRoute({ sourceKind: "urlPull", room: ROOM, sourceUrl: "https://example.com/live.m3u8" });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("cfStreamLive");
      expect(decision.requiresSsrfGuard).toBe(true);
      expect(decision.pushProtocol).toBeNull();
    }
  });

  it("rejects a urlPull with no sourceUrl (validate-before-sink)", () => {
    const decision = ingressRoute({ sourceKind: "urlPull", room: ROOM });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/sourceUrl/);
    expect(validateIngestJob({ sourceKind: "urlPull", room: ROOM })).toMatch(/sourceUrl/);
  });

  it("respects an explicit maxCostRank ceiling — a RIST push capped at the managed rank is rejected, not escalated", () => {
    const decision = ingressRoute({ sourceKind: "ristPush", room: ROOM, maxCostRank: 1 });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/no capable ingest backend/);
  });

  it("rejects a malformed room segment", () => {
    const decision = ingressRoute({ sourceKind: "whip", room: "not a safe segment!" });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/room/);
  });
});
