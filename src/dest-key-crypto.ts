/**
 * DEST-KEY CRYPTO (#18, W1 O3 dest-mgmt) — encrypt-at-rest for the sensitive fields on an external egress
 * destination: `streamKey` (RTMP) / `passphrase` (SRT). Only CIPHERTEXT + IV are ever written to KV; the
 * plaintext exists in memory only for the duration of a create-request or an arm-time decrypt, and is never
 * logged (see `redactErrorMessage` below + `redactDestination` in egress-destinations.ts for the response path).
 *
 * SCHEME: AES-256-GCM via WebCrypto (`crypto.subtle`) — the SAME primitive family this codebase already uses for
 * HMAC (`event-emitter.ts`, `rtms-auth.ts`, `stream-bridge.ts` all use `crypto.subtle` — no new crypto library
 * introduced). AES-GCM is authenticated (tamper-evident: a flipped ciphertext byte fails decrypt, it doesn't
 * silently return garbage) and is the standard Workers-native symmetric cipher (no Node `crypto` polyfill needed).
 *
 * KEY SOURCE: `env.DEST_KEY_ENCRYPTION_KEY` — a wrangler SECRET (Doppler-provisioned, ◆ gate — see wrangler.toml).
 * Expected as a base64-encoded 32-byte (256-bit) raw key. This module NEVER generates or defaults a key: an
 * absent/malformed secret makes `getAesKey` throw, which the caller (egress-destinations.ts) turns into a loud
 * 503 "not configured" — never a silent fallback to an unencrypted or hardcoded key.
 *
 * IV: a fresh random 12-byte IV per encrypt call (`crypto.getRandomValues`), stored alongside the ciphertext
 * (both base64) — AES-GCM requires a unique IV per (key, plaintext) pair; reuse would break confidentiality.
 */

export interface DestKeyCryptoEnv {
  /** Base64-encoded 32-byte AES-256-GCM key. wrangler SECRET — `wrangler secret put DEST_KEY_ENCRYPTION_KEY`
   *  (Doppler wave/prd). TODO(doppler ◆): value NOT set here — provisioning is a Jake-named crossing. */
  DEST_KEY_ENCRYPTION_KEY?: string;
}

/** An encrypted field as persisted in KV: base64 ciphertext + base64 IV. Never contains plaintext. */
export interface EncryptedField {
  ciphertext: string;
  iv: string;
}

const AES_ALGO = "AES-GCM";
const IV_BYTES = 12; // 96-bit IV, the AES-GCM-recommended length

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Import the raw AES-256 key from `env.DEST_KEY_ENCRYPTION_KEY`. Throws (never defaults/silently no-ops) when
 *  the secret is absent, not valid base64, or not exactly 32 bytes decoded — a misconfigured key must fail LOUD
 *  at the call site (503), never silently produce a weak/wrong-length key. */
export async function getAesKey(env: DestKeyCryptoEnv): Promise<CryptoKey> {
  const raw = env.DEST_KEY_ENCRYPTION_KEY;
  if (!raw) throw new Error("DEST_KEY_ENCRYPTION_KEY is not configured");
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(raw);
  } catch {
    throw new Error("DEST_KEY_ENCRYPTION_KEY is not valid base64");
  }
  if (keyBytes.length !== 32) {
    throw new Error(`DEST_KEY_ENCRYPTION_KEY must decode to 32 bytes (256-bit AES key), got ${keyBytes.length}`);
  }
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, AES_ALGO, false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext field (streamKey/passphrase) with a fresh random IV. Returns base64 ciphertext+iv only —
 *  the plaintext is never retained by this function past the call. */
export async function encryptField(key: CryptoKey, plaintext: string): Promise<EncryptedField> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const enc = new TextEncoder().encode(plaintext);
  const ciphertextBuf = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, enc);
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    iv: bytesToBase64(iv),
  };
}

/** Decrypt a previously-encrypted field. Only called at ARM time (egress-arm consumers), never on the
 *  list/get response path. Throws on tamper/wrong-key (AES-GCM auth-tag failure) — the caller must treat that
 *  as a hard failure, not a silent empty string. */
export async function decryptField(key: CryptoKey, field: EncryptedField): Promise<string> {
  const iv = base64ToBytes(field.iv);
  const ciphertext = base64ToBytes(field.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: AES_ALGO, iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return new TextDecoder().decode(plainBuf);
}

/** Redacted marker returned in place of a plaintext/ciphertext field in ANY response or log line. Never the
 *  literal ciphertext (which is still sensitive-adjacent — no reason to expose it either) and never a length
 *  hint that could aid a guess. */
export const REDACTED_MARKER = "[redacted]";

/** Strip a raw error message of anything that might carry key material before it reaches a log/console call
 *  (e.g. a WebCrypto error rethrown from a caller that concatenated user input). Defense-in-depth: the encrypt/
 *  decrypt functions above never include plaintext in their own thrown messages, but a caller composing an
 *  error string around a caught exception could accidentally do so — this normalizes to a safe, short message. */
export function redactErrorForLog(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  // Only pass through short, known-safe messages (throws above are already plaintext-free); anything longer
  // than a generous bound is truncated rather than risk echoing unexpected content.
  return msg.length > 200 ? `${msg.slice(0, 200)}... [truncated]` : msg;
}
