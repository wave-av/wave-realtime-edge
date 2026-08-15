/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R-WH — the RealtimeKit `recording.statusUpdate` webhook (design §2, completion signal).
 *
 * In the SHIPPED managed-recording path (adapter C, PULL mode) RealtimeKit records the meeting to ITS OWN
 * storage (its `storage_config` enum has no R2 option), so on UPLOADED this webhook is the LOAD-BEARING path
 * that pulls the finished file into our R2 bucket at an org-rooted key (`${org}/realtime-recordings/${meetingId}/…`),
 * where the daily storage sweep bills it by org-prefix. The event types:
 *   • UPLOADED → the recording is ready (id, meetingId, fileSize, outputFileName) — pulled into our R2, then logged.
 *   • ERRORED  → a recording failed on CF's side — must be VISIBLE, never swallowed.
 * The pull writes a DETERMINISTIC key (idempotent: same key, last-writer-wins), and a signature/parse failure
 * is safely re-deliverable (RTK retries a non-2xx). A failure of the POST-ack pull is recovered by the
 * scheduled() cron reconcile (reconcilePending) — RTK fires UPLOADED once + gets a 200, so it won't re-deliver.
 *
 * SECURITY (load-bearing): this is the ONE realtime-edge route that is intentionally NOT behind the gateway
 * (`x-wave-internal`) — RTK calls it directly from the public internet. It therefore authenticates itself:
 * the `rtk-signature` header is a Base64 RSA-SHA256 signature over the RAW request body, verified against
 * CF's published public key BEFORE the body is parsed. A missing/invalid signature → 401, nothing acted on.
 * The key host and the CF REST host are fixed literals (no request-derived URLs → SSRF-safe).
 *
 * PULL mode (RT-P2.5, design §2 corrected): RealtimeKit cannot upload into R2 (its storage_config enum has no
 * R2 option), so on UPLOADED this handler PULLS the finished recording into OUR R2 — it looks up the org by
 * meetingId (the map the /rtk/join path persisted), resolves the download URL, fetches it, and streams it
 * into the SKIP-tier `RealtimeRecorder` as the ONE canonical org-rooted object the daily sweep meters. The
 * pull is best-effort + fail-open (a pull failure NEVER fails the signed ack) and runs in `ctx.waitUntil` so a
 * large transfer can't hold the webhook request open past RTK's timeout. The fetch target is host-guarded
 * (https + non-private host) as defense-in-depth even though the event is already signature-verified.
 *
 * tier=SKIP-clean: this module imports NO `@wave-av/content-hash` and touches NO dedup index. (It DOES import
 * the SKIP-tier RealtimeRecorder, which is itself content-hash-free — asserted by the bundle-guard.)
 */
import { RealtimeRecorder, type RecordingResult } from "./recording-writer.js";
import {
  bucketForBinding,
  type RtResidencyBinding,
  type RtResidencyZone,
} from "./residency-rt.js";
import { registerRecording, type RegisterConfig } from "./recordings-register.js";

/** CF's published RTK webhook public key — `{ success, data: { publicKey: "-----BEGIN PUBLIC KEY-----…" } }`. */
const WEBHOOK_KEYS_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json"; // fixed host (SSRF-safe)

/** Org-prefix used when a recording cannot be attributed (meetingId→org map miss). Bytes are PRESERVED under
 * this clearly-flagged prefix (never dropped) + a loud alarm is logged — the sweep will surface it as
 * unattributed rather than silently losing a customer recording. */
export const UNATTRIBUTED_ORG = "__unattributed__";

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

/** LK-rip #77 — payload emitted once after a recording pull lands byte-exact (egress lifecycle + meter). */
export interface EgressCompletedEvent {
  egressId: string; // == the RTK meetingId == the recording sessionId
  meetingId: string;
  org: string;
  key: string; // the canonical R2 object the pull wrote
  bytes: number;
  durationS?: number;
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
  // RTK is inconsistent between camelCase (`downloadUrl`) and snake_case (`download_url`) across surfaces —
  // accept either so the pull works whichever the live webhook emits.
  const downloadUrl =
    typeof r.downloadUrl === "string" ? r.downloadUrl : typeof r.download_url === "string" ? r.download_url : undefined;
  return {
    event,
    recording: {
      id,
      status: String(r.status ?? ""),
      downloadUrl,
      outputFileName: typeof r.outputFileName === "string" ? r.outputFileName : undefined,
      fileSize: typeof r.fileSize === "number" ? r.fileSize : undefined,
      meetingId: typeof r.meetingId === "string" ? r.meetingId : undefined,
      recordingDuration: typeof r.recordingDuration === "number" ? r.recordingDuration : undefined,
    },
  };
}

/**
 * Defense-in-depth SSRF guard for the recording download URL. The URL provenance is already trusted (it comes
 * from a signature-verified webhook body, or from our own GET to the fixed CF host), but we still refuse to
 * fetch anything that isn't `https:` to a public host — blocking localhost, link-local (incl. the cloud
 * metadata 169.254.169.254), and RFC-1918 private literals. Hostnames that aren't IP literals are allowed
 * (RTK's storage CDN host isn't a fixed literal we can allowlist without brittleness).
 *
 * TRUSTED-SOURCE-ONLY, NOT ATTACKER-INPUT-SAFE: this checks literal IPs/hostnames only and never resolves
 * DNS (the Workers runtime has no synchronous DNS API), so it does not defend a DNS-rebinding attack where a
 * hostname resolves to a private/metadata IP only at fetch time. Every current caller passes a URL from a
 * provenance-verified source (a signature-verified webhook body, or CF's own Stream API), never raw
 * end-user input — callers reusing this guard for a NEW, less-trusted URL source must add their own
 * origin/host allowlist on top (see `e3n-recording-pull.ts`'s `isCfStreamDownloadHost` for an example).
 */
export function isSafePublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  // IPv4 literal → reject private/reserved ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8).
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  // Reject ALL bracketed IPv6 literals: RTK serves recordings by hostname, never from a v6 literal, so a v6
  // literal is either a mistake or an SSRF attempt — loopback [::1], link-local [fe80::], ULA [fc/fd], and
  // IPv4-mapped/NAT64 forms like [::ffff:169.254.169.254] / [64:ff9b::a9fe:a9fe] that would otherwise smuggle
  // a private v4 target (cloud metadata, RFC-1918) past the v4 checks above.
  if (h.startsWith("[")) return false;
  return true;
}

/**
 * The capabilities the UPLOADED pull needs, injected so it unit-tests with no live network/R2. `lookupOrg`
 * resolves meetingId→org (live: KV get); `resolveDownloadUrl` fetches a fresh URL when the event omitted one
 * (live: RTK GET); `fetchRecording` streams the bytes (live: fetch); `bucket` is the SKIP sink R2.
 */
export interface RecordingPullSink {
  lookupOrg(meetingId: string): Promise<string | null>;
  resolveDownloadUrl(recordingId: string): Promise<string | null>;
  fetchRecording(url: string): Promise<ReadableStream<Uint8Array> | null>;
  bucket: R2Bucket;
  /** Durable retry: persist a pending-pull record (recordingId→meetingId) the cron reconcile re-pulls. Optional
   * (absent in observe-only/test deps) — when absent, a POST-ack pull failure is logged but not auto-recovered. */
  markPending?(recordingId: string, meetingId: string): Promise<void>;
  /**
   * E3.P2/P4 (#127) DATA-RESIDENCY (present ONLY when RT_RESIDENCY is on). When set, this turns the pull into
   * the residency-aware path:
   *   • residency.lookupZone(meetingId) → the WaveZone captured at join (null → fall back to the default path).
   *   • residency.bucketFor(zone)       → the jurisdiction R2 bucket the bytes must land in (null → default path).
   *   • residency.register(...)         → POST the finalized object to the gateway register endpoint.
   * ABSENT (the default, RT_RESIDENCY off) → the pull is byte-identical to today: default bucket, no region
   * segment, no register() call. The presence of this field is the ONLY thing that changes behavior.
   */
  residency?: ResidencyPullDeps;
}

/** The residency capabilities the pull uses when RT_RESIDENCY is on (injected → unit-testable, no live net/R2). */
export interface ResidencyPullDeps {
  /** The WaveZone the session recorded in (captured at join). Null → no residency placement → default path. */
  lookupZone(meetingId: string): Promise<RtResidencyZone | null>;
  /** The jurisdiction bucket for a zone, and its wrangler binding name (for the register bucket field). */
  bucketFor(zone: RtResidencyZone): { bucket: R2Bucket; bucketName: string; binding: RtResidencyBinding } | null;
  /** POST the finalized object to the gateway register endpoint (fail-loud, never throws — bytes already safe). */
  register(input: { org: string; r2Key: string; bucketName: string; zone: RtResidencyZone }): Promise<void>;
}

/** KV key prefix + bound for the durable pending-pull retry set (read by reconcilePending). */
export const PENDING_PREFIX = "pull-pending:";
export const MAX_PULL_ATTEMPTS = 5;
/** Bounded recovery window for a pending pull (KV TTL). RTK retains the recording; if we can't pull it within
 * this window across cron ticks, we give up loudly rather than retry forever. */
export const PENDING_TTL_SECONDS = 60 * 60 * 24 * 2;

/** A durable pending-pull record (JSON value at `${PENDING_PREFIX}${recordingId}`). */
interface PendingPull {
  meetingId: string;
  attempts: number;
}

/**
 * Pull a finished (UPLOADED) recording into OUR R2. Looks up the org by meetingId (miss → preserve under
 * `__unattributed__/` + alarm, never drop bytes), resolves a download URL (from the event or a fresh GET),
 * host-guards it, fetches it, and streams it into the SKIP-tier RealtimeRecorder as ONE canonical object at
 * `${org}/realtime-recordings/${meetingId}/recording.<ext>`. The key is deterministic, so a retried webhook
 * overwrites the same object (idempotent). Returns the result, or null when there was nothing to write.
 * tier=SKIP throughout: RealtimeRecorder never hashes/claims; this never imports content-hash.
 *
 * THROWS only on a transient fetch/R2 error — the webhook handler CATCHES the throw, logs an alarm, and
 * enqueues a durable pending-pull record (recordingId→meetingId) that the scheduled() cron `reconcilePending`
 * retries later with a freshly-resolved download URL (idempotent: same key). A "nothing to do" outcome (no
 * URL, empty body) returns null — the reconcile retries those a bounded number of times too, then gives up.
 */
export async function pullUploadedRecording(
  recording: RtkRecording,
  sink: RecordingPullSink,
  log?: (msg: string, fields: Record<string, unknown>) => void,
): Promise<RecordingResult | null> {
  const meetingId = recording.meetingId ?? "";
  if (!meetingId) {
    log?.("rt-pull-skip-no-meeting", { id: recording.id });
    return null;
  }
  let org = await sink.lookupOrg(meetingId);
  if (!org) {
    org = UNATTRIBUTED_ORG;
    log?.("rt-pull-unattributed", { id: recording.id, meetingId }); // alarm: bytes preserved but not org-attributed
  }

  // E3.P2/P4 (#127) DATA-RESIDENCY placement (RT_RESIDENCY ON ⇒ sink.residency present). Resolve the
  // session's zone (captured at join) and its jurisdiction bucket. A residency placement holds ONLY when
  // ALL THREE are true: residency deps present, a zone was captured, AND a bucket is bound for that zone.
  // Any miss → `placement` stays null → the pull uses the DEFAULT bucket + non-region key + NO register
  // (byte-identical to today). We NEVER mix: residency bytes never land in the default bucket and a default
  // recording never gets a region segment or a register() call. Unattributed (no org) is also kept on the
  // default path — a register requires a real (UUID) org, and bytes are still preserved under __unattributed__/.
  let placement: { bucket: R2Bucket; bucketName: string; binding: RtResidencyBinding; zone: RtResidencyZone } | null = null;
  if (sink.residency && org !== UNATTRIBUTED_ORG) {
    const zone = await sink.residency.lookupZone(meetingId);
    if (zone) {
      const b = sink.residency.bucketFor(zone);
      if (b) placement = { ...b, zone };
      else log?.("rt-pull-residency-no-bucket", { id: recording.id, meetingId, zone }); // bound? loud, fall to default
    }
  }
  const targetBucket = placement ? placement.bucket : sink.bucket;
  const region = placement ? placement.zone : undefined;
  let url = recording.downloadUrl ?? null;
  if (!url) url = await sink.resolveDownloadUrl(recording.id);
  if (!url) {
    log?.("rt-pull-skip-no-url", { id: recording.id, meetingId });
    return null;
  }
  if (!isSafePublicHttpsUrl(url)) {
    log?.("rt-pull-skip-unsafe-url", { id: recording.id, meetingId });
    return null;
  }
  const stream = await sink.fetchRecording(url); // may throw (transient) → handler enqueues a pending retry
  if (!stream) {
    log?.("rt-pull-skip-empty", { id: recording.id, meetingId, fileSize: recording.fileSize });
    return null;
  }

  // Stream the finished file into the SKIP sink. begin() sniffs the container from the FIRST NON-EMPTY chunk
  // for the file extension; the bytes are saved verbatim. Constant memory (5 MiB multipart parts).
  const reader = stream.getReader();
  let recorder: RealtimeRecorder | null = null;
  try {
    // Skip any leading zero-length chunks so a stream that emits an empty frame before real data is not
    // misread as "nothing recorded" (RTK said UPLOADED → an empty body is more likely truncation than empty).
    let first: Uint8Array | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        first = value;
        break;
      }
    }
    if (!first) {
      log?.("rt-pull-skip-empty", { id: recording.id, meetingId, fileSize: recording.fileSize });
      return null; // nothing recorded → never a 0-byte object
    }
    recorder = await RealtimeRecorder.begin(targetBucket, org, meetingId, first, region);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) await recorder.append(value);
    }
  } catch (err) {
    await recorder?.safeAbort().catch(() => {});
    throw err; // transient fetch/R2 error → surface so the handler enqueues a pending retry (cron reconcile)
  } finally {
    reader.releaseLock();
  }
  const result = await recorder.finalize();
  if (result) {
    log?.("rt-pull-stored", { id: recording.id, meetingId, key: result.key, bytes: result.bytes });
    // E3.P2/P4 (#127): on the residency path ONLY, register the finalized object with the gateway (residency
    // enforcement + iso_recordings membership). The bytes are ALREADY durable — register is metadata, so it is
    // fail-loud-but-never-fatal (registerRecording itself never throws). The (org, region-key, bucket, zone)
    // are consistent by construction (same resolver wrote the bytes), so a correct call never 403s.
    if (placement) {
      await sink.residency!.register({ org, r2Key: result.key, bucketName: placement.bucketName, zone: placement.zone });
    }
  }
  return result;
}

/** Injectable deps so the handler unit-tests with no network/crypto host (a fake `keys()` + `subtle`). */
export interface WebhookDeps {
  /** Provide the verification PEMs (live: fetch+cache CF's well-known doc). */
  keys(): Promise<string[]>;
  subtle?: SubtleCrypto;
  /** Structured observability sink (live: console.log JSON). No secrets, no body — ids + sizes only. */
  log?(msg: string, fields: Record<string, unknown>): void;
  /** PULL mode: when present, an UPLOADED event pulls the finished recording into our R2 (absent → observe-only). */
  sink?: RecordingPullSink;
  /** LK-rip #77 egress lifecycle: when present, fire EXACTLY ONCE after the pull lands byte-exact on UPLOADED —
   * emits `egress.completed` + meters `wave_sfu_egress_gb` (overage-only, see metering.ts). Injected so it is
   * unit-fakeable; absent → no emit (observe-only). Idempotent: only fires on a non-null pull RESULT (a
   * deterministic key means an Inngest/webhook retry that re-pulls the SAME object still emits once per landed
   * recording, and the gateway de-dupes the meter by the stable event_id below). */
  emitEgressCompleted?(ev: EgressCompletedEvent): Promise<void>;
  /** Background a long pull off the request (live: ctx.waitUntil). Absent → the pull is awaited (tests assert it). */
  waitUntil?(p: Promise<unknown>): void;
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
    // PULL the finished recording into OUR R2 (org-rooted SKIP object the sweep meters). Best-effort + fail-open:
    // a pull error is logged as an alarm but NEVER fails the signed ack. Backgrounded via waitUntil in prod so a
    // large transfer can't hold the request past RTK's webhook timeout; awaited when no scheduler (tests/local).
    // On a transient throw the recording would otherwise be lost (RTK fired UPLOADED once + got our 200, so it
    // won't re-deliver) — so we durably enqueue a pending-pull record the scheduled() cron reconcile re-pulls.
    const sink = deps.sink;
    if (sink) {
      const pull = pullUploadedRecording(r, sink, deps.log)
        .then(async (result) => {
          // LK-rip #77: fire the egress lifecycle event + meter EXACTLY ONCE, only after the pull landed a real
          // object (non-null result). A retried webhook re-pulls the SAME deterministic key and re-emits, but the
          // gateway de-dupes the meter on the stable event_id (egressId:wave_sfu_egress_gb), so billing is once.
          if (result && deps.emitEgressCompleted && r.meetingId) {
            const org = (await sink.lookupOrg(r.meetingId).catch(() => null)) ?? UNATTRIBUTED_ORG;
            await deps
              .emitEgressCompleted({
                egressId: r.meetingId,
                meetingId: r.meetingId,
                org,
                key: result.key,
                bytes: result.bytes,
                durationS: r.recordingDuration,
              })
              .catch((err) => deps.log?.("rt-egress-emit-failed", { ...base, error: String(err) }));
          }
          return result;
        })
        .catch(async (err) => {
          deps.log?.("rt-pull-failed", { ...base, error: String(err) });
          if (r.meetingId && sink.markPending) {
            await sink.markPending(r.id, r.meetingId).catch(() => {}); // durable retry; itself best-effort
          }
          return null;
        });
      if (deps.waitUntil) deps.waitUntil(pull);
      else await pull;
    }
  } else if (r.status === "ERRORED") {
    deps.log?.("rt-recording-errored", base);
  } else {
    deps.log?.("rt-recording-status", { ...base, status: r.status });
  }
  return jsonResponse({ ok: true, status: r.status }, 200);
}

/**
 * Cron reconcile (scheduled()): retry every pending-pull record that a POST-ack webhook pull failed on. RTK
 * fires UPLOADED once and, on our 200, never re-delivers — so without this a transient fetch/R2 failure would
 * silently lose the recording. For each pending record we re-pull with a FRESHLY resolved download URL (the
 * URL in the original event is perishable, which is why the pending record stores only recordingId+meetingId).
 * The pull key is deterministic → a retry is idempotent (last-writer-wins). On success we clear the record; on
 * a still-failing/empty pull we bump attempts (give up loudly after MAX_PULL_ATTEMPTS so it can't retry forever).
 * The whole thing is best-effort and never throws out of scheduled().
 */
export async function reconcilePending(
  kv: KVNamespace,
  sink: RecordingPullSink,
  log?: (msg: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: PENDING_PREFIX, cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const recordingId = k.name.slice(PENDING_PREFIX.length);
      const raw = await kv.get(k.name);
      if (!raw) continue; // expired between list and get
      let rec: PendingPull;
      try {
        rec = JSON.parse(raw) as PendingPull;
      } catch {
        await kv.delete(k.name); // corrupt record → drop
        continue;
      }
      if (!rec?.meetingId) {
        await kv.delete(k.name);
        continue;
      }
      let result: RecordingResult | null = null;
      try {
        result = await pullUploadedRecording({ id: recordingId, status: "UPLOADED", meetingId: rec.meetingId }, sink, log);
      } catch (err) {
        log?.("rt-pull-reconcile-error", { recordingId, meetingId: rec.meetingId, error: String(err) });
      }
      if (result) {
        await kv.delete(k.name);
        log?.("rt-pull-reconciled", { recordingId, meetingId: rec.meetingId, key: result.key, bytes: result.bytes });
      } else {
        const attempts = (Number(rec.attempts) || 0) + 1;
        if (attempts >= MAX_PULL_ATTEMPTS) {
          await kv.delete(k.name);
          log?.("rt-pull-reconcile-giveup", { recordingId, meetingId: rec.meetingId, attempts });
        } else {
          await kv.put(k.name, JSON.stringify({ meetingId: rec.meetingId, attempts }), { expirationTtl: PENDING_TTL_SECONDS });
        }
      }
    }
  } while (cursor);
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
