/// <reference types="@cloudflare/workers-types" />
/**
 * E3n (wre#290) — Axis B1: pull a finished CF Stream Live recording's BYTES into our R2, mirroring the
 * proven `rtk-webhook.ts` UPLOADED-pull pattern (CF-side storage → OUR R2, org-prefixed key, register() is
 * metadata-only and never fetches bytes itself).
 *
 * CF Stream flow for a recorded live input (grounded against the CF Stream REST API):
 *   1. `GET  /accounts/{acct}/stream?liveInput={uid}` — lists the VIDEO objects CF minted for that input;
 *      a completed one has `readyToStream:true` and `status.state:"ready"`.
 *   2. `POST /accounts/{acct}/stream/{videoUid}/downloads` — (idempotent; CF returns the existing job if one
 *      is already in flight) provisions an MP4 download and returns `{default:{status,percentComplete,url}}`.
 *      `status !== "ready"` means CF is still muxing — the caller must retry a LATER tick, never invent bytes.
 *   3. Once ready, `url` is a direct HTTPS GET that streams the MP4.
 *
 * FAIL-SAFE (load-bearing): any failure here (list/download-provision/fetch/R2-put) returns null/false — the
 * caller (`e3n-recording-sweep.ts`) treats null as "not yet" and retries the NEXT sweep tick. It never marks
 * a recording registered on a partial pull, so a failure cannot wedge the cron or double-bill (no register
 * call happens without a successful pull first).
 */
import { isSafePublicHttpsUrl } from "./rtk-webhook.js";

/**
 * CF Stream MP4 download URLs are documented to be served from these CF-owned hosts. Cheap hardening on top
 * of the shared `isSafePublicHttpsUrl` guard (which is TRUSTED-SOURCE-ONLY — literal-IP/localhost checks, no
 * DNS resolution, so it is not a general attacker-input-safe SSRF guard; see its own doc comment in
 * `rtk-webhook.ts`): even though this URL is CF-API-returned rather than attacker-controlled, assert its
 * origin really is a CF Stream host before fetching, rather than trusting any https URL CF happened to return.
 */
function isCfStreamDownloadHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "videodelivery.net" ||
    h.endsWith(".videodelivery.net") ||
    h === "cloudflarestream.com" ||
    h.endsWith(".cloudflarestream.com")
  );
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
/** Explicit timeout on every CF Stream API call — an unbounded hang would stall the whole sweep tick. */
const CF_CALL_TIMEOUT_MS = 8_000;

/** One CF Stream video object, narrowed to the fields the sweep/pull need. */
export interface CfVideoSummary {
  uid: string;
  liveInput: string | null;
  readyToStream: boolean;
  /** `status.state`: "ready" | "inprogress" | "error" | "downloading" | … | null when unreadable. */
  state: string | null;
  duration: number | null;
  created: string | null;
}

/** A completed recording is ready-to-stream AND its status has settled to "ready" — anything else (still
 *  muxing, errored, mid-upload) is not yet a VOD candidate. */
export function isCompletedRecording(v: CfVideoSummary): boolean {
  return v.readyToStream === true && v.state === "ready";
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = CF_CALL_TIMEOUT_MS,
): Promise<Response | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ac.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List the CF Stream videos CF has minted for one live input. Returns null on ANY failure (unreachable,
 * non-2xx, unparseable) — the caller skips this input for the tick rather than guessing an empty list (an
 * empty list would be indistinguishable from "genuinely no recordings yet").
 */
export async function listCfVideosForLiveInput(
  fetchFn: typeof fetch,
  accountId: string,
  apiToken: string,
  liveInputUid: string,
): Promise<CfVideoSummary[] | null> {
  const res = await fetchWithTimeout(
    fetchFn,
    // `live_input_id` is CF's documented QUERY-PARAM filter name for this list endpoint — distinct from
    // `liveInput`, which is the RESPONSE-BODY field name on each returned video object (parsed below into
    // `CfVideoSummary.liveInput`). Using the body-field name as the query param is silently ignored by CF
    // (unknown params are dropped, not rejected) and returns the ENTIRE account's unfiltered video list —
    // a cross-tenant data leak once any consumer trusts this list as pre-filtered. The sweep additionally
    // re-checks `video.liveInput === uid` per-video (defense-in-depth; see `e3n-recording-sweep.ts`) so a
    // regression here is caught even if this comment rots.
    `${CF_API_BASE}/accounts/${accountId}/stream?live_input_id=${encodeURIComponent(liveInputUid)}`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  if (!res || !res.ok) return null;
  let body: { success?: boolean; result?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  if (body.success !== true || !Array.isArray(body.result)) return null;
  const out: CfVideoSummary[] = [];
  for (const raw of body.result as Record<string, unknown>[]) {
    const uid = typeof raw.uid === "string" ? raw.uid : "";
    if (!uid) continue;
    const status = raw.status as { state?: unknown } | undefined;
    out.push({
      uid,
      liveInput: typeof raw.liveInput === "string" ? raw.liveInput : null,
      readyToStream: raw.readyToStream === true,
      state: typeof status?.state === "string" ? status.state : null,
      duration: typeof raw.duration === "number" ? raw.duration : null,
      created: typeof raw.created === "string" ? raw.created : null,
    });
  }
  return out;
}

/** Result of provisioning/checking an MP4 download job. `ready:false` (url null or not) means "try again
 *  later" — CF is still muxing the download; the sweep must never invent a partial fetch. */
export interface CfDownloadState {
  ready: boolean;
  url: string | null;
}

/**
 * Idempotently provision (or read the existing) MP4 download job for a video. CF returns the SAME job on a
 * repeat call, so re-sweeping a not-yet-ready video is safe and cheap. Returns null on a hard failure
 * (unreachable / non-2xx / unparseable) — distinct from `{ready:false}` (a real, still-muxing job).
 */
export async function requestCfDownloadUrl(
  fetchFn: typeof fetch,
  accountId: string,
  apiToken: string,
  videoUid: string,
): Promise<CfDownloadState | null> {
  const res = await fetchWithTimeout(
    fetchFn,
    `${CF_API_BASE}/accounts/${accountId}/stream/${encodeURIComponent(videoUid)}/downloads`,
    { method: "POST", headers: { authorization: `Bearer ${apiToken}` } },
  );
  if (!res || !res.ok) return null;
  let body: { success?: boolean; result?: { default?: { status?: unknown; url?: unknown } } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return null;
  }
  if (body.success !== true) return null;
  const d = body.result?.default;
  const status = typeof d?.status === "string" ? d.status : null;
  const url = typeof d?.url === "string" ? d.url : null;
  return { ready: status === "ready" && Boolean(url), url };
}

/**
 * Stream a ready download URL's bytes straight into R2 at `key` (constant memory — no buffering; the R2
 * `put` consumes the response body stream directly, mirroring the Workers-native streaming upload pattern).
 * Returns the byte count on success, null on any failure (unsafe URL, fetch error, empty body, R2 put error)
 * — the caller must NOT register on a null (fail-safe: no orphaned/partial object gets registered).
 */
export async function pullCfRecordingBytes(
  fetchFn: typeof fetch,
  url: string,
  bucket: R2Bucket,
  key: string,
): Promise<{ bytes: number } | null> {
  if (!isSafePublicHttpsUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isCfStreamDownloadHost(parsed.hostname)) return null;
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  try {
    await bucket.put(key, res.body, { httpMetadata: { contentType: "video/mp4" } });
  } catch {
    return null;
  }
  // R2 `put` on a stream doesn't hand back a byte count; content-length (when CF sent one) is the best
  // available observability signal. 0 is a valid "unknown" — never treated as a failure signal by callers.
  return { bytes: Number.isFinite(contentLength) ? contentLength : 0 };
}

/** The deterministic, org-prefixed R2 key a pulled recording lands at. MUST start `${org}/` (the register()
 *  contract's storage-side tenant boundary) and is stable across re-sweeps (idempotent overwrite). */
export function e3nRecordingKey(org: string, videoUid: string): string {
  return `${org}/e3n-recordings/${videoUid}/recording.mp4`;
}
