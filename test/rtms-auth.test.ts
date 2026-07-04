// Zoom RTMS auth primitives (#88) — HMAC pinned to a published test vector.
import { describe, it, expect } from "vitest";
import {
  hmacSha256Hex,
  rtmsHandshakeSignature,
  rtmsMediaEncryptionKey,
  rtmsUrlValidationResponse,
  verifyZoomWebhookSignature,
  timingSafeEqualHex,
} from "../src/rtms-auth.js";

describe("hmacSha256Hex — pinned to the canonical HMAC-SHA256 test vector", () => {
  it("matches the well-known RFC/Wikipedia vector for key='key'", async () => {
    // HMAC_SHA256("key", "The quick brown fox jumps over the lazy dog") — the
    // canonical published vector. This proves the WebCrypto HMAC is correct,
    // not merely self-consistent.
    const hex = await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
    expect(hex).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("rtmsHandshakeSignature", () => {
  it("signs the exact `${clientId},${meetingUuid},${rtmsStreamId}` string with the client secret", async () => {
    const clientId = "APPID123", uuid = "mtg-uuid-xyz", stream = "stream-77", secret = "s3cr3t";
    const got = await rtmsHandshakeSignature(clientId, uuid, stream, secret);
    const expected = await hmacSha256Hex(secret, `${clientId},${uuid},${stream}`);
    expect(got).toBe(expected);
    expect(got).toMatch(/^[0-9a-f]{64}$/); // lowercase hex, 32 bytes
  });

  it("per-media encryption key seeds off `${uuid},${stream},AUDIO`", async () => {
    const got = await rtmsMediaEncryptionKey("u", "s", "AUDIO", "sec");
    expect(got).toBe(await hmacSha256Hex("sec", "u,s,AUDIO"));
  });
});

describe("rtmsUrlValidationResponse", () => {
  it("echoes plainToken and sets encryptedToken = HMAC(webhookSecret, plainToken)", async () => {
    const plainToken = "abc123plain";
    const res = await rtmsUrlValidationResponse(plainToken, "whsec");
    expect(res.plainToken).toBe(plainToken);
    expect(res.encryptedToken).toBe(await hmacSha256Hex("whsec", plainToken));
  });
});

describe("verifyZoomWebhookSignature", () => {
  const secret = "whsecret", body = '{"event":"meeting.rtms_started"}', ts = "1720000000";
  it("accepts a correctly signed request", async () => {
    const sig = "v0=" + (await hmacSha256Hex(secret, `v0:${ts}:${body}`));
    expect(await verifyZoomWebhookSignature(body, sig, ts, secret)).toBe(true);
  });
  it("rejects a tampered body, wrong ts, or missing headers", async () => {
    const sig = "v0=" + (await hmacSha256Hex(secret, `v0:${ts}:${body}`));
    expect(await verifyZoomWebhookSignature(body + "x", sig, ts, secret)).toBe(false);
    expect(await verifyZoomWebhookSignature(body, sig, "9999", secret)).toBe(false);
    expect(await verifyZoomWebhookSignature(body, null, ts, secret)).toBe(false);
    expect(await verifyZoomWebhookSignature(body, sig, null, secret)).toBe(false);
  });
});

describe("timingSafeEqualHex", () => {
  it("is true only for identical equal-length strings", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
    expect(timingSafeEqualHex("dead", "deadbeef")).toBe(false);
  });
});
