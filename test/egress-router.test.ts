// E-EGRESS-ROUTER P1 (#75) — the routed-egress decision core. Proves the epic's hard-gate: the router picks the
// CHEAPEST CAPABLE tier first (passthrough → dogfood composite → GPU), escalates only on need, honors a cost
// ceiling, and rejects a malformed/uncoverable job with an explaining reason (never a silent default). Pure engine,
// no env / clock / network.
import { describe, it, expect } from "vitest";
import {
  egressRoute,
  validateEgressJob,
  EGRESS_ROUTING_TABLE,
  WAVE_RENDER_CAPS,
  type EgressJob,
} from "../src/egress-router.js";

/** A moderate branded-composite job that sits squarely inside wave-render's envelope. */
function job(overrides: Partial<EgressJob> = {}): EgressJob {
  return {
    needsCompositing: true,
    sourceCount: 4,
    width: 1280,
    height: 720,
    output: "record",
    latency: "nearRealTime",
    codec: "h264",
    ...overrides,
  };
}

describe("egressRoute — cheapest capable tier first", () => {
  it("no-composite record → cfStream (cheapest passthrough)", () => {
    const d = egressRoute(job({ needsCompositing: false }));
    expect(d).toEqual({ ok: true, backend: "cfStream", costRank: 0 });
  });

  it("no-composite simulcast (even realTime + HEVC) still passes through cfStream — passthrough doesn't encode", () => {
    const d = egressRoute(job({ needsCompositing: false, output: "simulcast", latency: "realTime", codec: "hevc" }));
    expect(d).toMatchObject({ ok: true, backend: "cfStream" });
  });

  it("moderate branded composite → waveRender (dogfood default, NOT the GPU tier)", () => {
    const d = egressRoute(job());
    expect(d).toEqual({ ok: true, backend: "waveRender", costRank: 1 });
  });

  it("picks waveRender (rank 1) over the also-capable runpod (rank 2) — cheapest-capable-first", () => {
    const d = egressRoute(job());
    // both waveRender and runpodNvenc can composite this; the router must take the cheaper.
    expect(d).toMatchObject({ ok: true, backend: "waveRender" });
  });
});

describe("egressRoute — escalation to GPU only on need", () => {
  it("heavy multi-source composite (> max sources) → runpodNvenc", () => {
    const d = egressRoute(job({ sourceCount: WAVE_RENDER_CAPS.maxSources + 1 }));
    expect(d).toEqual({ ok: true, backend: "runpodNvenc", costRank: 2 });
  });

  it("high-res composite (4K) → runpodNvenc", () => {
    const d = egressRoute(job({ width: 3840, height: 2160 }));
    expect(d).toMatchObject({ ok: true, backend: "runpodNvenc" });
  });

  it("HEVC composite → runpodNvenc", () => {
    const d = egressRoute(job({ codec: "hevc" }));
    expect(d).toMatchObject({ ok: true, backend: "runpodNvenc" });
  });

  it("real-time-at-scale composite → runpodNvenc", () => {
    const d = egressRoute(job({ latency: "realTime" }));
    expect(d).toMatchObject({ ok: true, backend: "runpodNvenc" });
  });
});

describe("egressRoute — wave-render envelope boundaries", () => {
  it("exactly at the ceiling (max sources, 1080p) stays on waveRender", () => {
    const d = egressRoute(job({ sourceCount: WAVE_RENDER_CAPS.maxSources, width: 1920, height: 1080 }));
    expect(d).toMatchObject({ ok: true, backend: "waveRender" });
  });

  it("one source past the ceiling escalates", () => {
    const d = egressRoute(job({ sourceCount: WAVE_RENDER_CAPS.maxSources + 1 }));
    expect(d).toMatchObject({ ok: true, backend: "runpodNvenc" });
  });
});

describe("egressRoute — cost ceiling (maxCostRank)", () => {
  it("caps escalation: a heavy composite capped at rank 1 is REJECTED, not sent to GPU", () => {
    const d = egressRoute(job({ sourceCount: 50, maxCostRank: 1 }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/runpodNvenc: costRank 2 > ceiling 1/);
  });

  it("caps at rank 0: a composite job (needs > passthrough) is rejected", () => {
    const d = egressRoute(job({ maxCostRank: 0 }));
    expect(d.ok).toBe(false);
  });

  it("a no-composite job under a rank-0 cap still routes to cfStream", () => {
    const d = egressRoute(job({ needsCompositing: false, maxCostRank: 0 }));
    expect(d).toMatchObject({ ok: true, backend: "cfStream" });
  });
});

describe("validateEgressJob — reject malformed jobs at the boundary", () => {
  it("sourceCount < 1 → reason, and egressRoute returns ok:false", () => {
    expect(validateEgressJob(job({ sourceCount: 0 }))).toMatch(/sourceCount/);
    expect(egressRoute(job({ sourceCount: 0 })).ok).toBe(false);
  });

  it("non-positive dimensions → reason", () => {
    expect(validateEgressJob(job({ width: 0 }))).toMatch(/width/);
    expect(validateEgressJob(job({ height: -1 }))).toMatch(/height/);
  });

  it("negative cost ceiling → reason", () => {
    expect(validateEgressJob(job({ maxCostRank: -1 }))).toMatch(/maxCostRank/);
  });

  it("a well-formed job validates to null", () => {
    expect(validateEgressJob(job())).toBeNull();
  });
});

describe("routing table integrity", () => {
  it("cost ranks are strictly ascending in table order (cheapest first)", () => {
    const ranks = EGRESS_ROUTING_TABLE.map((t) => t.costRank);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });

  it("every valid job (composite or not) routes to some backend — the router never strands a valid job", () => {
    for (const needsCompositing of [true, false]) {
      const d = egressRoute(job({ needsCompositing, sourceCount: 100, width: 7680, height: 4320, codec: "av1", latency: "realTime" }));
      expect(d.ok).toBe(true);
    }
  });
});
