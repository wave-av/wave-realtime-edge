/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R-WH — the RealtimeKit `recording.statusUpdate` webhook (design §2, completion signal).
 *
 * In the SHIPPED managed-recording path (adapter C, "direct" mode) RTK uploads the finished meeting
 * recording STRAIGHT to our R2 bucket at an org-rooted key (`${org}/realtime-recordings/${meetingId}/…`),
 * and the daily storage sweep bills it by org-prefix — so this webhook is NOT load-bearing for storage or
 * billing. Its job is the authoritative, signed COMPLETION / OBSERVABILITY signal:
 *   • UPLOADED → the recording is ready (id, meetingId, fileSize, outputFileName) — surfaceable + auditable.
 *   • ERRORED  → a recording failed on CF's side — must be VISIBLE, never swallowed.
 * It mutates nothing, so it is idempotent by nature; RTK retries until a 2xx, so a valid event always acks.
 *
 * SECURITY (load-bearing): this is the ONE realtime-edge route that is intentionally NOT behind the gateway
 * (`x-wave-internal`) — RTK calls it directly from the public internet. It therefore authenticates itself:
 * the `rtk-signature` header is a Base64 RSA-SHA256 signature over the RAW request body, verified against
 * CF's published public key BEFORE the body is parsed. A missing/invalid signature → 401, nothing acted on.
 * The key host and the CF REST host are fixed literals (no request-derived URLs → SSRF-safe).
 *
 * tier=SKIP-clean: this module imports NO `@wave-av/content-hash` and touches NO dedup index.
 */

/** CF's published RTK webhook public key — `{ success, data: { publicKey: "-----BEGIN PUBLIC KEY-----…" } }`. */
const WEBHOOK_KEYS_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json"; // fixed host (SSRF-safe)

/** The recording fields we read off a `recording.statusUpdate` payload (RTK camelCase). */
export interface RtkRecording {
  id: string;
  status: string; // INVOKED | RECORDING | UPLOADING | UPLOADED | ERRORED
  downloadUrl?: string;
  outputFileName?: string;
  fileSize?: number;
  meetingId?: string;
  recordingDuration?: number;
}

export interface RtkWebhookEvent {
  event: string;
  recording: RtkRecording;
}

/** Decode a base64 string to bytes. Throws on invalid base64 (atob) — callers treat a throw as "reject". */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strip a PEM's armor + whitespace and base64-decode the body to SPKI DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return b64ToBytes(body);
}

/**
 * Fetch CF's RTK webhook public key(s). The well-known doc returns ONE PEM at `data.publicKey`; we also
 * accept a future `data.publicKeys[]` so a key rotation that publishes both doesn't break verification.
 * Throws if the doc is unreachable or carries no key (the caller answers 503 — fail-closed, never "trust").
 */
export async function fetchWebhookPublicKeys(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(WEBHOOK_KEYS_URL);
  if (!res.ok) throw new Error(`rtk webhook keys: ${res.status}`);
  const json = (await res.json()) as { data?: { publicKey?: string; publicKeys?: string[] } };
  const keys: string[] = [];
  if (json.data?.publicKey) keys.push(json.data.publicKey);
  if (Array.isArray(json.data?.publicKeys)) keys.push(...json.data.publicKeys.filter((k) => typeof k === "string"));
  if (keys.length === 0) throw new Error("rtk webhook keys: none published");
  return keys;
}

/**
 * Verify a Base64 RSA-SHA256 (RSASSA-PKCS1-v1_5) signature over the RAW body against any of the SPKI PEMs.
 * Fail-CLOSED: a malformed signature, an unimportable key, or a verify error all yield false (never throws).
 * Tries each PEM so a rotation window with two live keys still verifies.
 */
export async function verifyRtkSignature(
  rawBody: BufferSource,
  signatureB64: string,
  pems: string[],
  subtle: SubtleCrypto = crypto.subtle,
): Promise<boolean> {
  if (!signatureB64) return false;
  let sig: Uint8Array;
  try {
    sig = b64ToBytes(signatureB64);
  } catch {
    return false;
  }
  if (sig.length === 0) return false;
  for (const pem of pems) {
    try {
      const key = await subtle.importKey(
        "spki",
        pemToDer(pem),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (await subtle.verify("RSASSA-PKCS1-v1_5", key, sig, rawBody)) return true;
    } catch {
      // try the next key
    }
  }
  return false;
}

/** Parse a `recording.statusUpdate` body. Tolerant of `event`/`type` and `recording`/`data` envelopes. */
export function parseRtkEvent(rawText: string): RtkWebhookEvent | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = String(j.event ?? j.type ?? "");
  const r = (j.recording ?? j.data ?? null) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const id = String(r.id ?? "");
  if (!id) return null;
  return {
    event,
    recording: {
      id,
      status: String(r.status ?? ""),
      downloadUrl: typeof r.downloadUrl === "string" ? r.downloadUrl : undefined,
      outputFileName: typeof r.outputFileName === "string" ? r.outputFileName : undefined,
      fileSize: typeof r.fileSize === "number" ? r.fileSize : undefined,
      meetingId: typeof r.meetingId === "string" ? r.meetingId : undefined,
      recordingDuration: typeof r.recordingDuration === "number" ? r.recordingDuration : undefined,
    },
  };
}

/** Injectable deps so the handler unit-tests with no network/crypto host (a fake `keys()` + `subtle`). */
export interface WebhookDeps {
  /** Provide the verification PEMs (live: fetch+cache CF's well-known doc). */
  keys(): Promise<string[]>;
  subtle?: SubtleCrypto;
  /** Structured observability sink (live: console.log JSON). No secrets, no body — ids + sizes only. */
  log?(msg: string, fields: Record<string, unknown>): void;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Handle one `recording.statusUpdate` POST. Verify the signature over the RAW body FIRST, then parse, then
 * observe. Always acks 2xx on a validly-signed event (so RTK stops retrying); 401 on a bad/absent signature.
 */
export async function handleRecordingWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const sig = request.headers.get("rtk-signature") ?? "";
  const uuid = request.headers.get("rtk-uuid") ?? "";
  const raw = await request.arrayBuffer();

  if (!sig) return jsonResponse({ error: "UNSIGNED" }, 401);

  let pems: string[];
  try {
    pems = await deps.keys();
  } catch {
    // Can't fetch the verification key → we cannot trust the caller. Fail closed; RTK will retry.
    return jsonResponse({ error: "KEYS_UNAVAILABLE" }, 503);
  }
  if (!(await verifyRtkSignature(raw, sig, pems, deps.subtle))) {
    return jsonResponse({ error: "BAD_SIGNATURE" }, 401);
  }

  const evt = parseRtkEvent(new TextDecoder().decode(raw));
  if (!evt) return jsonResponse({ error: "BAD_PAYLOAD" }, 400);

  const r = evt.recording;
  const base = { id: r.id, meetingId: r.meetingId, uuid, event: evt.event };
  if (r.status === "UPLOADED") {
    deps.log?.("rt-recording-uploaded", { ...base, fileSize: r.fileSize, outputFileName: r.outputFileName, durationS: r.recordingDuration });
  } else if (r.status === "ERRORED") {
    deps.log?.("rt-recording-errored", base);
  } else {
    deps.log?.("rt-recording-status", { ...base, status: r.status });
  }
  return jsonResponse({ ok: true, status: r.status }, 200);
}

/**
 * Live deps: fetch+cache CF's published PEM(s) for the isolate's lifetime (keys rotate rarely; a fetch per
 * webhook would be wasteful and add a failure mode). A fetch failure does not poison the cache.
 */
export function liveWebhookDeps(fetchImpl: typeof fetch = fetch): WebhookDeps {
  let cached: string[] | null = null;
  return {
    async keys() {
      if (cached) return cached;
      cached = await fetchWebhookPublicKeys(fetchImpl);
      return cached;
    },
    log(msg, fields) {
      console.log(JSON.stringify({ msg, ...fields }));
    },
  };
}
