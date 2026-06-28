/**
 * RT-R9 — signed capability token for the raw-SFU recorder WS dial-in (auth gap fix).
 *
 * THE GAP: the CF Realtime SFU dials OUT to OUR hibernatable Worker recorder route
 * (`/v1/realtime/recorder/:org/:sessionId/:trackName`) per the container-encoder adapter. That route is
 * behind `gatewayGate` (it requires the `x-wave-internal` header when `WAVE_INTERNAL_SECRET` is set), but
 * the SFU is a third party — it CANNOT attach our internal header. So an armed recorder would 401 every
 * dial-in and record nothing. This module mints a short-lived, per-(org,sessionId,trackName) capability
 * token the adapter appends to the endpoint URL as `?t=...`; the route validates it as an alternative to
 * `x-wave-internal`, so the SFU authenticates itself without ever seeing the internal secret.
 *
 * DESIGN: HMAC-SHA256 over `${org}.${sessionId}.${trackName}.${exp}` keyed by `WAVE_INTERNAL_SECRET`. The
 * token is `${exp}.${base64url(sig)}` — scoped to exactly one track of one session, and expiring (default
 * 2h), so a leaked URL cannot be replayed against another recording or after the session window. Pure
 * WebCrypto, no I/O. SKIP-clean: NEVER imports `@wave-av/content-hash` (this is the SKIP write-path).
 */

const DEFAULT_TTL_SEC = 7200;

/** Mint a capability token authorizing the SFU to dial the recorder route for ONE (org, session, track). */
export async function mintRecorderToken(
  secret: string,
  org: string,
  sessionId: string,
  trackName: string,
  opts?: { ttlSec?: number; now?: number },
): Promise<string> {
  const exp = Math.floor((opts?.now ?? Date.now()) / 1000) + (opts?.ttlSec ?? DEFAULT_TTL_SEC);
  const msg = `${org}.${sessionId}.${trackName}.${exp}`;
  const sig = await hmac(secret, msg);
  return `${exp}.${base64urlEncode(sig)}`;
}

/**
 * Verify a capability token against the expected (org, session, track) scope. Returns false on ANY
 * malformed/expired/tampered/wrong-secret input — NEVER throws. Constant-time signature comparison.
 */
export async function verifyRecorderToken(
  secret: string,
  org: string,
  sessionId: string,
  trackName: string,
  token: string,
  opts?: { now?: number },
): Promise<boolean> {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    const expStr = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    if (!/^\d+$/.test(expStr) || sigB64.length === 0) return false;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp)) return false;
    const nowSec = Math.floor((opts?.now ?? Date.now()) / 1000);
    if (exp < nowSec) return false;
    const expected = await hmac(secret, `${org}.${sessionId}.${trackName}.${exp}`);
    const got = base64urlDecode(sigB64);
    if (got === null) return false;
    return constantTimeEqual(expected, got);
  } catch {
    return false;
  }
}

/** HMAC-SHA256(secret, msg) → raw signature bytes via WebCrypto (no Node crypto). */
async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return new Uint8Array(sig);
}

/** Length-checked, XOR-accumulating constant-time byte compare (no early return on mismatch). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url encode (RFC 4648 §5, no padding) — no '+', '/', '='. Self-contained (no atob/btoa). */
function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63] + B64URL_ALPHABET[(n >> 6) & 63] + B64URL_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63] + B64URL_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** base64url decode — returns null on any invalid character/length (never throws). */
function base64urlDecode(s: string): Uint8Array | null {
  const n = s.length;
  if (n % 4 === 1) return null; // impossible base64url length
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = B64URL_ALPHABET.indexOf(s[i]);
    if (v < 0) return null; // invalid char (incl '+', '/', '=')
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
