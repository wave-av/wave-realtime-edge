// E3.P2/P4 (#127) — unit tests for the realtime data-residency resolver (src/residency-rt.ts). PURE, no
// runtime. Proves the continent→zone map, zone→binding map, the org-prefixed region key, and the
// fail-to-default behavior for unmapped continents (never invent a zone).
import { describe, it, expect } from "vitest";
import {
  zoneFromContinent,
  bindingForZone,
  placementForContinent,
  bucketForBinding,
  residencyRecordingKey,
} from "../src/residency-rt.js";

describe("residency-rt zone resolver (#127)", () => {
  it("maps NA→us-east and EU→eu-west (case-insensitive)", () => {
    expect(zoneFromContinent("NA")).toBe("us-east");
    expect(zoneFromContinent("EU")).toBe("eu-west");
    expect(zoneFromContinent("na")).toBe("us-east");
    expect(zoneFromContinent("eu")).toBe("eu-west");
  });

  it("#114 T3: AS/OC→ap-southeast, SA→sa-east now resolve; truly-unmapped continents still → null", () => {
    expect(zoneFromContinent("AS")).toBe("ap-southeast");
    expect(zoneFromContinent("OC")).toBe("ap-southeast");
    expect(zoneFromContinent("SA")).toBe("sa-east");
    // AF/AN have no region entry; blank/absent inputs never invent a zone.
    for (const c of ["AF", "AN", "", "  ", undefined, null]) {
      expect(zoneFromContinent(c as string | null | undefined)).toBeNull();
    }
  });

  it("maps each zone to its residency-correct wrangler binding", () => {
    expect(bindingForZone("us-east")).toBe("RT_RECORDINGS_ENAM");
    expect(bindingForZone("eu-west")).toBe("RT_RECORDINGS_EU");
  });

  it("placementForContinent pairs zone + binding, null for unmapped", () => {
    expect(placementForContinent("NA")).toEqual({ zone: "us-east", binding: "RT_RECORDINGS_ENAM" });
    expect(placementForContinent("EU")).toEqual({ zone: "eu-west", binding: "RT_RECORDINGS_EU" });
    // #114 T3: AS/SA now resolve to their region's binding; AF stays unmapped → null.
    expect(placementForContinent("AS")).toEqual({ zone: "ap-southeast", binding: "RT_RECORDINGS_APAC" });
    expect(placementForContinent("SA")).toEqual({ zone: "sa-east", binding: "RT_RECORDINGS_SAM" });
    expect(placementForContinent("AF")).toBeNull();
  });

  it("bucketForBinding returns the bound R2 bucket or null when unbound", () => {
    const fakeBucket = {} as unknown as R2Bucket;
    expect(bucketForBinding({ RT_RECORDINGS_ENAM: fakeBucket }, "RT_RECORDINGS_ENAM")).toBe(fakeBucket);
    expect(bucketForBinding({}, "RT_RECORDINGS_EU")).toBeNull();
  });

  it("residencyRecordingKey starts with the org prefix AND carries the region segment", () => {
    const org = "11111111-1111-4111-8111-111111111111";
    const k = residencyRecordingKey(org, "eu-west", "sess-abc", "webm");
    expect(k.startsWith(`${org}/`)).toBe(true); // register org-prefix invariant
    expect(k).toBe(`${org}/realtime-recordings/eu-west/sess-abc/recording.webm`);
    expect(k).toContain("/eu-west/"); // self-describing region segment
  });
});
