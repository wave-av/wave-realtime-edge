/// <reference types="@cloudflare/workers-types" />
/**
 * RT-P1.2 — RealtimeRecorder: a single-instance-SAFE recording writer for the realtime/SFU producer.
 *
 * tier=SKIP (storage-substrate tier model, 2026-06-20). A realtime/SFU session's recorded media is
 * expected to have ~0 byte-identical recurrence (every conference is a unique mix of unique participants),
 * so this writer DELIBERATELY does NOT interact with the dedup index: NO content hashing, NO `claim`,
 * NO `addRef`, NO `@wave-av/content-hash` import, NO `_dup/` routing. SKIP is "the index is never touched"
 * — not "the index is touched with an empty table". The only object this writer ever produces is ONE
 * canonical R2 object per session, written exactly once. (cf. the MoQ recorder's SingleInstanceWriter,
 * which is the FULL=collapse tier — the wrapper this file intentionally does NOT use.)
 *
 * LOAD-BEARING (design §4, fail-safe): this writer must NEVER drop a customer byte. There is no dedup path
 * that could ever delete/move an object here; every appended byte is streamed straight to the one canonical
 * object. A session with no bytes uploads nothing and aborts (never a 0-byte object). Finalize is idempotent
 * (one multipart complete; a retried finalize returns the cached result, never a second commit).
 *
 * FORMAT: realtime/SFU recordings are WebM (the RT design's chosen container — Opus/VP8/VP9/AV1 in a
 * Matroska/WebM segment). The container is *detected* from the first object's leading bytes (sniffWebm)
 * only to pick the file extension; the bytes are always saved verbatim. EBML magic `1A 45 DF A3` →
 * `.webm`; anything else is preserved as opaque raw `.bin` (robust to whatever the recording tap emits —
 * a non-WebM tap, or a future codec, never loses bytes).
 *
 * R2 MULTIPART rule: every part except the last must be the SAME size, so we flush in exact PART_SIZE
 * (5 MiB) chunks and keep the remainder; the final part (on finalize) may be smaller. A session smaller
 * than one part uploads a single (last) part.
 *
 * HIBERNATION: the multipart upload (uploadId + completed parts) is durable server-side; toMeta()/resume()
 * let the Room DO persist that metadata and finish a recording after an eviction. Only the un-flushed
 * in-memory tail (< 5 MiB) is at risk, and only across a mid-session eviction (which needs an idle gap a
 * live realtime stream never has; a clean leave/session-end finalizes first). Because this tier never
 * hashes, resume() carries NO hash-completeness caveat — a resumed write is a normal write.
 *
 * The finalize-hook (wiring this into the Room DO's leave/session-end, RT-P1.2 #32) and the deploy /
 * RT_RECORDINGS R2 binding (RT-P1.2 #34 ◆) are FOLLOW-UPS — this file is the writer only.
 */

/** R2 multipart minimum part size. All parts but the last MUST equal this. */
export const PART_SIZE = 5 * 1024 * 1024;

export type Container = "webm" | "mp4" | "raw";

/** Persisted multipart state — JSON-serializable, stored in DO storage for hibernation resume. */
export interface RecorderMeta {
  /** The realtime session this upload belongs to — a wake must not resume a stale prior session's upload. */
  sessionId: string;
  key: string;
  uploadId: string;
  parts: R2UploadedPart[];
  nextPartNumber: number;
  totalBytes: number;
  container: Container;
}

/** Result of a finalized realtime recording. Null (from finalize) when nothing was recorded. */
export interface RecordingResult {
  /** The R2 key of the single canonical object this session produced. */
  key: string;
  /** Total bytes streamed. */
  bytes: number;
  /** Sniffed container of the streamed object. */
  container: Container;
}

/**
 * Detect the container from the first object's leading bytes, to pick the file extension (bytes are always
 * preserved verbatim regardless). WebM/Matroska begins with the EBML magic `1A 45 DF A3`. ISO-BMFF/MP4
 * (RealtimeKit composite recordings) has an `ftyp` box: 4-byte size, then ASCII `ftyp` at offset 4. Anything
 * else is opaque raw `.bin` (robust to whatever a tap emits — a future codec never loses bytes).
 */
export function sniffWebm(first: Uint8Array): Container {
  if (
    first.length >= 4 &&
    first[0] === 0x1a &&
    first[1] === 0x45 &&
    first[2] === 0xdf &&
    first[3] === 0xa3
  ) {
    return "webm";
  }
  if (
    first.length >= 8 &&
    first[4] === 0x66 && // 'f'
    first[5] === 0x74 && // 't'
    first[6] === 0x79 && // 'y'
    first[7] === 0x70 // 'p'
  ) {
    return "mp4";
  }
  return "raw";
}

/** File extension for a detected container. */
export function extFor(c: Container): string {
  if (c === "webm") return "webm";
  if (c === "mp4") return "mp4";
  return "bin";
}

/**
 * Build the org-prefixed R2 key for a realtime recording (MUST start with `${org}/` — the per-org
 * isolation + register boundary). One object per session under the org's `realtime-recordings/` prefix.
 */
export function recordingKey(org: string, sessionId: string, container: Container): string {
  return `${org}/realtime-recordings/${sessionId}/recording.${extFor(container)}`;
}

/**
 * RealtimeRecorder — persist ONE realtime/SFU session's media to ONE R2 object via a multipart upload,
 * tier=SKIP (no dedup index interaction whatsoever). Mirrors the begin/append/finalize/resume/toMeta/
 * safeAbort shape of the MoQ SessionRecorder so the Room DO can drive it the same way, minus all dedup.
 */
export class RealtimeRecorder {
  private bucket: R2Bucket;
  private upload: R2MultipartUpload | null = null;
  private buf: Uint8Array[] = []; // un-flushed chunk queue (sums to < PART_SIZE after each append)
  private bufLen = 0;
  private parts: R2UploadedPart[] = [];
  private nextPartNumber = 1;
  private totalBytes = 0;
  private finalized: RecordingResult | null = null;

  readonly key: string;
  readonly container: Container;
  readonly sessionId: string;

  private constructor(bucket: R2Bucket, key: string, container: Container, sessionId: string) {
    this.bucket = bucket;
    this.key = key;
    this.container = container;
    this.sessionId = sessionId;
  }

  /**
   * Begin a recording. The container is sniffed from the first object so the key carries the right
   * extension; the multipart upload is created here and that first object is appended. tier=SKIP: no
   * hasher is constructed, no index is consulted.
   */
  static async begin(
    bucket: R2Bucket,
    org: string,
    sessionId: string,
    first: Uint8Array,
  ): Promise<RealtimeRecorder> {
    const container = sniffWebm(first);
    const key = recordingKey(org, sessionId, container);
    const rec = new RealtimeRecorder(bucket, key, container, sessionId);
    rec.upload = await bucket.createMultipartUpload(key);
    await rec.append(first);
    return rec;
  }

  /**
   * Resume a recording after a DO hibernation wake from persisted metadata. Because this tier never hashes,
   * a resumed write is a NORMAL write (no partial-digest caveat) — it streams post-wake bytes onto the same
   * durable multipart upload and finalizes the one canonical object.
   */
  static resume(bucket: R2Bucket, meta: RecorderMeta): RealtimeRecorder {
    const rec = new RealtimeRecorder(bucket, meta.key, meta.container, meta.sessionId);
    rec.upload = bucket.resumeMultipartUpload(meta.key, meta.uploadId);
    rec.parts = meta.parts;
    rec.nextPartNumber = meta.nextPartNumber;
    rec.totalBytes = meta.totalBytes;
    return rec;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Number of parts already uploaded — the DO persists meta only when this changes (not per object). */
  get partCount(): number {
    return this.parts.length;
  }

  /**
   * RT-P1.5 convenience: loop a `ReadableStream<Uint8Array>` into `append`, used by adapter C to stream a
   * finished WebM file (from CF managed recording) into the one canonical object. ADD-ONLY — this is plain
   * sugar over `append`; it adds NO hash/claim/index code and does NOT change the SKIP invariant.
   */
  async appendFrom(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) await this.append(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Append one media chunk, flushing whole PART_SIZE parts as they fill. Empty/no-upload chunks are no-ops. */
  async append(payload: Uint8Array): Promise<void> {
    if (!this.upload || payload.length === 0) return;
    this.buf.push(payload);
    this.bufLen += payload.length;
    this.totalBytes += payload.length;
    while (this.bufLen >= PART_SIZE) {
      const part = this.takeExact(PART_SIZE);
      const uploaded = await this.upload.uploadPart(this.nextPartNumber, part);
      this.parts.push(uploaded);
      this.nextPartNumber += 1;
    }
  }

  /**
   * Finish the recording: flush the remaining tail as the last part and complete the upload. Returns the
   * key + total bytes, or null (after abort) when nothing was recorded — never a 0-byte object. Idempotent:
   * a retried finalize returns the cached result (the upload completes exactly once). tier=SKIP — no digest,
   * no claim, no addRef; the streamed object IS the canonical object, full stop.
   */
  async finalize(): Promise<RecordingResult | null> {
    if (this.finalized) return this.finalized; // idempotent: no second complete, no double-write
    if (!this.upload) return null;
    if (this.parts.length === 0 && this.bufLen === 0) {
      await this.safeAbort();
      return null;
    }
    if (this.bufLen > 0) {
      const tail = this.takeExact(this.bufLen);
      const uploaded = await this.upload.uploadPart(this.nextPartNumber, tail);
      this.parts.push(uploaded);
      this.nextPartNumber += 1;
    }
    try {
      await this.upload.complete(this.parts);
    } catch (err) {
      // R2 completeMultipartUpload is NOT idempotent server-side: the uploadId is consumed on a successful
      // complete. A throw is ambiguous — (a) it genuinely failed and the upload is still open (a retried
      // finalize SHOULD re-complete), or (b) it actually committed but the ACK was lost (a blind retry would
      // throw "no such upload" forever, orphaning a real recording). Disambiguate by HEAD: object present ⇒
      // the complete landed, treat as success; absent ⇒ rethrow so the still-open upload can be retried. We
      // deliberately do NOT null `this.upload` before complete() — that would make a genuine failure
      // un-retryable.
      const landed = await this.bucket.head(this.key);
      if (!landed) throw err;
    }
    this.upload = null;
    this.finalized = { key: this.key, bytes: this.totalBytes, container: this.container };
    return this.finalized;
  }

  /** Abort the multipart upload (best-effort) — used when a session recorded nothing. */
  async safeAbort(): Promise<void> {
    try {
      await this.upload?.abort();
    } catch {
      /* best-effort */
    }
    this.upload = null;
  }

  /** Snapshot for DO storage so a hibernation wake can resume(). Null once finalized or before the upload exists. */
  toMeta(): RecorderMeta | null {
    if (!this.upload) return null;
    return {
      sessionId: this.sessionId,
      key: this.key,
      uploadId: this.upload.uploadId,
      parts: this.parts,
      nextPartNumber: this.nextPartNumber,
      // Persist FLUSHED bytes only. The un-flushed in-memory tail (`bufLen`) is lost on a mid-session eviction
      // (it lives only in `this.buf`, never in meta), so counting it here would make a resumed recorder's
      // final RecordingResult.bytes overcount the actual R2 object. `totalBytes - bufLen` == bytes durably
      // uploaded as parts.
      totalBytes: this.totalBytes - this.bufLen,
      container: this.container,
    };
  }

  /** Pull exactly `n` bytes off the front of the chunk queue into one contiguous array. */
  private takeExact(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.buf[0];
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.buf.shift();
      } else {
        out.set(head.subarray(0, need), off);
        off += need;
        this.buf[0] = head.subarray(need);
      }
    }
    this.bufLen -= n;
    return out;
  }
}
