// #293 — proof-harness engine: runLeg/runProofHarness/legGate/harnessGate. Pure — a fake clock + fake probes,
// no real network/CF-API/KV. Proves: a probe's outcome becomes a timed receipt; a throwing probe becomes a
// "fail" receipt (never propagates); an unwired leg backfills to "stub"; the roll-up is "fail" iff any leg
// (wired or stub) is "fail"; and the two gate policies (per-leg merge gate, cron/monitoring gate) apply the
// documented stub-permissive rules.
import { describe, it, expect } from "vitest";
import {
  LEG_NAMES,
  runLeg,
  runProofHarness,
  legGate,
  harnessGate,
  type LegProbe,
  type LegReceipt,
} from "../src/proof-harness.js";

function fakeClock(startAt = 1000, stepMs = 10) {
  let t = startAt;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

describe("#293 runLeg", () => {
  it("times a passing probe and carries its markers through unchanged", async () => {
    const probe: LegProbe = async () => ({ verdict: "pass", markers: { bytes: 42 } });
    const receipt = await runLeg("rtmp-in", probe, fakeClock(1000, 5));
    expect(receipt).toMatchObject({
      leg: "rtmp-in",
      verdict: "pass",
      markers: { bytes: 42 },
      startedAt: 1000,
      finishedAt: 1005,
      durationMs: 5,
    });
  });

  it("converts a throwing probe into a fail receipt, never propagating", async () => {
    const probe: LegProbe = async () => {
      throw new Error("boom");
    };
    const receipt = await runLeg("vod-register", probe, fakeClock());
    expect(receipt.verdict).toBe("fail");
    expect(receipt.note).toContain("boom");
    expect(receipt.markers).toEqual({});
  });

  it("passes through an explicit fail verdict + note from the probe", async () => {
    const probe: LegProbe = async () => ({ verdict: "fail", markers: { status: 502 }, note: "cf 502" });
    const receipt = await runLeg("ext-srt-out", probe, fakeClock());
    expect(receipt).toMatchObject({ verdict: "fail", markers: { status: 502 }, note: "cf 502" });
  });
});

describe("#293 runProofHarness", () => {
  it("runs all five LEG_NAMES in order, backfilling unwired legs to stub", async () => {
    const result = await runProofHarness(
      { "rtmp-in": async () => ({ verdict: "pass", markers: {} }) },
      fakeClock(),
    );
    expect(result.receipts.map((r) => r.leg)).toEqual([...LEG_NAMES]);
    expect(result.receipts.find((r) => r.leg === "rtmp-in")?.verdict).toBe("pass");
    for (const leg of ["ext-rtmp-out", "ext-srt-out", "vod-register", "rtms-in"] as const) {
      expect(result.receipts.find((r) => r.leg === leg)?.verdict).toBe("stub");
    }
  });

  it("overall is pass when every leg is pass or stub", async () => {
    const result = await runProofHarness(
      { "rtmp-in": async () => ({ verdict: "pass", markers: {} }) },
      fakeClock(),
    );
    expect(result.overall).toBe("pass");
  });

  it("overall is fail when ANY leg (even one otherwise-stub run) fails", async () => {
    const result = await runProofHarness(
      {
        "rtmp-in": async () => ({ verdict: "pass", markers: {} }),
        "rtms-in": async () => ({ verdict: "fail", markers: {}, note: "hmac mismatch" }),
      },
      fakeClock(),
    );
    expect(result.overall).toBe("fail");
  });

  it("stamps generatedAt from the injected clock's first tick", async () => {
    const result = await runProofHarness({}, fakeClock(5000, 1));
    expect(result.generatedAt).toBe(5000);
  });
});

describe("#293 legGate — per-leg merge gate", () => {
  const base: Omit<LegReceipt, "verdict" | "note"> = {
    leg: "vod-register",
    markers: {},
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
  };

  it("blocks on fail regardless of allowStub", () => {
    const r: LegReceipt = { ...base, verdict: "fail", note: "boom" };
    expect(legGate(r).allow).toBe(false);
    expect(legGate(r, { allowStub: false }).allow).toBe(false);
  });

  it("allows stub by default (a leg's own PR wiring the probe has no prior receipt to point to)", () => {
    const r: LegReceipt = { ...base, verdict: "stub" };
    expect(legGate(r).allow).toBe(true);
  });

  it("blocks stub when the caller opts into strict (allowStub:false)", () => {
    const r: LegReceipt = { ...base, verdict: "stub" };
    expect(legGate(r, { allowStub: false }).allow).toBe(false);
  });

  it("allows pass", () => {
    const r: LegReceipt = { ...base, verdict: "pass" };
    expect(legGate(r).allow).toBe(true);
  });
});

describe("#293 harnessGate — cron/synthetic-monitoring gate", () => {
  it("green synthetic run: no required leg failed -> allow, empty blocking list", async () => {
    const result = await runProofHarness(
      { "rtmp-in": async () => ({ verdict: "pass", markers: {} }) },
      fakeClock(),
    );
    const gate = harnessGate(result, ["rtmp-in"]);
    expect(gate).toEqual({ allow: true, blocking: [], stubLegs: [] });
  });

  it("a failed required leg blocks and is named", async () => {
    const result = await runProofHarness(
      { "vod-register": async () => ({ verdict: "fail", markers: {}, note: "502" }) },
      fakeClock(),
    );
    const gate = harnessGate(result, ["vod-register"]);
    expect(gate).toEqual({ allow: false, blocking: ["vod-register"], stubLegs: [] });
  });

  it("a failed leg NOT in requiredLegs does not block", async () => {
    const result = await runProofHarness(
      { "rtms-in": async () => ({ verdict: "fail", markers: {} }) },
      fakeClock(),
    );
    const gate = harnessGate(result, ["vod-register"]);
    expect(gate.allow).toBe(true);
  });

  it("defaults requiredLegs to every leg", async () => {
    const result = await runProofHarness(
      { "ext-rtmp-out": async () => ({ verdict: "fail", markers: {} }) },
      fakeClock(),
    );
    expect(harnessGate(result).allow).toBe(false);
  });

  it("surfaces stubLegs alongside blocking so allow:true is never mistaken for '5 transports proven live'", async () => {
    const result = await runProofHarness(
      { "rtmp-in": async () => ({ verdict: "pass", markers: {} }) },
      fakeClock(),
    );
    const gate = harnessGate(result); // default requiredLegs = every leg
    expect(gate.allow).toBe(true); // stubs never block…
    expect([...gate.stubLegs].sort()).toEqual(["ext-rtmp-out", "ext-srt-out", "rtms-in", "vod-register"].sort()); // …but are visible
  });
});
