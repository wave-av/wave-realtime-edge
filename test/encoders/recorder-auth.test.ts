// RT-R9 — signed capability token for the recorder WS dial-in. Pure WebCrypto (vitest provides crypto.subtle).
// Proves: mint→verify roundtrip; tampered scope (org/session/track) → false; expired → false; wrong secret →
// false; malformed token → false (never throws). The token is what lets the third-party SFU authenticate the
// recorder-route dial-in without our internal header.
import { describe, it, expect } from "vitest";
import { mintRecorderToken, verifyRecorderToken } from "../../src/encoders/recorder-auth.js";

const SECRET = "internal-secret-xyz";
const ORG = "org_x";
const SESSION = "sess_ABC12345";
const TRACK = "mic";

describe("mintRecorderToken / verifyRecorderToken", () => {
  it("mint → verify roundtrip is true", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK);
    expect(await verifyRecorderToken(SECRET, ORG, SESSION, TRACK, t)).toBe(true);
  });

  it("tampered org → false", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK);
    expect(await verifyRecorderToken(SECRET, "org_other", SESSION, TRACK, t)).toBe(false);
  });

  it("tampered sessionId → false", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK);
    expect(await verifyRecorderToken(SECRET, ORG, "sess_OTHER", TRACK, t)).toBe(false);
  });

  it("tampered trackName → false", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK);
    expect(await verifyRecorderToken(SECRET, ORG, SESSION, "cam", t)).toBe(false);
  });

  it("expired (minted in the past) → false", async () => {
    const past = Date.now() - 10_000 * 1000; // mint far enough back that exp < now
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK, { ttlSec: 1, now: past });
    expect(await verifyRecorderToken(SECRET, ORG, SESSION, TRACK, t)).toBe(false);
  });

  it("not-yet-expired when verified with a now BEFORE exp → true", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK, { ttlSec: 100, now: 1_000_000_000_000 });
    expect(await verifyRecorderToken(SECRET, ORG, SESSION, TRACK, t, { now: 1_000_000_000_000 })).toBe(true);
  });

  it("wrong secret → false", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK);
    expect(await verifyRecorderToken("a-different-secret", ORG, SESSION, TRACK, t)).toBe(false);
  });

  it("malformed tokens → false (no throw)", async () => {
    for (const bad of ["", ".", "abc", "notanumber.sig", "123", "123.", ".sig", "12.3.bad/base64+", "999999999999.@@@"]) {
      await expect(verifyRecorderToken(SECRET, ORG, SESSION, TRACK, bad)).resolves.toBe(false);
    }
  });

  it("exp is honored — token is per-(org,session,track) scoped, no cross-use", async () => {
    const t = await mintRecorderToken(SECRET, ORG, SESSION, TRACK);
    // a token for one track must not validate another track of the SAME session
    expect(await verifyRecorderToken(SECRET, ORG, SESSION, "speaker", t)).toBe(false);
  });
});
