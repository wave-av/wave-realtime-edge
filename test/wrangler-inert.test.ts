// RT-R9 INERT-LEAK guard (epic §Risks). After Step A (#67b ◆ A), the RecorderContainer INFRA is ARMED — the
// [[containers]] block is LIVE so the container DO deploys — but the ENCODER stays dormant: the live wrangler.toml
// MUST keep RT_ENCODER="managed" (the PULL-mode path) and MUST NOT live-set RECORDER_TARGET to 'cf'/'selfhost'
// (defaults 'none' → NoneTarget). The invariant is now: container infra armed, encoder still inert. A future edit
// that flips the live selector OR sets RECORDER_TARGET to a live runtime fails HERE before prod (that's Step D).
// Loads wrangler.toml as a raw string via Vite's import.meta.glob (no node:fs — tsconfig has only workers-types).
import { describe, it, expect } from "vitest";

// Minimal local typing for Vite's `import.meta.glob` (same pattern as bundle-guard.test.ts).
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

const RAW = import.meta.glob("../wrangler.toml", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const toml = Object.values(RAW)[0] ?? "";

describe("wrangler.toml stays INERT for raw-SFU recording", () => {
  it("the wrangler.toml was actually loaded", () => {
    expect(toml.length).toBeGreaterThan(0);
  });

  it('◆ STEP D ARM: RT_ENCODER is "container" (Path A encoder) — arm/rt-video-path-a only, NOT main', () => {
    const m = toml.match(/^\s*RT_ENCODER\s*=\s*"([^"]+)"/m);
    expect(m, "RT_ENCODER var must be present in wrangler.toml").not.toBeNull();
    expect(m![1]).toBe("container");
  });

  it("the [[containers]] block IS LIVE (Step A armed the container infra — DO deploys)", () => {
    // A live block starts the line with `[[containers]]` (no leading `#`). Step A uncommented it.
    expect(/^\s*\[\[\s*containers\s*\]\]/m.test(toml), "live [[containers]] block must be present").toBe(true);
  });

  it("the RT-R10 RecorderContainer [[containers]] block IS present and LIVE (infra armed, encoder still dormant)", () => {
    // Step A (#67b ◆ A): the portable recorder's container block is now uncommented so the container DO deploys.
    expect(/^\s*\[\[\s*containers\s*\]\]/m.test(toml), "live [[containers]] block must be present").toBe(true);
    expect(/^\s*class_name\s*=\s*"RecorderContainer"/m.test(toml), "RecorderContainer class must be named live").toBe(true);
    // The RECORDER DO binding is now LIVE (the container DO must bind for the deploy to provision it).
    expect(/^\s*name\s*=\s*"RECORDER"/m.test(toml), "live RECORDER DO binding must be present").toBe(true);
  });

  it("◆ STEP D ARM: RECORDER_TARGET is live-set to 'cf' (Path A) — arm branch only; RECORDER_SINK stays default 'r2'", () => {
    // arm/rt-video-path-a: the video path is live via the CF container target. Rollback = redeploy main (unset → 'none').
    const m = toml.match(/^\s*RECORDER_TARGET\s*=\s*"([^"]+)"/m);
    expect(m, "RECORDER_TARGET must be live-set on the arm branch").not.toBeNull();
    expect(m![1]).toBe("cf");
    expect(/^\s*RECORDER_SINK\s*=/m.test(toml), "RECORDER_SINK stays default 'r2' (not live-set)").toBe(false);
  });
});
