import { describe, it, expect } from "vitest";
import { LatencyCollector, hopLatencies, p50p95, type TurnHopMarks } from "../src/turn-latency.js";

describe("p50p95", () => {
  it("computes nearest-rank p50 and p95", () => {
    const { p50, p95, n } = p50p95([10, 20, 30, 40, 50]);
    expect(n).toBe(5);
    expect(p50).toBe(30);
    expect(p95).toBe(50);
  });
  it("uses the lower value at even-sized rank boundaries", () => {
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(p50p95(values)).toEqual({ p50: 15, p95: 29, n: 30 });
    expect(p50p95(values.slice(0, 20))).toEqual({ p50: 10, p95: 19, n: 20 });
  });
  it("empty → zeros", () => {
    expect(p50p95([])).toEqual({ p50: 0, p95: 0, n: 0 });
  });
});

describe("hopLatencies", () => {
  it("derives per-hop deltas and nulls a missing boundary", () => {
    const marks: TurnHopMarks = { turnId: "t0", speechEndMs: 1000, sttFinalMs: 1200, llmFirstTokenMs: 1500, ttsFirstAudioMs: 1600 };
    const l = hopLatencies(marks);
    expect(l.sttMs).toBe(200);
    expect(l.llmMs).toBe(300);
    expect(l.ttsMs).toBe(100);
    expect(l.totalMs).toBe(600);
    const partial = hopLatencies({ turnId: "t1", speechEndMs: 1000, sttFinalMs: 1200 });
    expect(partial.sttMs).toBe(200);
    expect(partial.llmMs).toBeNull();
    expect(partial.totalMs).toBeNull();
  });
});

describe("LatencyCollector", () => {
  it("emits per-hop p50/p95 over the recorded marks", () => {
    const c = new LatencyCollector();
    for (let i = 0; i < 30; i++) {
      c.record({ turnId: `t${i}`, speechEndMs: 0, sttFinalMs: 100 + i, llmFirstTokenMs: 300 + i, ttsFirstAudioMs: 400 + i });
    }
    expect(c.count()).toBe(30);
    const dist = c.distribution();
    expect(dist.find((d) => d.hop === "stt")?.n).toBe(30);
    expect(dist.find((d) => d.hop === "total")?.p50).toBeGreaterThan(0);
  });
});
