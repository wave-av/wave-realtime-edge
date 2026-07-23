// #18 encrypt-at-rest — proves: a valid 32-byte base64 key round-trips encrypt/decrypt, ciphertext is NOT the
// plaintext, tamper (flipped ciphertext byte) fails decrypt loudly (AES-GCM auth-tag), a wrong key fails
// decrypt, and a missing/malformed/wrong-length DEST_KEY_ENCRYPTION_KEY throws (never silently no-ops).
import { describe, it, expect } from "vitest";
import { decryptField, encryptField, getAesKey } from "../src/dest-key-crypto.js";

function base64Key(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("getAesKey", () => {
  it("throws when DEST_KEY_ENCRYPTION_KEY is absent", async () => {
    await expect(getAesKey({})).rejects.toThrow(/not configured/);
  });

  it("throws when the secret is not valid base64", async () => {
    await expect(getAesKey({ DEST_KEY_ENCRYPTION_KEY: "!!!not-base64!!!" })).rejects.toThrow();
  });

  it("throws when the decoded key is not 32 bytes", async () => {
    await expect(getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(16) })).rejects.toThrow(/32 bytes/);
  });

  it("succeeds with a valid 32-byte base64 key", async () => {
    const key = await getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(32) });
    expect(key).toBeTruthy();
  });
});

describe("encryptField / decryptField", () => {
  it("round-trips plaintext", async () => {
    const key = await getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(32) });
    const enc = await encryptField(key, "sk_live_super_secret_stream_key");
    expect(enc.ciphertext).not.toContain("sk_live_super_secret_stream_key");
    const plain = await decryptField(key, enc);
    expect(plain).toBe("sk_live_super_secret_stream_key");
  });

  it("produces a DIFFERENT ciphertext + iv each call (fresh random IV per encrypt)", async () => {
    const key = await getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(32) });
    const a = await encryptField(key, "same-plaintext");
    const b = await encryptField(key, "same-plaintext");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails decrypt on a tampered ciphertext (AES-GCM auth-tag catches it)", async () => {
    const key = await getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(32) });
    const enc = await encryptField(key, "passphrase-1");
    const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -4) + (enc.ciphertext.slice(-4) === "AAAA" ? "BBBB" : "AAAA") };
    await expect(decryptField(key, tampered)).rejects.toThrow();
  });

  it("fails decrypt with the wrong key", async () => {
    const keyA = await getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(32) });
    const keyB = await getAesKey({ DEST_KEY_ENCRYPTION_KEY: base64Key(32) });
    const enc = await encryptField(keyA, "secret");
    await expect(decryptField(keyB, enc)).rejects.toThrow();
  });
});
