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

  it("there is NO [[containers]] block (the container attach is a deferred ◆)", () => {
    expect(/^\s*\[\[\s*containers\s*\]\]/m.test(toml)).toBe(false);
  });
});
