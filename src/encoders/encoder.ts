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
  RT_RECORDINGS?: R2Bucket; // the SKIP sink bucket — the webhook pull writes the finished recording here (RT-P2.4 ◆)
  RT_ENCODER?: EncoderKind; // selector; default "managed" (C)
  RT_RECORD?: string; // "1" to arm recording at all (default OFF — fully inert)
  // adapter A: signs the per-(org,session,track) capability token the SFU appends to the recorder route URL
  // (?t=...) so it can authenticate the dial-in WITHOUT the internal header. Unset → no token (local/test).
  WAVE_INTERNAL_SECRET?: string;
  // ── adapter C PULL mode (design §2, corrected): RTK records to ITS OWN storage (its `storage_config` enum
  // has no R2 option), fires the `recording.statusUpdate` UPLOADED webhook, and the worker PULLS the finished
  // file into RT_RECORDINGS at an org-rooted key. RT_MEETING_ORG carries meetingId→org from the stateless
  // /rtk/join (where org is known) to the later webhook (which only knows the meetingId), so the pull can
  // attribute the recording to the right org-prefix the daily storage sweep bills by. ──
  RT_MEETING_ORG?: KVNamespace; // meetingId → org map, written at join, read at the recording webhook
  // ── RT-R10 (#72) VIDEO encode dispatch (adapter A glue). Where the JPEG→VP8 encode runs for raw-SFU video.
  // ALL default-inert: RECORDER_TARGET defaults 'none' (drop video; prod untouched). 'cf' needs the RECORDER
  // [[containers]] binding; 'selfhost' needs RECORDER_SELFHOST_URL. See src/encoders/recorder-target.ts. ──
  RECORDER_TARGET?: "cf" | "selfhost" | "none"; // selector; default 'none' → video dropped (inert)
  RECORDER?: unknown; // Path A CF Container binding (typed as DurableObjectNamespace<Container> at the seam)
  RECORDER_SELFHOST_URL?: string; // Path B self-hosted rt-encoder base URL (e.g. https://studio:8080)
  // ── #135 negotiation wiring (default-OFF). When "true", the recorder /encode leg attaches the consumer
  // capability descriptor (x-dst-capabilities) so the server negotiates a real leg in a live session. Absent
  // → off → byte-identical to today. RT_REGION / RT_CONSUMER_DECODE / RT_CONSUMER_TRANSPORTS optionally shape
  // the sourced descriptor (see src/encoders/consumer-caps.ts); all absence-tolerant. ──
  NEGOTIATION_ENABLED?: string;
  RT_REGION?: string;
  RT_CONSUMER_DECODE?: string;
  RT_CONSUMER_TRANSPORTS?: string;
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
