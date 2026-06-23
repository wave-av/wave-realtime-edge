// rt-encoder FFMPEG COMMAND BUILDER. Turns (source codec, requested TARGET codec, chosen encoder) into a
// fixed ffmpeg argv. SAFETY (same invariant as the original index.mjs): the encoder name comes ONLY from
// the registry/selection (never raw request input), and the input-format args are a fixed allowlist keyed
// by SOURCE codec — so there is no arg injection. Output format is derived from the codec's container.
//
// DEFAULT INVARIANT (ADR §Build): when NO target codec is requested, jpeg→VP8/IVF and pcm→Opus/Ogg are
// emitted BYTE-IDENTICAL to the original hardcoded FFMPEG_ARGS. The matrix is purely ADDITIVE: a target
// codec is selected only when the caller explicitly asks for one (x-target-codec).

import { selectEncoder } from "./select.mjs";

/**
 * The proven, byte-unchanged DEFAULT commands, keyed by SOURCE codec. Kept here verbatim so the test can
 * assert the wired path still emits exactly these (no drift). The Worker POSTs decoded frames:
 *   jpeg = a full MJPEG frame  →  VP8 in IVF   (the WebM muxer's videoEncoder seam)
 *   pcm  = 16-bit-LE @48k stereo → Opus in Ogg (the AudioEncoder seam)
 */
export const DEFAULT_FFMPEG_ARGS = Object.freeze({
  jpeg: ["-hide_banner", "-loglevel", "error", "-f", "mjpeg", "-i", "-", "-c:v", "libvpx", "-f", "ivf", "-"],
  pcm: ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-c:a", "libopus", "-f", "ogg", "-"],
});

/** Source-codec → fixed input-format args (the `-f <demux> [params] -i -` prefix). Allowlist; no input. */
const SOURCE_INPUT_ARGS = Object.freeze({
  jpeg: ["-f", "mjpeg", "-i", "-"],
  pcm: ["-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-"],
});

/** Whether a source codec is a video frame source (jpeg) vs an audio source (pcm). */
const SOURCE_MEDIA = Object.freeze({ jpeg: "video", pcm: "audio" });

/**
 * The output muxer flag for a given codec container. The DEFAULT path uses the codec's NATURAL streaming
 * container (VP8→ivf, Opus→ogg) to stay byte-identical; explicit targets map their registry container to
 * an ffmpeg `-f` muxer name. WebM is muxed as `webm`; mp4 over a pipe needs fragmented mp4.
 * @param {string} container registry container ("webm"|"mp4"|"mkv"|"ivf"|"ogg").
 * @param {string} media "video"|"audio".
 * @returns {string[]} the trailing `-f <muxer> -` output args.
 */
function outputArgs(container, media) {
  switch (container) {
    case "ivf":
      return ["-f", "ivf", "-"];
    case "ogg":
      return ["-f", "ogg", "-"];
    case "webm":
      return ["-f", "webm", "-"];
    case "mp4":
      // mp4 to a non-seekable pipe → fragmented mp4 (movflags) so it streams.
      return ["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-"];
    case "mkv":
      return ["-f", "matroska", "-"];
    default:
      return media === "audio" ? ["-f", "ogg", "-"] : ["-f", "matroska", "-"];
  }
}

/**
 * Build the ffmpeg argv for a transcode.
 *
 * - When `targetCodec` is falsy → the DEFAULT branch: returns the proven byte-unchanged command for the
 *   source codec (jpeg→VP8/IVF, pcm→Opus/Ogg). available/policy are IGNORED here (the default encoders —
 *   libvpx/libopus — are always present in the rt-encoder image; matching the historical behavior).
 * - When `targetCodec` is set → selects the best available encoder (selectEncoder, honest-fail if none),
 *   then builds: `-hide_banner -loglevel error <source input args> -c:v|-c:a <encoder> <output args>`.
 *   For the DEFAULT streaming containers (ivf/ogg) we keep the natural muxer; otherwise the codec's
 *   registry container.
 *
 * @param {Object} p
 * @param {string} p.sourceCodec            "jpeg" | "pcm".
 * @param {string|null} [p.targetCodec]     requested output codec (e.g. "vp9","h264","aac"); null=default.
 * @param {Set<string>} [p.available]       host encoder set (from capability); only used when targeting.
 * @param {import("./select.mjs").SelectPolicy} [p.policy]
 * @returns {{ args: string[], source: string, target: string, encoder: string, kind: string, accel: string, container: string }}
 * @throws {Error} unknown source; UnknownCodecError/CodecUnavailableError from selectEncoder.
 */
export function buildCommand({ sourceCodec, targetCodec = null, available = new Set(), policy = {} }) {
  const src = String(sourceCodec || "").toLowerCase();
  const inputArgs = SOURCE_INPUT_ARGS[src];
  if (!inputArgs) throw new Error(`unsupported source codec: ${src} (expected jpeg|pcm)`);
  const media = SOURCE_MEDIA[src];

  // DEFAULT path — byte-unchanged from the original hardcoded FFMPEG_ARGS.
  if (!targetCodec) {
    const defaultCodec = media === "video" ? "vp8" : "opus";
    const defaultEncoder = media === "video" ? "libvpx" : "libopus";
    return {
      args: [...DEFAULT_FFMPEG_ARGS[src]],
      source: src,
      target: defaultCodec,
      encoder: defaultEncoder,
      kind: "sw",
      accel: "none",
      container: media === "video" ? "ivf" : "ogg",
    };
  }

  // ADDITIVE path — explicit target codec: select the best available encoder (honest-fail if none).
  const sel = selectEncoder(media, targetCodec, available, policy);
  const codecFlag = media === "video" ? "-c:v" : "-c:a";
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputArgs,
    codecFlag,
    sel.encoder,
    ...outputArgs(sel.container, media),
  ];
  return {
    args,
    source: src,
    target: sel.codec,
    encoder: sel.encoder,
    kind: sel.kind,
    accel: sel.accel,
    container: sel.container,
  };
}
