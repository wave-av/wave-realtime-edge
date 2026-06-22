/// <reference types="@cloudflare/workers-types" />
/**
 * RT-P1.5 — the `RecordingEncoder` seam (design §1).
 *
 * ONE interface, swappable adapters. An encoder's whole job: given a started session, drive bytes into
 * the SKIP-tier `RealtimeRecorder` sink and finalize. The encoder owns "where the bytes come from + how
 * they become WebM"; the recorder owns "one canonical R2 object, never drop a byte, idempotent finalize".
 * The two never blur — and crucially the SINGLE sink (`recorder.append`/`finalize`) is what mechanically
 * guarantees the SKIP invariant for EVERY adapter.
 *
 * CRITICAL INVARIANT (non-negotiable, all adapters): the realtime recording path is tier=SKIP — no-hash /
 * no-claim / no-refcount end-to-end. NOTHING in this module, NO adapter, and NOTHING downstream of an
 * adapter may import `@wave-av/content-hash` (that is the FULL-tier claim path; realtime is SKIP). The
 * bundle-guard test (test/encoders/bundle-guard.test.ts) asserts this mechanically.
 */
import type { RecordingResult } from "../recording-writer.js";

/** Identity of the session being recorded — the SKIP key is derived from these, NEVER a content hash. */
export interface RecordingSession {
  org: string;
  room: string;
  /** The CF-Calls SFU session id (or managed-recording id for adapter C). The canonical R2 key uses this. */
  sessionId: string;
}

/**
 * What an encoder needs from the host env. NO content-hash binding, NO dedup binding — by construction.
 * `RT_RECORD` arms the feature (default OFF → inert); `RT_ENCODER` selects the adapter (default "managed").
 */
export interface EncoderEnv {
  CF_CALLS_APP_ID?: string;
  CF_CALLS_APP_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string; // adapter C: RealtimeKit managed-recording REST (account API token, Bearer)
  RTK_APP_ID?: string; // adapter C: the RealtimeKit app id whose meeting is recorded (recordings are per-meeting)
  RT_RECORDINGS?: R2Bucket; // the SKIP sink bucket (RT-P2.4 ◆ binding; absent until armed+attached)
  RT_ENCODER?: EncoderKind; // selector; default "managed" (C)
  RT_RECORD?: string; // "1" to arm recording at all (default OFF — fully inert)
  // ── adapter C "direct" mode (storage_config): RTK uploads the finished recording STRAIGHT to our R2 at an
  // org-rooted path, so the bytes never transit this worker (no double-egress, no worker time/CPU limit on a
  // GB-sized meeting). The daily storage sweep bills it by org-prefix. These three configure that path; when
  // any is absent, direct mode is OFF (begin() loud-nulls — config-no-silent-noop). ──
  RT_RECORDINGS_BUCKET?: string; // R2 bucket NAME RTK writes to (storage_config.bucket), e.g. "wave-realtime-recordings"
  RT_R2_ACCESS_KEY_ID?: string; // R2 S3 access-key id handed to RTK (storage_config.access_key) — wrangler SECRET
  RT_R2_SECRET_ACCESS_KEY?: string; // R2 S3 secret handed to RTK (storage_config.secret) — wrangler SECRET
}

export type EncoderKind = "managed" | "container" | "wasm";

/**
 * Pluggable encoder. An adapter implements exactly this; the orchestrator calls it the same way for all.
 */
export interface RecordingEncoder {
  readonly kind: EncoderKind;
  /**
   * Begin recording `session`. The encoder MAY start immediately (C: ask CF to record; A/B: open a WS
   * media-transport pull and start muxing). MUST NOT throw the session down — a recording failure is
   * fail-open (recording is best-effort, never blocks media). Returns null when recording is disarmed
   * (RT_RECORD!=="1") → caller no-ops.
   */
  begin(session: RecordingSession): Promise<EncoderHandle | null>;
}

/** Live handle for one session's recording. Bytes flow to the SKIP sink; finalize is idempotent. */
export interface EncoderHandle {
  /** A track went live (signaling.publishTrack). A/B subscribe to it here; C ignores (CF already taps). */
  onPublish?(trackName: string, kind: "audio" | "video"): Promise<void>;
  /** Session end (signaling.leave / room.endRoom). Flush + finalize the ONE canonical object. Idempotent. */
  finalize(): Promise<RecordingResult | null>;
  /** Best-effort abort (no bytes recorded / error). Never throws. */
  abort(): Promise<void>;
  /** Hibernation snapshot so the Room DO can resume after eviction (delegates to recorder.toMeta()). */
  toMeta(): unknown | null;
}
