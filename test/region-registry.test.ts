import { describe, expect, it } from "vitest";
import {
	REGION_REGISTRY,
	activeRegions,
	activeZones,
	isActiveZone,
	regionForBinding,
	regionForContinent,
	regionForZone,
} from "../src/region-registry.js";

describe("region-registry (#114 N-region SSOT)", () => {
	it("the two LIVE (#127) regions are enabled and reproduce the proven us-east/eu-west pair", () => {
		const zones = activeZones();
		expect(zones).toEqual(["us-east", "eu-west"]);
		const na = regionForContinent("NA");
		expect(na?.zone).toBe("us-east");
		expect(na?.binding).toBe("RT_RECORDINGS_ENAM");
		expect(na?.bucketName).toBe("wave-recordings-enam");
		expect(na?.jurisdiction).toBe("default");
		expect(na?.cascadeHint).toBe("enam");
		const eu = regionForContinent("EU");
		expect(eu?.zone).toBe("eu-west");
		expect(eu?.binding).toBe("RT_RECORDINGS_EU");
		expect(eu?.bucketName).toBe("wave-recordings-eu");
		expect(eu?.jurisdiction).toBe("eu");
		expect(eu?.cascadeHint).toBe("weur");
	});

	it("staged regions are INERT: enabled:false → continents fall to the default path (null)", () => {
		// APAC / SAM are authored but disabled — behavior-identical to today (no residency for AS/OC/SA).
		expect(regionForContinent("AS")).toBeNull();
		expect(regionForContinent("OC")).toBeNull();
		expect(regionForContinent("SA")).toBeNull();
		expect(regionForContinent("AF")).toBeNull();
		// The staged entries EXIST in the raw registry (ready to flip) but are not active.
		expect(REGION_REGISTRY.some((r) => r.zone === "ap-southeast" && !r.enabled)).toBe(true);
		expect(REGION_REGISTRY.some((r) => r.zone === "sa-east" && !r.enabled)).toBe(true);
		expect(activeRegions().every((r) => r.enabled)).toBe(true);
	});

	it("case-insensitive continent lookup; unknown continent → null", () => {
		expect(regionForContinent("na")?.zone).toBe("us-east");
		expect(regionForContinent("eu")?.zone).toBe("eu-west");
		expect(regionForContinent(null)).toBeNull();
		expect(regionForContinent("ZZ")).toBeNull();
	});

	it("zone/binding lookups only resolve ACTIVE regions", () => {
		expect(regionForZone("us-east")?.binding).toBe("RT_RECORDINGS_ENAM");
		expect(regionForBinding("RT_RECORDINGS_EU")?.zone).toBe("eu-west");
		expect(isActiveZone("eu-west")).toBe(true);
		// staged/disabled zone + binding do not resolve while inert
		expect(regionForZone("ap-southeast")).toBeNull();
		expect(regionForBinding("RT_RECORDINGS_APAC")).toBeNull();
		expect(isActiveZone("ap-southeast")).toBe(false);
	});

	it("each continent appears in at most one enabled region (no residency ambiguity)", () => {
		const seen = new Set<string>();
		for (const r of activeRegions()) {
			for (const c of r.continents) {
				expect(seen.has(c)).toBe(false);
				seen.add(c);
			}
		}
	});

	it("every enabled region's cascadeHint is a real CF DurableObjectLocationHint", () => {
		const HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];
		for (const r of REGION_REGISTRY) expect(HINTS).toContain(r.cascadeHint);
	});
});
