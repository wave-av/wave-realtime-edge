/// <reference types="@cloudflare/workers-types" />
/**
 * RT-P2.5 — Adapter C: CF-native managed recording, PULL mode (design §2, corrected 2026-06-22).
 *
 * WHY PULL (not direct): RealtimeKit CANNOT upload a recording into our R2 inline. Its `storage_config`
 * destination enum is `aws | azure | digitalocean | gcs | sftp` — there is NO `cloudflare`/R2 option, and a
 * `type:"cloudflare"` is silently dropped (the recording lands in RTK's OWN bucket with RTK key-naming, which
 * has no per-org path → breaks our org-prefix sweep metering). So the ONLY way recordings reach OUR bucket
 * under OUR org-rooted key is to PULL them after the fact:
 *
 *   /rtk/join (stateless)  → api.start(meetingId)            // RTK records to ITS OWN storage; persist meetingId→org
 *   meeting runs … ends … RTK auto-stops … uploads to RTK storage … fires `recording.statusUpdate` UPLOADED
 *   webhook (rtk-webhook.ts) → lookup org by meetingId → resolve download_url → fetch → RealtimeRecorder
 *                            → ONE canonical object at `${org}/realtime-recordings/${meetingId}/recording.mp4`
 *
 * The webhook owns the byte-pull because the stateless /rtk/join request returns in milliseconds and has no
 * way to drive an in-worker finalize across a multi-minute meeting; the signed webhook IS the "recording is
 * ready" signal (no polling needed — it fires exactly at UPLOADED). This module therefore only needs to
 * START the recording and expose the REST primitives the webhook pull uses (resolve download_url + fetch).
 *
 * SKIP compliance: nothing here hashes or claims; this module NEVER imports `@wave-av/content-hash`. The
 * webhook pull streams a finished file straight into the SKIP-tier `RealtimeRecorder` (one object, no dedup).
 */
import type { EncoderEnv, EncoderHandle, RecordingEncoder, RecordingSession } from "./encoder.js";
import type { RecordingResult } from "../recording-writer.js";

const CF_API_BASE = "https://api.cloudflare.com/client/v4"; // fixed host — no request-derived URLs (SSRF-safe)
const HEX32 = /^[0-9a-f]{32}$/i;
const UUIDISH = /^[0-9a-z-]{16,64}$/i;

/**
 * Is adapter C (PULL mode) fully configured to arm a recording on the stateless /rtk/join path? Requires:
 *   • armed (RT_RECORD==="1")
 *   • RTK REST creds to START a recording (CF_ACCOUNT_ID / RTK_APP_ID / CF_API_TOKEN)
 *   • the SKIP sink R2 binding (RT_RECORDINGS) — the webhook writes the pulled bytes there
 *   • the meeting→org KV (RT_MEETING_ORG) — the webhook attributes the recording by meetingId
 * Any absent → false (the caller logs loudly and records nothing — config-no-silent-noop). Note: unlike the
 * retired "direct" mode this does NOT need R2 S3 creds (we never hand RTK an R2 destination — RTK uses its own
 * storage and we pull).
 */
export function pullRecordingConfigured(env: EncoderEnv): boolean {
  return (
    env.RT_RECORD === "1" &&
    !!env.CF_ACCOUNT_ID &&
    HEX32.test(env.CF_ACCOUNT_ID) &&
    !!env.RTK_APP_ID &&
    !!env.CF_API_TOKEN &&
    !!env.RT_RECORDINGS &&
    !!env.RT_MEETING_ORG
  );
}

/**
 * The CF managed-recording REST surface, injected so the adapter is testable without live network.
 *   start            → POST /accounts/{acc}/realtime/kit/{app}/recordings {meeting_id} → data.id (recordingId)
 *   getDownloadUrl   → GET  /accounts/{acc}/realtime/kit/{app}/recordings/{id} → data.download_url (when the
 *                       webhook event omits it; the webhook normally carries downloadUrl directly)
 *   fetchRecording   → GET the download_url body (composite mp4) as a byte stream
 */
export interface ManagedRecordingApi {
  start(meetingId: string): Promise<{ recordingId: string }>;
  getDownloadUrl(recordingId: string): Promise<string | null>;
  fetchRecording(url: string): Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * Live binding for the RealtimeKit (Cloudflare Realtime managed) recording REST API. RealtimeKit records the
 * MEETING → for adapter C the RecordingSession.sessionId IS the RTK meeting id. Fail-CLOSED on unconfigured
 * creds (throws → caller's begin() catches → records nothing, never blocks media).
 */
export class DefaultManagedRecordingApi implements ManagedRecordingApi {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly env: EncoderEnv,
    fetchImpl: typeof fetch = fetch,
  ) {
    // Bind to globalThis. Native `fetch` throws "Illegal invocation" when called as a method — `this.fetchImpl(...)`
    // would set this=the api instance instead of the global. Binding makes every call site safe (and is a harmless
    // no-op for an injected test fake, which ignores `this`). See developers.cloudflare.com/workers/observability/errors.
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private base(): string {
    const acc = this.env.CF_ACCOUNT_ID ?? "";
    const app = this.env.RTK_APP_ID ?? "";
    if (!HEX32.test(acc) || !UUIDISH.test(app) || !this.env.CF_API_TOKEN) {
      throw new Error("RT managed-recording is not configured (CF_ACCOUNT_ID/RTK_APP_ID/CF_API_TOKEN)");
    }
    return `${CF_API_BASE}/accounts/${acc}/realtime/kit/${app}/recordings`;
  }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.env.CF_API_TOKEN}` };
  }

  /** Parse the RealtimeKit `{success, data}` envelope; throws on a non-success/non-2xx response. */
  private async data(res: Response): Promise<Record<string, unknown>> {
    let json: { success?: boolean; data?: Record<string, unknown> } | null = null;
    try {
      json = (await res.json()) as { success?: boolean; data?: Record<string, unknown> };
    } catch {
      json = null;
    }
    if (!res.ok || !json?.success || !json.data) {
      throw new Error(`RTK recording API ${res.status} (success=${json?.success})`);
    }
    return json.data;
  }

  /** Start recording the meeting. PULL mode: NO storage_config — RTK records to its own storage; we pull later. */
  async start(meetingId: string): Promise<{ recordingId: string }> {
    const res = await this.fetchImpl(this.base(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ meeting_id: meetingId }),
    });
    const data = await this.data(res);
    const id = String(data.id ?? "");
    if (!id) throw new Error("RTK recording start: missing data.id");
    return { recordingId: id };
  }

  /**
   * Resolve a fresh download URL for a finished recording (GET the recording object). Used by the webhook pull
   * only when the `recording.statusUpdate` event itself omitted the URL. Returns null (not throw) on any
   * non-success so the pull treats it as "nothing to fetch" — best-effort, never blocks the ack.
   */
  async getDownloadUrl(recordingId: string): Promise<string | null> {
    if (!UUIDISH.test(recordingId)) return null;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base()}/${recordingId}`, { headers: this.headers() });
    } catch {
      return null;
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = await this.data(res);
    } catch {
      return null;
    }
    const url = String(data?.download_url ?? data?.downloadUrl ?? "");
    return url || null;
  }

  /**
   * Fetch the finished recording as a byte stream (null body → nothing to write). `redirect:"error"` —
   * RTK's signed download URLs are terminal, so a 30x is unexpected AND would bypass the caller's
   * isSafePublicHttpsUrl host guard (a redirect to a private/metadata host = SSRF). Fail closed: a redirect
   * throws → the webhook catch logs an alarm + enqueues a pending retry, never failing the ack.
   */
  async fetchRecording(url: string): Promise<ReadableStream<Uint8Array> | null> {
    const res = await this.fetchImpl(url, { redirect: "error" });
    if (!res.ok || !res.body) return null;
    return res.body;
  }
}

/**
 * ManagedEncoder (adapter C, PULL mode). The factory constructs it armed (RT_RECORD==="1"). `begin` starts the
 * RTK recording (RTK → its own storage) and returns a correlation-only handle — there is NOTHING to finalize
 * in-worker on this stateless path; the `recording.statusUpdate` webhook pulls the finished file into our R2.
 */
export class ManagedEncoder implements RecordingEncoder {
  readonly kind = "managed" as const;
  private readonly api: ManagedRecordingApi;

  constructor(
    private readonly env: EncoderEnv,
    api?: ManagedRecordingApi,
  ) {
    this.api = api ?? new DefaultManagedRecordingApi(env);
  }

  async begin(session: RecordingSession): Promise<EncoderHandle | null> {
    if (this.env.RT_RECORD !== "1") return null; // disarmed (defense in depth; the factory also gates)
    let started: { recordingId: string };
    try {
      started = await this.api.start(session.sessionId);
    } catch {
      return null; // best-effort — a start failure must never throw the session down
    }
    return new PullManagedHandle(started.recordingId, session);
  }
}

/**
 * PULL-mode handle: RTK records to its own storage and the worker pulls the finished file in the webhook, so
 * there is nothing for this stateless handle to flush or finalize. It carries the correlation (recordingId +
 * org-rooted keyPrefix) for the arm-time log line + webhook/index correlation. C never taps frames, so
 * `onPublish` is intentionally absent.
 */
export class PullManagedHandle implements EncoderHandle {
  /** Org-rooted R2 key prefix the webhook will write the pulled recording under. */
  readonly keyPrefix: string;
  constructor(
    readonly recordingId: string,
    readonly session: RecordingSession,
  ) {
    this.keyPrefix = `${session.org}/realtime-recordings/${session.sessionId}/`;
  }

  /** Nothing to finalize in-worker — the webhook pull owns the byte transfer + the one canonical object. */
  async finalize(): Promise<RecordingResult | null> {
    return null;
  }

  /** No-op: a started RTK recording auto-stops when the meeting ends; we never stop a live meeting from here. */
  async abort(): Promise<void> {}

  /** No hibernation state — the pull is webhook-driven, not held in this worker. */
  toMeta(): unknown | null {
    return null;
  }
}
