// RT-R9 INERT-LEAK guard (epic §Risks). The live wrangler.toml MUST keep RT_ENCODER="managed" so the raw-SFU
// container path is NEVER selected in prod by this PR — and there must be NO [[containers]] block (that attach
// is a Jake-named ◆). A future edit that flips the live selector or attaches a container fails HERE before prod.
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

  it('RT_ENCODER is "managed" (the live, non-container path) — prod untouched', () => {
    const m = toml.match(/^\s*RT_ENCODER\s*=\s*"([^"]+)"/m);
    expect(m, "RT_ENCODER var must be present in wrangler.toml").not.toBeNull();
    expect(m![1]).toBe("managed");
  });

  it("there is NO LIVE [[containers]] block (the container attach is a deferred ◆ — block stays commented)", () => {
    // A live block starts the line with `[[containers]]`. A commented one starts with `#` — must NOT match.
    expect(/^\s*\[\[\s*containers\s*\]\]/m.test(toml)).toBe(false);
  });

  it("the RT-R10 RecorderContainer [[containers]] block IS present but COMMENTED (inert, ready for the ◆)", () => {
    // The portable recorder's container block must exist (so the ◆ is a one-line uncomment) yet stay commented.
    expect(/#\s*\[\[\s*containers\s*\]\]/m.test(toml), "commented [[containers]] block must be present").toBe(true);
    expect(/#\s*class_name\s*=\s*"RecorderContainer"/m.test(toml), "RecorderContainer class must be named").toBe(true);
    expect(/#\s*name\s*=\s*"RECORDER"/m.test(toml), "commented RECORDER DO binding must be present").toBe(true);
    // And NO live RECORDER DO binding (only the commented one) — a live one would attach an unbuilt container.
    expect(/^\s*name\s*=\s*"RECORDER"/m.test(toml), "RECORDER binding must NOT be live").toBe(false);
  });

  it("RECORDER_TARGET / RECORDER_SINK are NOT live-set in wrangler.toml (defaults 'none'/'r2' apply)", () => {
    // The seam defaults inert (none/r2) in code; wrangler.toml must not flip them to a live runtime/sink.
    expect(/^\s*RECORDER_TARGET\s*=/m.test(toml), "RECORDER_TARGET must not be live-set (default 'none')").toBe(false);
    expect(/^\s*RECORDER_SINK\s*=/m.test(toml), "RECORDER_SINK must not be live-set (default 'r2')").toBe(false);
  });
});
