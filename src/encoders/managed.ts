/// <reference types="@cloudflare/workers-types" />
/**
 * RT-P1.5 — Adapter C: CF-native managed WebM recording (design §2). The FASTEST path to a real recording
 * on disk: don't encode anything ourselves. Ask CF to record the session to WebM, then stream the finished
 * file into the SKIP-tier `RealtimeRecorder` so it lands as the one canonical org-prefixed object —
 * uniform storage path / lifecycle / SKIP semantics regardless of who encoded it.
 *
 * Data flow (design §2):
 *   begin(session) → POST CF managed-recording start  (recordingId)        [no local media]
 *   onPublish(...)  → no-op (CF taps the SFU/RTK session directly)
 *   finalize()      → POST stop → poll for the ready WebM URL → fetch(stream) → recorder.appendFrom(stream)
 *                   → recorder.finalize()  // ONE canonical .webm, SKIP, no hash
 *
 * SKIP compliance: C never sees frames and never hashes — it streams a finished file into `appendFrom`.
 * Trivially SKIP-clean. This module NEVER imports `@wave-av/content-hash`.
 *
 * OPEN DEPENDENCY (design §2 caveat / §7 spike): CF managed/track recording is documented as an RTK-meeting
 * feature; the exact endpoint for a raw CF-Calls SFU session must be confirmed in the §7 spike. That
 * dependency does NOT block this code — the REST surface is injectable (`ManagedRecordingApi`) so the
 * adapter is fully unit-testable with a fake, and the real endpoint shape is the ONE thing the spike fills.
 */
import { RealtimeRecorder, type RecordingResult } from "../recording-writer.js";
import type { EncoderEnv, EncoderHandle, RecordingEncoder, RecordingSession } from "./encoder.js";

/**
 * The CF managed-recording REST surface, injected so the adapter is testable without live network. The
 * concrete URLs/auth are filled by the §7 spike; `DefaultManagedRecordingApi` is the live binding.
 */
export interface ManagedRecordingApi {
  /** Ask CF to start recording `sessionId`; returns the managed recording id. */
  start(sessionId: string): Promise<{ recordingId: string }>;
  /** Ask CF to stop recording, poll until ready, and return a fetchable WebM URL (or null if nothing). */
  stop(recordingId: string): Promise<{ webmUrl: string } | null>;
  /** Fetch the finished WebM as a byte stream (null body → nothing recorded). */
  fetchRecording(webmUrl: string): Promise<ReadableStream<Uint8Array> | null>;
}

/**
 * Live binding for the RealtimeKit (Cloudflare Realtime managed) recording REST API — §7 spike captured
 * (api-contracts-rtk-and-ws-adapter.md, verified against developers.cloudflare.com/realtime/realtimekit/
 * recording-guide). RealtimeKit records the MEETING (not a raw SFU session) → for adapter C, the
 * RecordingSession.sessionId IS the RTK meeting id (the worker maps an /rtk meeting to it).
 *
 *   start  → POST /accounts/{acc}/realtime/kit/{app}/recordings {meeting_id}  → data.id (recordingId)
 *   stop   → PUT  /accounts/{acc}/realtime/kit/{app}/recordings/{id} {action:"stop"}, then poll
 *            GET  /accounts/{acc}/realtime/kit/{app}/recordings/{id} until status UPLOADED → download_url
 *   fetch  → GET the download_url body (composite mp4 / track webm)
 *
 * Fail-CLOSED on unconfigured creds (throws → caller's begin() catches → records nothing, never blocks
 * media). The bounded poll keeps a slow upload from hanging the Worker; when it times out, finalize()
 * yields null and the `recording.statusUpdate` webhook (RT-R-WH) is the completion fallback. The poll
 * delay is injected so tests run with no real timers.
 */
const CF_API_BASE = "https://api.cloudflare.com/client/v4"; // fixed host — no request-derived URLs (SSRF-safe)
const HEX32 = /^[0-9a-f]{32}$/i;
const UUIDISH = /^[0-9a-z-]{16,64}$/i;
/** Terminal-ok upload states for the stop() poll. */
const UPLOADED = "UPLOADED";
const ERRORED = "ERRORED";

export class DefaultManagedRecordingApi implements ManagedRecordingApi {
  constructor(
    private readonly env: EncoderEnv,
    /** Injected for tests: a no-op delay so the bounded poll spins without real timers. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** Bounded poll: how many GETs before giving up to the webhook (default ~30s at 3s each). */
    private readonly maxPolls = 10,
    private readonly pollMs = 3000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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

  async stop(recordingId: string): Promise<{ webmUrl: string } | null> {
    if (!UUIDISH.test(recordingId)) return null;
    const stopRes = await this.fetchImpl(`${this.base()}/${recordingId}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ action: "stop" }),
    });
    // A stop on an already-stopped/auto-stopped recording is fine — fall through to the status poll.
    if (!stopRes.ok && stopRes.status !== 409) {
      // best-effort: don't throw the finalize down; the webhook is the completion fallback.
      return null;
    }
    for (let i = 0; i < this.maxPolls; i++) {
      const res = await this.fetchImpl(`${this.base()}/${recordingId}`, { headers: this.headers() });
      let data: Record<string, unknown> | null = null;
      try {
        data = await this.data(res);
      } catch {
        data = null;
      }
      const status = String(data?.status ?? "");
      if (status === UPLOADED) {
        const url = String(data?.download_url ?? "");
        return url ? { webmUrl: url } : null;
      }
      if (status === ERRORED) return null;
      await this.sleep(this.pollMs);
    }
    return null; // timed out → webhook (RT-R-WH) completes the registration
  }

  async fetchRecording(webmUrl: string): Promise<ReadableStream<Uint8Array> | null> {
    const res = await this.fetchImpl(webmUrl);
    if (!res.ok || !res.body) return null;
    return res.body;
  }
}

/**
 * ManagedEncoder (adapter C). Constructed armed (RT_RECORD==="1") by the factory; `begin` starts the CF
 * managed recording and returns a handle whose `finalize` streams the finished WebM into the SKIP sink.
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
    if (this.env.RT_RECORD !== "1") return null; // disarmed → caller no-ops (defense in depth; factory also gates)
    const bucket = this.env.RT_RECORDINGS;
    if (!bucket) {
      // Armed but the SKIP sink binding is absent → fail-open: record nothing, never block media (design §1).
      return null;
    }
    let started: { recordingId: string } | null = null;
    try {
      started = await this.api.start(session.sessionId);
    } catch {
      // Recording is best-effort — a start failure must never throw the session down.
      return null;
    }
    return new ManagedHandle(this.api, bucket, session, started.recordingId);
  }
}

/** One session's managed-recording handle. C never taps frames, so onPublish is intentionally absent. */
class ManagedHandle implements EncoderHandle {
  private recorder: RealtimeRecorder | null = null;
  private finalized: RecordingResult | null = null;
  private done = false;

  constructor(
    private readonly api: ManagedRecordingApi,
    private readonly bucket: R2Bucket,
    private readonly session: RecordingSession,
    private readonly recordingId: string,
  ) {}

  async finalize(): Promise<RecordingResult | null> {
    if (this.done) return this.finalized; // idempotent
    this.done = true;
    let ready: { webmUrl: string } | null = null;
    try {
      ready = await this.api.stop(this.recordingId);
    } catch {
      return null; // best-effort
    }
    if (!ready) return null;
    const stream = await this.api.fetchRecording(ready.webmUrl);
    if (!stream) return null;

    // Stream the finished WebM into the SKIP sink. `begin` needs the first bytes to sniff the container, so
    // tee a small head: read one chunk, seed the recorder, then drain the rest. tier=SKIP throughout.
    const reader = stream.getReader();
    try {
      const first = await reader.read();
      if (first.done || !first.value || first.value.length === 0) {
        return null; // nothing recorded → never a 0-byte object
      }
      this.recorder = await RealtimeRecorder.begin(
        this.bucket,
        this.session.org,
        this.session.sessionId,
        first.value,
      );
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) await this.recorder.append(value);
      }
    } finally {
      reader.releaseLock();
    }
    this.finalized = await this.recorder.finalize();
    return this.finalized;
  }

  async abort(): Promise<void> {
    this.done = true;
    await this.recorder?.safeAbort().catch(() => {});
  }

  toMeta(): unknown | null {
    return this.recorder?.toMeta() ?? null;
  }
}
