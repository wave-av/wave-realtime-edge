// rt-recorder (#151) — driver: subscribe+record a track, then stream the finalized container into a SINK.
//
// This closes the seam between the werift MediaRecorder (which writes a whole WebM/Matroska FILE) and the DO's
// single-writer canonical object. The `sink` is the SAME contract as src/encoders/recording-sink.ts
// (`write(part: Uint8Array)` appends in order; `finalize()` commits; `abort()` best-effort) — so a self-host
// runtime can feed the recording into the org-rooted R2 canonical object (R2Sink), a local file (LocalFsSink),
// or both (FanoutSink), preserving the SKIP / single-writer invariant. The sink is INJECTED (no R2/creds here).
//
// WHY file-then-stream (not tee): the self-host HAS a filesystem (that is the whole point of Path B), and
// werift MediaRecorder's proven path writes to a path. Recording to a temp file then streaming it to the sink
// is robust (survives a slow sink), trivially testable, and keeps the proven recorder untouched. The temp file
// is discarded after a successful finalize.
//
// AV1/H265 short-circuit: when `subscribeAndRecord` routes to native-transcode, this driver returns that signal
// WITHOUT writing the sink — the caller records that track on the native ffmpeg/GPU path instead (#83/#88).

import { subscribeAndRecord } from "./sfu-track-recorder.mjs";
import { streamFileToSink, DEFAULT_CHUNK } from "./stream-to-sink.mjs";

/**
 * Record one SFU track into a sink.
 *
 * @param {object} o
 * @param {object} o.recorder   opts forwarded to subscribeAndRecord ({ appId, appSecret, publisherSessionId,
 *                              trackName, codec, runMs, sfuBase, fetchImpl, stopTimeoutMs })
 * @param {import("node:fs")} o.fs   node:fs (injected for tests)
 * @param {string} o.tmpPath    where the recorder writes the container before it is streamed to the sink
 * @param {{ write(part:Uint8Array):Promise<void>, finalize():Promise<any>, abort():Promise<void> }} o.sink
 * @param {number} [o.chunkBytes=1MiB]
 * @returns {Promise<{ routed:string, codec:string, reason?:string, result?:any, stats?:any }>}
 */
export async function recordTrackToSink({ recorder, fs, tmpPath, sink, chunkBytes = DEFAULT_CHUNK }) {
  const rec = await subscribeAndRecord({ ...recorder, webmPath: tmpPath });

  // Codec not werift-safe (AV1/H265/unknown) → do NOT write the sink; let the caller take the native path.
  if (rec.routed !== "mediarecorder" || !rec.webmPath) {
    return { routed: rec.routed, codec: rec.codec, reason: rec.reason, stats: rec.stats };
  }

  try {
    await streamFileToSink(fs, rec.webmPath, sink, chunkBytes);
    const result = await sink.finalize();
    return { routed: "mediarecorder", codec: rec.codec, result, stats: rec.stats };
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  } finally {
    // Best-effort temp cleanup — the canonical bytes now live in the sink.
    try {
      fs.rmSync(rec.webmPath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
