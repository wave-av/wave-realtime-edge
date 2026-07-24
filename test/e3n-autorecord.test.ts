// E3n (wre#290) — the ONE flag truthiness contract gating both auto-record enable + the completion sweep.
import { describe, it, expect } from "vitest";
import { e3nAutorecordEnabled } from "../src/e3n-autorecord.js";

describe("e3nAutorecordEnabled", () => {
  it("is OFF when absent", () => {
    expect(e3nAutorecordEnabled({})).toBe(false);
  });
  it.each(["0", "false", "no", "", "TRUE", "yes"])("is OFF for %j", (v) => {
    expect(e3nAutorecordEnabled({ E3N_AUTORECORD_ENABLED: v })).toBe(false);
  });
  it.each(["1", "true", true])("is ON for %j", (v) => {
    expect(e3nAutorecordEnabled({ E3N_AUTORECORD_ENABLED: v as string | boolean })).toBe(true);
  });
  it("is OFF for boolean false", () => {
    expect(e3nAutorecordEnabled({ E3N_AUTORECORD_ENABLED: false })).toBe(false);
  });
});
