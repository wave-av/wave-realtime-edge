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
// AV1/H265 (#153): when `subscribeAndRecord` routes to native-transcode AND captured a native input (a file, or
// the live werift→UDP SDP bridge), this driver runs it through ffmpeg (native-transcode.mjs) into the SAME WebM
// sink — so AV1 (rewrap) and H265 (→AV1) land in the canonical object too, not just the werift-safe codecs. When
// no native input was captured (no bridge yet for this source), it returns the honest signal — the caller records
// that track on the GPU/native path (#83/#88). Codec-COMPLETE: the recorder's output never depends on the input codec.

// NOTE: subscribeAndRecord is imported LAZILY (dynamic import in the default path) because sfu-track-recorder
// pulls in `werift` (node:dgram/dtls) — only present in the container image, not the pure test env. Injecting
// `subscribe` (tests do) never triggers the dynamic import, so this module stays importable without werift.
import { transcodeToWebm } from "./native-transcode.mjs";
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
 * @param {Function} [o.subscribe]  injectable pull+record (default: lazily-imported subscribeAndRecord)
 * @param {typeof transcodeToWebm} [o.transcode]     injectable native fallback (default transcodeToWebm)
 * @returns {Promise<{ routed:string, codec:string, reason?:string, result?:any, stats?:any }>}
 */
export async function recordTrackToSink({ recorder, fs, tmpPath, sink, chunkBytes = DEFAULT_CHUNK, subscribe, transcode = transcodeToWebm }) {
  const doSubscribe = subscribe ?? (await import("./sfu-track-recorder.mjs")).subscribeAndRecord;
  const rec = await doSubscribe({ ...recorder, webmPath: tmpPath });

  // werift-safe (VP8/VP9/H264/Opus): the recorder wrote a WebM file → stream it to the sink.
  if (rec.routed === "mediarecorder" && rec.webmPath) {
    return streamToSink(fs, rec.webmPath, sink, chunkBytes, { routed: "mediarecorder", codec: rec.codec, stats: rec.stats });
  }

  // #153 native (AV1/H265): if the recorder captured a native input (a file, or the werift→UDP SDP bridge),
  // transcode/rewrap it to WebM at tmpPath and stream to the SAME sink → codec-complete canonical object.
  if (rec.nativeInput?.input) {
    const t = await transcode({ ...rec.nativeInput, codec: rec.codec, outPath: tmpPath });
    return streamToSink(fs, t.outPath, sink, chunkBytes, { routed: "native-transcode", codec: t.codec, stats: rec.stats });
  }

  // Native codec but no capture bridge for this source → honest signal; the caller records it natively (#83/#88).
  return { routed: rec.routed, codec: rec.codec, reason: rec.reason, stats: rec.stats };
}

/** Stream a finalized WebM file into the sink, finalize, and best-effort clean the temp. Shared by both paths. */
async function streamToSink(fs, path, sink, chunkBytes, meta) {
  try {
    await streamFileToSink(fs, path, sink, chunkBytes);
    const result = await sink.finalize();
    return { ...meta, result };
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  } finally {
    // Best-effort temp cleanup — the canonical bytes now live in the sink.
    try {
      fs.rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
