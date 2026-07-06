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

// #136: the PROD/default worker config is everything BEFORE the `[env.canary]` block. The canary is a SEPARATE
// worker (wave-realtime-edge-canary) that deliberately arms the container encoder; these INERT invariants apply
// to the prod/default config ONLY, so we slice the canary block off before asserting. The canary block itself is
// asserted-armed in the dedicated describe below.
const canaryIdx = toml.indexOf("[env.canary]");
const prodToml = canaryIdx >= 0 ? toml.slice(0, canaryIdx) : toml;
const canaryToml = canaryIdx >= 0 ? toml.slice(canaryIdx) : "";

describe("wrangler.toml stays INERT for raw-SFU recording (prod/default worker)", () => {
  it("the wrangler.toml was actually loaded", () => {
    expect(toml.length).toBeGreaterThan(0);
  });

  it('RT_ENCODER is "managed" (the live, non-container path) — prod untouched', () => {
    const m = prodToml.match(/^\s*RT_ENCODER\s*=\s*"([^"]+)"/m);
    expect(m, "RT_ENCODER var must be present in wrangler.toml").not.toBeNull();
    expect(m![1]).toBe("managed");
  });

  it("the [[containers]] block IS LIVE (Step A armed the container infra — DO deploys)", () => {
    // A live block starts the line with `[[containers]]` (no leading `#`). Step A uncommented it.
    expect(/^\s*\[\[\s*containers\s*\]\]/m.test(prodToml), "live [[containers]] block must be present").toBe(true);
  });

  it("the RT-R10 RecorderContainer [[containers]] block IS present and LIVE (infra armed, encoder still dormant)", () => {
    // Step A (#67b ◆ A): the portable recorder's container block is now uncommented so the container DO deploys.
    expect(/^\s*\[\[\s*containers\s*\]\]/m.test(prodToml), "live [[containers]] block must be present").toBe(true);
    expect(/^\s*class_name\s*=\s*"RecorderContainer"/m.test(prodToml), "RecorderContainer class must be named live").toBe(true);
    // The RECORDER DO binding is now LIVE (the container DO must bind for the deploy to provision it).
    expect(/^\s*name\s*=\s*"RECORDER"/m.test(prodToml), "live RECORDER DO binding must be present").toBe(true);
  });

  it("RECORDER_TARGET / RECORDER_SINK are NOT live-set in the PROD config (defaults 'none'/'r2' apply)", () => {
    // The seam defaults inert (none/r2) in code; the prod/default config must not flip them to a live runtime/
    // sink. (The CANARY worker DOES set RECORDER_TARGET — that's its job — but it's a separate worker, sliced off.)
    expect(/^\s*RECORDER_TARGET\s*=/m.test(prodToml), "RECORDER_TARGET must not be live-set in prod (default 'none')").toBe(false);
    expect(/^\s*RECORDER_SINK\s*=/m.test(prodToml), "RECORDER_SINK must not be live-set in prod (default 'r2')").toBe(false);
  });

  it("prod config sets NO AV1_DEFAULT / NEGOTIATION_ENABLED flag (container starts byte-identical)", () => {
    // The container encode flags must NEVER be set on the prod/default worker — RecorderContainer forwards them
    // only when present, so absent here = empty forward set = byte-identical container start (#136).
    expect(/^\s*AV1_DEFAULT\s*=/m.test(prodToml), "AV1_DEFAULT must not be set on the prod worker").toBe(false);
    expect(/^\s*NEGOTIATION_ENABLED\s*=/m.test(prodToml), "NEGOTIATION_ENABLED must not be set on the prod worker").toBe(false);
  });
});

describe("#136 [env.canary] — separate canary worker arms the container encoder (prod untouched)", () => {
  it("the [env.canary] block exists and names a DISTINCT worker on workers.dev (not rt.wave.online)", () => {
    expect(canaryToml.length, "[env.canary] block must be present").toBeGreaterThan(0);
    expect(/^\s*name\s*=\s*"wave-realtime-edge-canary"/m.test(canaryToml)).toBe(true);
    expect(/^\s*workers_dev\s*=\s*true/m.test(canaryToml)).toBe(true);
    // The canary must NOT attach a custom domain route (would shadow the paid prod host).
    expect(/custom_domain/.test(canaryToml), "canary must not add a custom_domain route").toBe(false);
  });

  it("canary arms the container encode path: RT_ENCODER=container, RECORDER_TARGET=cf, AV1+negotiation ON", () => {
    expect(/^\s*RT_ENCODER\s*=\s*"container"/m.test(canaryToml)).toBe(true);
    expect(/^\s*RECORDER_TARGET\s*=\s*"cf"/m.test(canaryToml)).toBe(true);
    expect(/^\s*AV1_DEFAULT\s*=\s*"1"/m.test(canaryToml)).toBe(true);
    expect(/^\s*NEGOTIATION_ENABLED\s*=\s*"true"/m.test(canaryToml)).toBe(true);
  });

  it("canary binds a DISTINCT recordings bucket and restates ROOM + RECORDER bindings; does NOT set RT_RESIDENCY", () => {
    expect(/bucket_name\s*=\s*"wave-realtime-recordings-canary"/.test(canaryToml)).toBe(true);
    expect(/class_name\s*=\s*"RoomDO"/.test(canaryToml), "canary must restate ROOM DO").toBe(true);
    expect(/class_name\s*=\s*"RecorderContainer"/.test(canaryToml), "canary must restate RECORDER container").toBe(true);
    expect(/^\s*RT_RESIDENCY\s*=/m.test(canaryToml), "canary must NOT set RT_RESIDENCY").toBe(false);
  });
});
