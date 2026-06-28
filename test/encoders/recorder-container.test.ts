// #136 (Canary C1) — RecorderContainer env-forwarding seam. Proves the PROD/default path forwards NO container
// flags (so the container starts byte-identical to today) and the CANARY-style env DOES forward AV1_DEFAULT +
// NEGOTIATION_ENABLED — and ONLY those two keys, never any other worker var/secret.
import { describe, it, expect } from "vitest";
import { recorderContainerEnvVars } from "../../src/encoders/recorder-container.js";

describe("recorderContainerEnvVars — prod is byte-identical, canary arms the flags", () => {
  it("PROD/default env (neither flag set) → undefined (no envVars override; byte-identical container start)", () => {
    expect(recorderContainerEnvVars(undefined)).toBeUndefined();
    expect(recorderContainerEnvVars({})).toBeUndefined();
  });

  it("empty/'' flag values are treated as absent (default-off) → undefined", () => {
    expect(recorderContainerEnvVars({ AV1_DEFAULT: "", NEGOTIATION_ENABLED: "" })).toBeUndefined();
  });

  it("CANARY-style env (both flags set) → forwards exactly AV1_DEFAULT + NEGOTIATION_ENABLED", () => {
    expect(recorderContainerEnvVars({ AV1_DEFAULT: "1", NEGOTIATION_ENABLED: "true" })).toEqual({
      AV1_DEFAULT: "1",
      NEGOTIATION_ENABLED: "true",
    });
  });

  it("forwards only the present subset (partial arming)", () => {
    expect(recorderContainerEnvVars({ AV1_DEFAULT: "1" })).toEqual({ AV1_DEFAULT: "1" });
    expect(recorderContainerEnvVars({ NEGOTIATION_ENABLED: "true" })).toEqual({ NEGOTIATION_ENABLED: "true" });
  });

  it("never forwards any other worker var/secret (only the two encode flags)", () => {
    const out = recorderContainerEnvVars({
      AV1_DEFAULT: "1",
      NEGOTIATION_ENABLED: "true",
      // extra keys that must NOT leak into the container env:
      ...({ RT_RECORD: "1", GATEWAY_BASE_URL: "https://api.wave.online", CF_API_TOKEN: "secret" } as object),
    } as { AV1_DEFAULT?: string; NEGOTIATION_ENABLED?: string });
    expect(Object.keys(out ?? {}).sort()).toEqual(["AV1_DEFAULT", "NEGOTIATION_ENABLED"]);
  });
});
