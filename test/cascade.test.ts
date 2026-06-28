// #82 EX P2/P3 — unit tests for the cascade resolver (src/cascade.ts). PURE, no runtime, no DO. Proves the
// relay-key strict-suffix invariant, region→locationHint placement, the continent→nearest-region map, the
// nearest-first distribution ladders (each a permutation with the right head), and the nearest-HEALTHY
// selection (skip-unhealthy, fall to null when none healthy / unknown continent).
import { describe, it, expect } from "vitest";
import {
  CASCADE_REGIONS,
  isCascadeRegion,
  primaryRoomKey,
  relayRoomKey,
  relayLocationHint,
  regionFromContinent,
  distributionLadder,
  nearestHealthyRegion,
  relayPlacement,
  type CascadeRegion,
} from "../src/cascade.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const ROOM = "stage-main";

describe("cascade region set (#82)", () => {
  it("is exactly the nine CF DurableObjectLocationHint members", () => {
    expect([...CASCADE_REGIONS].sort()).toEqual(
      ["afr", "apac", "eeur", "enam", "me", "oc", "sam", "weur", "wnam"].sort(),
    );
  });

  it("isCascadeRegion narrows valid regions and rejects everything else", () => {
    for (const r of CASCADE_REGIONS) expect(isCascadeRegion(r)).toBe(true);
    for (const bad of ["us-east", "eu-west", "EU", "", "earth", 42, null, undefined]) {
      expect(isCascadeRegion(bad)).toBe(false);
    }
  });
});

describe("relay key derivation — strict suffix of primary (#82 P2)", () => {
  it("primaryRoomKey is the unchanged org:room key", () => {
    expect(primaryRoomKey(ORG, ROOM)).toBe(`${ORG}:${ROOM}`);
  });

  it("relayRoomKey appends :region and keeps the primary as a strict prefix", () => {
    const primary = primaryRoomKey(ORG, ROOM);
    for (const region of CASCADE_REGIONS) {
      const relay = relayRoomKey(ORG, ROOM, region);
      expect(relay).toBe(`${primary}:${region}`);
      expect(relay.startsWith(`${primary}:`)).toBe(true); // ADR invariant: strict suffix
      expect(relay).not.toBe(primary); // never collides with the primary
    }
  });

  it("relayLocationHint is the region itself (region IS a CF location hint)", () => {
    for (const region of CASCADE_REGIONS) {
      expect(relayLocationHint(region)).toBe(region);
    }
  });
});

describe("continent → nearest region (#82 P3)", () => {
  it("maps each CF continent code to a region (case-insensitive)", () => {
    expect(regionFromContinent("NA")).toBe("enam");
    expect(regionFromContinent("na")).toBe("enam");
    expect(regionFromContinent("SA")).toBe("sam");
    expect(regionFromContinent("EU")).toBe("weur");
    expect(regionFromContinent("AS")).toBe("apac");
    expect(regionFromContinent("AF")).toBe("afr");
    expect(regionFromContinent("OC")).toBe("oc");
    expect(regionFromContinent("AN")).toBe("weur"); // Antarctica folds to Europe
  });

  it("returns null for absent/unknown continent (caller uses a deployment default, never invents)", () => {
    for (const c of ["", "  ", "XX", undefined, null]) {
      expect(regionFromContinent(c as string | null | undefined)).toBeNull();
    }
  });
});

describe("distribution ladder — nearest-first, full permutation (#82 P3)", () => {
  const CONTINENTS = ["NA", "SA", "EU", "AS", "AF", "OC", "AN"];

  it("each ladder is a permutation of all regions whose head is the nearest region", () => {
    for (const c of CONTINENTS) {
      const ladder = distributionLadder(c);
      expect(ladder).not.toBeNull();
      const l = ladder as readonly CascadeRegion[];
      // head == nearest region
      expect(l[0]).toBe(regionFromContinent(c));
      // full permutation: every region present exactly once
      expect([...l].sort()).toEqual([...CASCADE_REGIONS].sort());
      expect(new Set(l).size).toBe(CASCADE_REGIONS.length);
    }
  });

  it("is case-insensitive and null for unknown continent", () => {
    expect(distributionLadder("eu")).toEqual(distributionLadder("EU"));
    expect(distributionLadder("XX")).toBeNull();
    expect(distributionLadder(null)).toBeNull();
  });
});

describe("nearestHealthyRegion — skip unhealthy, descend the ladder (#82 P3)", () => {
  it("returns the nearest region when it is healthy", () => {
    expect(nearestHealthyRegion("EU", () => true)).toBe("weur");
  });

  it("descends to the next healthy region when nearer ones are down", () => {
    // EU ladder head=weur; mark weur+eeur down → next is `me`.
    const down = new Set<CascadeRegion>(["weur", "eeur"]);
    expect(nearestHealthyRegion("EU", (r) => !down.has(r))).toBe("me");
  });

  it("returns null when NO region on the ladder is healthy (caller falls back to primary)", () => {
    expect(nearestHealthyRegion("AS", () => false)).toBeNull();
  });

  it("returns null for an unknown continent (no ladder to walk)", () => {
    expect(nearestHealthyRegion("XX", () => true)).toBeNull();
  });

  it("never serves an unhealthy region even if it is the nearest", () => {
    const onlyEnamUp = (r: CascadeRegion) => r === "enam";
    // NA head=enam (healthy) → enam; but if enam is the ONLY healthy one, EU still routes to enam down its tail.
    expect(nearestHealthyRegion("NA", onlyEnamUp)).toBe("enam");
    expect(nearestHealthyRegion("EU", onlyEnamUp)).toBe("enam");
  });
});

describe("relayPlacement — one-call key + hint, no DO spawned (#82 P2)", () => {
  it("bundles region, suffix key, and locationHint consistently", () => {
    for (const region of CASCADE_REGIONS) {
      const p = relayPlacement(ORG, ROOM, region);
      expect(p).toEqual({
        region,
        key: `${ORG}:${ROOM}:${region}`,
        locationHint: region,
      });
    }
  });
});
