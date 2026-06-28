// E3.P2/P4 (#127) INERT guard: prove RT_RESIDENCY is NOT live-set in wrangler.toml (the residency path stays
// OFF until a Jake-named ◆), while the two jurisdiction R2 bindings ARE present (armed-but-inert: bound so the
// deploy provisions them, but never read until RT_RESIDENCY flips). Mirrors wrangler-inert.test.ts's pattern.
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

describe("wrangler.toml keeps RT_RESIDENCY OFF (#127 INERT)", () => {
  it("the wrangler.toml was actually loaded", () => {
    expect(toml.length).toBeGreaterThan(0);
  });

  it("RT_RESIDENCY is NOT live-set (default OFF) — residency path inert until the ◆", () => {
    // A live var starts the line (no leading `#`). It must be absent/commented.
    expect(/^\s*RT_RESIDENCY\s*=/m.test(toml), "RT_RESIDENCY must not be live-set").toBe(false);
  });

  it("the jurisdiction R2 bindings ARE present (armed-but-inert: bound, only read when RT_RESIDENCY is on)", () => {
    expect(/^\s*binding\s*=\s*"RT_RECORDINGS_ENAM"/m.test(toml)).toBe(true);
    expect(/^\s*bucket_name\s*=\s*"wave-recordings-enam"/m.test(toml)).toBe(true);
    expect(/^\s*binding\s*=\s*"RT_RECORDINGS_EU"/m.test(toml)).toBe(true);
    expect(/^\s*bucket_name\s*=\s*"wave-recordings-eu"/m.test(toml)).toBe(true);
  });
});
