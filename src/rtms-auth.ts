/**
 * Zoom RTMS authentication primitives (#88 Zoom→wave bridge).
 *
 * Pure, I/O-free crypto for the two auth surfaces of the RTMS native-WebSocket
 * flow, verified against Zoom's reference mock server + native-WS docs:
 *
 *   1. Webhook `endpoint.url_validation` — Zoom sends a `plainToken`; we echo it
 *      plus `encryptedToken = HMAC-SHA256(plainToken, webhookSecretToken)` hex.
 *   2. Signaling / data handshake `signature` —
 *      HMAC-SHA256(`${clientId},${meetingUuid},${rtmsStreamId}`, clientSecret) hex.
 *      (Per-media encryption keys use `${meetingUuid},${rtmsStreamId},AUDIO` etc.)
 *
 * Also included: inbound webhook request signature verification
 * (`x-zm-signature: v0=HMAC-SHA256(secretToken, "v0:${ts}:${rawBody}")`).
 *
 * Uses WebCrypto (`crypto.subtle`) — the only HMAC available in the Workers
 * runtime; every function is therefore async. Credentials arrive as env strings
 * (ZOOM_APPS_CLIENT_ID / ZOOM_APPS_CLIENT_SECRET / ZOOM_WEBHOOK_SECRET) — this
 * module never reads env itself and never logs a secret.
 */

const enc = new TextEncoder();

async function hmacSha256(keyStr: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time compare of two hex strings (avoids signature-timing leaks). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256(keyStr, msg) as lowercase hex. */
export async function hmacSha256Hex(keyStr: string, msg: string): Promise<string> {
  return toHex(await hmacSha256(keyStr, msg));
}

/**
 * The RTMS signaling/data handshake `signature` field:
 * HMAC-SHA256(`${clientId},${meetingUuid},${rtmsStreamId}`, clientSecret) hex.
 */
export async function rtmsHandshakeSignature(
  clientId: string,
  meetingUuid: string,
  rtmsStreamId: string,
  clientSecret: string,
): Promise<string> {
  return hmacSha256Hex(clientSecret, `${clientId},${meetingUuid},${rtmsStreamId}`);
}

export type RtmsMediaKind = "AUDIO" | "VIDEO" | "SHARE" | "TRANSCRIPT";

/**
 * Per-media payload-encryption key seed:
 * HMAC-SHA256(`${meetingUuid},${rtmsStreamId},${kind}`, clientSecret) hex.
 */
export async function rtmsMediaEncryptionKey(
  meetingUuid: string,
  rtmsStreamId: string,
  kind: RtmsMediaKind,
  clientSecret: string,
): Promise<string> {
  return hmacSha256Hex(clientSecret, `${meetingUuid},${rtmsStreamId},${kind}`);
}

/** The JSON body to return for a Zoom `endpoint.url_validation` challenge. */
export interface UrlValidationResponse {
  plainToken: string;
  encryptedToken: string;
}

/** Build the `endpoint.url_validation` response for a given plainToken. */
export async function rtmsUrlValidationResponse(
  plainToken: string,
  webhookSecretToken: string,
): Promise<UrlValidationResponse> {
  return { plainToken, encryptedToken: await hmacSha256Hex(webhookSecretToken, plainToken) };
}

/**
 * Verify an inbound Zoom webhook request signature. Zoom signs each POST with
 * `x-zm-signature: v0=HMAC-SHA256(secretToken, "v0:${timestamp}:${rawBody}")`,
 * where `timestamp` is the `x-zm-request-timestamp` header. Returns false on any
 * mismatch or malformed signature — callers should treat false as a 401.
 */
export async function verifyZoomWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  webhookSecretToken: string,
): Promise<boolean> {
  if (!signatureHeader || !timestampHeader) return false;
  const expected = "v0=" + (await hmacSha256Hex(webhookSecretToken, `v0:${timestampHeader}:${rawBody}`));
  return timingSafeEqualHex(signatureHeader, expected);
}
