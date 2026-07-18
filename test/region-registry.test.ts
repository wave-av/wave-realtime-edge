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
	it("the four LIVE regions (us-east/eu-west + #114 T3 apac/sam) are enabled with the proven bindings", () => {
		const zones = activeZones();
		expect(zones).toEqual(["us-east", "eu-west", "ap-southeast", "sa-east"]);
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
		const apac = regionForContinent("AS");
		expect(apac?.zone).toBe("ap-southeast");
		expect(apac?.binding).toBe("RT_RECORDINGS_APAC");
		expect(apac?.bucketName).toBe("wave-recordings-apac");
		expect(apac?.jurisdiction).toBe("default");
		expect(apac?.cascadeHint).toBe("apac");
		const sam = regionForContinent("SA");
		expect(sam?.zone).toBe("sa-east");
		expect(sam?.binding).toBe("RT_RECORDINGS_SAM");
		expect(sam?.bucketName).toBe("wave-recordings-sam");
		expect(sam?.cascadeHint).toBe("sam");
	});

	it("#114 T3 LIVE: AS/OC → apac, SA → sam; unstaged continents still fall to default (null)", () => {
		// APAC / SAM are now enabled (#114 T3) — AS/OC/SA resolve to their region; AF has no region → null.
		expect(regionForContinent("AS")?.zone).toBe("ap-southeast");
		expect(regionForContinent("OC")?.zone).toBe("ap-southeast");
		expect(regionForContinent("SA")?.zone).toBe("sa-east");
		expect(regionForContinent("AF")).toBeNull();
		expect(REGION_REGISTRY.some((r) => r.zone === "ap-southeast" && r.enabled)).toBe(true);
		expect(REGION_REGISTRY.some((r) => r.zone === "sa-east" && r.enabled)).toBe(true);
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
		// #114 T3: apac zone + binding now resolve (region enabled)
		expect(regionForZone("ap-southeast")?.binding).toBe("RT_RECORDINGS_APAC");
		expect(regionForBinding("RT_RECORDINGS_APAC")?.zone).toBe("ap-southeast");
		expect(isActiveZone("ap-southeast")).toBe(true);
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
