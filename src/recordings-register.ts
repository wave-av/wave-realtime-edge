/// <reference types="@cloudflare/workers-types" />
/**
 * E3.P2/P4 (#127) — register() client for the realtime/SFU recorder's DATA-RESIDENCY path.
 *
 * After a residency recording finalizes (bytes already safe in the jurisdiction R2 bucket), the recorder
 * POSTs the object to the LIVE gateway residency-enforcement endpoint
 *   POST ${WAVE_GATEWAY_ORIGIN}/v1/internal/recordings/register
 *   Authorization: Bearer ${WAVE_SERVICE_TOKEN}
 * so the object is registered in iso_recordings (resolve/clips/VOD can find it) AND the gateway enforces
 * residency (zone↔bucket). The contract (the gateway's recordings.ts handleRecordingsRegister):
 *   • principal.org — MUST be a UUID (the org the row is written under).
 *   • r2Key         — MUST start with `${org}/` (storage-side tenant boundary).
 *   • bucket        — where the bytes live; MUST be gateway-allow-listed (REGISTRY_BUCKETS / RESIDENCY_BUCKETS).
 *   • zone          — a valid WaveZone; with RESIDENCY_BUCKETS set, `bucket` MUST be the residency-correct
 *                     bucket for that zone's jurisdiction, else 403 residency_bucket_mismatch.
 *   • kind          — "recording".
 *   • sourceProtocol- optional; "whip" for the SFU path (in the gateway's allowed set).
 * We build the payload from the SAME residency resolver the bytes were written with, so the (zone, bucket,
 * org-prefixed key) triple is consistent by construction → a correct call never 403s.
 *
 * FAIL-LOUD, NEVER-CRASH: the bytes are already durable; register is METADATA. A network error, a non-2xx,
 * or missing config is LOGGED (loud) and returns a non-throwing failure result — it must NOT crash the
 * recording finalize. (A persistent failure is a follow-up for a durable register-retry queue; out of scope
 * for this INERT PR — see the PR body.)
 *
 * INERT BY DEFAULT: nothing here runs unless the residency wire point invokes it, which is itself gated by
 * RT_RESIDENCY. With RT_RESIDENCY off, register() is never called (no gateway POST, byte-identical to today).
 */

/** RFC-4122 UUID — principal.org MUST be a UUID (the gateway rejects a non-UUID org with 400). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inputs to build a register() request body. The recorder supplies these from the residency placement. */
export interface RegisterRecordingInput {
  /** Owning org — MUST be a UUID (gateway writes the row under it). */
  org: string;
  /** The R2 key the bytes landed at — MUST start with `${org}/`. */
  r2Key: string;
  /** The bucket the bytes live in — the residency-correct bucket for `zone`. */
  bucket: string;
  /** The WaveZone the session recorded in (e.g. "us-east","eu-west"); the gateway folds it → jurisdiction → bucket. */
  zone: string;
  /** Optional ingest protocol; defaults to "whip" for the SFU path (in the gateway's allowed set). */
  sourceProtocol?: string;
}

/** The exact JSON body POSTed to /v1/internal/recordings/register (matches the gateway's parsed fields). */
export interface RegisterRecordingBody {
  principal: { org: string };
  r2Key: string;
  bucket: string;
  zone: string;
  kind: "recording";
  sourceProtocol: string;
}

/** Result of a register attempt. Never throws out of the client — `ok:false` carries a stable reason. */
export type RegisterResult =
  | { ok: true; recordingId: string; deduped: boolean }
  | { ok: false; reason: string; status?: number };

/**
 * Build the register() request body from the residency placement. PURE + validated: returns null when the
 * input would produce a request the gateway is guaranteed to reject (non-UUID org, key not org-prefixed,
 * empty bucket/zone) — so a malformed call is caught BEFORE the network, never sent to 403/400. This is the
 * single place that guarantees org-prefix + zone consistency, so a built body always passes the gateway.
 */
export function buildRegisterBody(input: RegisterRecordingInput): RegisterRecordingBody | null {
  const { org, r2Key, bucket, zone } = input;
  if (!org || !UUID_RE.test(org)) return null;
  if (!r2Key || !r2Key.startsWith(org + "/")) return null;
  if (!bucket) return null;
  if (!zone) return null;
  return {
    principal: { org },
    r2Key,
    bucket,
    zone,
    kind: "recording",
    sourceProtocol: input.sourceProtocol ?? "whip",
  };
}

/** Config the register POST needs (read from the worker/DO env on the residency path). */
export interface RegisterConfig {
  /** Gateway origin, e.g. https://api.wave.online. Unset → register is skipped (logged). */
  gatewayOrigin?: string;
  /** Service bearer (same secret room.ts presents to the gateway metering tap). Unset → skipped (logged). */
  serviceToken?: string;
}

/**
 * POST the register() call. Fail-loud + never-throws: on missing config / network error / non-2xx, LOG via
 * `log` and return `{ ok:false, reason }`. The recorder ignores the result for correctness (bytes are safe),
 * but returns it so a future durable-retry layer (out of scope here) and the tests can observe the outcome.
 * `fetchImpl` is injected so this unit-tests with no live network.
 */
export async function registerRecording(
  input: RegisterRecordingInput,
  cfg: RegisterConfig,
  log?: (msg: string, fields: Record<string, unknown>) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisterResult> {
  if (!cfg.gatewayOrigin || !cfg.serviceToken) {
    log?.("rt-register-skip-unconfigured", { hasOrigin: Boolean(cfg.gatewayOrigin), hasToken: Boolean(cfg.serviceToken) });
    return { ok: false, reason: "register_unconfigured" };
  }
  const body = buildRegisterBody(input);
  if (!body) {
    // A built body is consistency-guaranteed; a null here is a real bug in the caller's placement → loud.
    log?.("rt-register-skip-invalid", { org: input.org, r2Key: input.r2Key, bucket: input.bucket, zone: input.zone });
    return { ok: false, reason: "register_invalid_input" };
  }
  const url = `${cfg.gatewayOrigin.replace(/\/+$/, "")}/v1/internal/recordings/register`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log?.("rt-register-failed", { zone: body.zone, bucket: body.bucket, error: String(err) });
    return { ok: false, reason: "register_network_error" };
  }
  if (!res.ok) {
    // 403 residency_bucket_mismatch / 400 etc. — loud, but NOT fatal to the finalize (bytes already safe).
    let reason = `register_http_${res.status}`;
    try {
      const j = (await res.json()) as { reason?: string };
      if (j && typeof j.reason === "string") reason = j.reason;
    } catch {
      /* body not JSON — keep the http_<status> reason */
    }
    log?.("rt-register-rejected", { zone: body.zone, bucket: body.bucket, status: res.status, reason });
    return { ok: false, reason, status: res.status };
  }
  let j: { recordingId?: string; deduped?: boolean };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    log?.("rt-register-bad-response", { zone: body.zone, bucket: body.bucket });
    return { ok: false, reason: "register_bad_response" };
  }
  log?.("rt-register-ok", { zone: body.zone, bucket: body.bucket, recordingId: j.recordingId, deduped: Boolean(j.deduped) });
  return { ok: true, recordingId: j.recordingId ?? "", deduped: Boolean(j.deduped) };
}
