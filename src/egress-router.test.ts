/**
 * E-EGRESS-ROUTER P1 (#75) — shadow decision-matrix proof for `egressRoute` (EGRESS_ROUTER_ENABLED stays "0").
 *
 * Shadow test: exercises the pure decision function directly — no flag, no env, no clock (`egressRoute` takes
 * no env). Proves the router's existing routing-table logic BEFORE any prod arm (Task 8 ◆).
 *
 * Real `EgressJob` shape (src/egress-router.ts): `{ needsCompositing, sourceCount, width, height, output,
 * latency, codec, maxCostRank? }` — NOT the plan's illustrative `{ kind }` / `{ codec, resolution }` / `{ tier }`.
 * Adapted here to the real signature per the plan's own instruction. Also: `validateEgressJob` RETURNS a
 * reason string (or null) — it never THROWS — so the plan's illustrative `expect(() => validateEgressJob({})).
 * toThrow()` does not match the real contract (a no-throw boundary validator, mirroring the repo's
 * `RegisterResult` no-throw convention). Adapted to assert the returned reason string instead.
 */
import { describe, it, expect } from "vitest";
import { egressRoute, validateEgressJob, WAVE_RENDER_CAPS, type EgressJob } from "./egress-router.js";

const BASE: EgressJob = {
  needsCompositing: false,
  sourceCount: 1,
  width: 1920,
  height: 1080,
  output: "record",
  latency: "nearRealTime",
  codec: "h264",
};

describe("egressRoute decision matrix (shadow — EGRESS_ROUTER_ENABLED stays off)", () => {
  it("routes a within-envelope branded composite to wave-render", () => {
    const job: EgressJob = { ...BASE, needsCompositing: true, sourceCount: 2 };
    const decision = egressRoute(job);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("waveRender");
      expect(decision.costRank).toBe(1);
    }
  });

  it("routes a 4K/HEVC heavy composite to the RunPod NVENC GPU backstop (over wave-render's envelope)", () => {
    const job: EgressJob = {
      ...BASE,
      needsCompositing: true,
      sourceCount: 2,
      width: 3840,
      height: 2160,
      codec: "hevc",
      latency: "realTime",
      output: "simulcast",
    };
    const decision = egressRoute(job);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("runpodNvenc");
      expect(decision.costRank).toBe(2);
    }
  });

  it("routes a no-composite job to the cheapest CF Stream passthrough tier", () => {
    const decision = egressRoute(BASE);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.backend).toBe("cfStream");
      expect(decision.costRank).toBe(0);
    }
  });

  it("escalates a composite job that exceeds wave-render's max source count to RunPod, without HEVC/4K", () => {
    const job: EgressJob = { ...BASE, needsCompositing: true, sourceCount: WAVE_RENDER_CAPS.maxSources + 1 };
    const decision = egressRoute(job);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.backend).toBe("runpodNvenc");
  });

  it("respects an explicit maxCostRank ceiling — a composite job capped below waveRender is rejected, not escalated", () => {
    const job: EgressJob = { ...BASE, needsCompositing: true, sourceCount: 2, maxCostRank: 0 };
    const decision = egressRoute(job);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/no capable egress backend/);
  });

  it("rejects a malformed job with a stable reason string (validateEgressJob is a no-throw boundary check)", () => {
    const reason = validateEgressJob({} as unknown as EgressJob);
    expect(typeof reason).toBe("string");
    expect(reason).toMatch(/needsCompositing/);

    const decision = egressRoute({} as unknown as EgressJob);
    expect(decision.ok).toBe(false);
  });
});
