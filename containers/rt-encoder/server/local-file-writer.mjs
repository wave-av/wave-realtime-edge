// rt-encoder SELF-HOST LOCAL FILE WRITER (RT-R10 #72, Path B / local sink). The fs-backed implementation of the
// Worker's `LocalFileWriter` interface (append/close/discard) — living in the NODE container runtime so that
// node:fs NEVER enters the Worker bundle (the Worker's recording-sink.ts deliberately keeps the writer an
// injected interface; this is the real injection a self-host recorder provides). A self-host/on-prem recorder
// builds a `LocalFsSink(localWriterFor(dir, session), session)` so a recording also lands as a REAL local file
// under RECORDER_LOCAL_DIR, mirroring the R2 key layout `${org}/realtime-recordings/${sessionId}/recording.<ext>`.
//
// SKIP-tier: this is a PURE byte sink — it never hashes, claims, or imports @wave-av/content-hash. The extension
// is sniffed from the first bytes (EBML/Matroska magic → .webm, else .raw), matching the Worker's sniffWebm so a
// fanout local copy and the cloud copy share one identity. No-bytes → no file (the no-0-byte-object invariant,
// locally). Fail-soft: discard() never throws.

import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]; // Matroska/WebM DocType header → the .webm extension

/** @param {Uint8Array} first @returns {"webm"|"raw"} */
function extFor(first) {
  for (let i = 0; i < EBML_MAGIC.length; i++) if (first[i] !== EBML_MAGIC[i]) return "raw";
  return "webm";
}

/**
 * fs-backed LocalFileWriter. Lazily creates the directory + write stream on the FIRST non-empty append (so the
 * path's extension reflects the real container), tracks total bytes, and resolves {path,bytes} on close. A writer
 * that never received bytes finalizes to null (no 0-byte file).
 */
export class LocalFileWriter {
  /** @param {string} dir @param {{org:string,sessionId:string}} session */
  constructor(dir, session) {
    this.dir = dir;
    this.session = session;
    /** @type {import("node:fs").WriteStream|null} */
    this.stream = null;
    /** @type {string|null} */
    this.path = null;
    this.bytes = 0;
    this.closed = false;
  }

  /** Append one chunk in order. Begins the file lazily (extension sniffed from the first chunk). @param {Uint8Array} part */
  async append(part) {
    if (this.closed || part.length === 0) return;
    if (!this.stream) {
      const ext = extFor(part);
      this.path = join(this.dir, this.session.org, "realtime-recordings", this.session.sessionId, `recording.${ext}`);
      await mkdir(dirname(this.path), { recursive: true });
      this.stream = createWriteStream(this.path);
    }
    await new Promise((resolve, reject) => {
      this.stream.write(part, (err) => (err ? reject(err) : resolve()));
    });
    this.bytes += part.length;
  }

  /** Close the file; return {path,bytes} (or null if nothing was written). Idempotent. @returns {Promise<{path:string,bytes:number}|null>} */
  async close() {
    const result = () => (this.path && this.bytes > 0 ? { path: this.path, bytes: this.bytes } : null);
    if (this.closed) return result();
    this.closed = true;
    if (!this.stream) return null; // never any bytes → no file
    await new Promise((resolve, reject) => this.stream.end((err) => (err ? reject(err) : resolve())));
    return result();
  }

  /** Best-effort discard of any partial file. Never throws. */
  async discard() {
    this.closed = true;
    if (this.stream) {
      await new Promise((resolve) => this.stream.end(() => resolve()));
      if (this.path) await unlink(this.path).catch(() => {});
    }
  }
}

/** Factory matching the Worker's `localWriterFor(dir, session)` injection shape (SelectSinkDeps.localWriterFor). */
export function localWriterFor(dir, session) {
  return new LocalFileWriter(dir, session);
}
