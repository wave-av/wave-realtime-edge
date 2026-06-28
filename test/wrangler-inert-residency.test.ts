// E3.P2/P4 (#127) ARM-COHERENCE guard. The residency path was ARMED at the Jake-named ◆ crossing
// (RT_RESIDENCY="1", 2026-06-28). This contract no longer blocks the arm — it blocks an INCOHERENT one: if
// RT_RESIDENCY is live-set it MUST be exactly "1" (never a typo'd/partial value), AND a register origin
// (GATEWAY_BASE_URL / WAVE_GATEWAY_ORIGIN) MUST be present so register() is never a silent no-op; and the two
// jurisdiction R2 bindings MUST stay present. Mirrors wrangler-inert.test.ts's pattern.
import { describe, it, expect } from "vitest";

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

describe("wrangler.toml RT_RESIDENCY arm is coherent (#127 ARMED)", () => {
  it("the wrangler.toml was actually loaded", () => {
    expect(toml.length).toBeGreaterThan(0);
  });

  it("RT_RESIDENCY, when live-set, is a coherent armed value ('1') with a register origin present", () => {
    // A live var starts the line (no leading `#`). It is OPTIONAL (absent/commented = inert), but if present it
    // MUST be exactly "1" — never a typo'd/partial arm that silently misbehaves.
    const m = toml.match(/^\s*RT_RESIDENCY\s*=\s*"([^"]*)"/m);
    if (m) {
      expect(m[1], 'RT_RESIDENCY live-set must be exactly "1" (armed)').toBe("1");
      // An armed config MUST carry a gateway origin so the register() POST is never a silent no-op.
      const hasOrigin = /^\s*GATEWAY_BASE_URL\s*=/m.test(toml) || /^\s*WAVE_GATEWAY_ORIGIN\s*=/m.test(toml);
      expect(hasOrigin, "an armed residency config needs GATEWAY_BASE_URL or WAVE_GATEWAY_ORIGIN").toBe(true);
    }
  });

  it("the jurisdiction R2 bindings ARE present (armed-but-inert: bound, only read when RT_RESIDENCY is on)", () => {
    expect(/^\s*binding\s*=\s*"RT_RECORDINGS_ENAM"/m.test(toml)).toBe(true);
    expect(/^\s*bucket_name\s*=\s*"wave-recordings-enam"/m.test(toml)).toBe(true);
    expect(/^\s*binding\s*=\s*"RT_RECORDINGS_EU"/m.test(toml)).toBe(true);
    expect(/^\s*bucket_name\s*=\s*"wave-recordings-eu"/m.test(toml)).toBe(true);
  });
});
