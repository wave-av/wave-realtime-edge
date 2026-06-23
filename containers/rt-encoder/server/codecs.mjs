// rt-encoder codec REGISTRY (ADR adr-codec-matrix.md) — the single source of truth mapping each
// media kind → codec → its ORDERED list of ffmpeg encoder impls (hardware-first, software last), plus
// the output container each video/audio codec implies. This module is PURE DATA + tiny pure lookups: no
// spawn, no I/O, no request input — so it is trivially unit-testable and reused by BOTH the recorder
// (raw-SFU → file) and egress (#73 → baseband). Capability detection (capability.mjs) and selection
// policy (select.mjs) consume this registry; index.mjs wires it into the ffmpeg command builder.
//
// "Prefer hardware when the silicon exists, software everywhere else" (ADR §Principle): each codec's
// `encoders[]` is ordered BEST-FIRST so selection walks it and picks the first AVAILABLE entry. Hardware
// families (NVENC / VideoToolbox / QuickSync / VAAPI / AMF) sit before the software fallback.
//
// Runtime reality (ADR §Runtime reality): CF Containers (Path A) are GPU-less x86 Linux → software only;
// the self-host box (Path B) is where the hardware matrix pays off (Mac→VideoToolbox, NVIDIA→NVENC,
// Intel→QuickSync, Linux→VAAPI). The registry lists ALL of them; the AVAILABLE set is host-adaptive.

/** @typedef {"video"|"audio"} MediaKind */
/** @typedef {"sw"|"hw"} EncoderClass */
/** @typedef {"nvenc"|"videotoolbox"|"qsv"|"vaapi"|"amf"|"none"} AccelFamily */
/** @typedef {"webm"|"mp4"|"mkv"|"ogg"|"ivf"} OutputContainer */

/**
 * @typedef {Object} EncoderImpl
 * @property {string}        encoder   ffmpeg encoder name (the `-c:v`/`-c:a` value), e.g. "h264_nvenc".
 * @property {EncoderClass}  kind      "hw" (hardware-accelerated) | "sw" (software).
 * @property {AccelFamily}   accel     hardware family ("none" for software).
 */

/**
 * @typedef {Object} CodecEntry
 * @property {MediaKind}        media      "video" | "audio".
 * @property {EncoderImpl[]}    encoders   ordered BEST-FIRST (hardware before software).
 * @property {OutputContainer}  container  the muxer container this codec implies (video/audio level).
 */

const hw = (encoder, accel) => ({ encoder, kind: "hw", accel });
const sw = (encoder) => ({ encoder, kind: "sw", accel: "none" });

/**
 * VIDEO codecs (ADR §The matrix). Each codec lists every hardware family that can encode it (NVENC,
 * VideoToolbox, QuickSync, VAAPI, AMF) ahead of its software encoder(s). `container` is the codec's
 * NATURAL muxer: VP8/VP9/AV1 → WebM (Matroska family); H.264/H.265/ProRes → MP4.
 */
export const VIDEO_CODECS = /** @type {Record<string, CodecEntry>} */ ({
  vp8: {
    media: "video",
    container: "webm",
    encoders: [hw("vp8_qsv", "qsv"), hw("vp8_vaapi", "vaapi"), sw("libvpx")],
  },
  vp9: {
    media: "video",
    container: "webm",
    encoders: [hw("vp9_qsv", "qsv"), hw("vp9_vaapi", "vaapi"), sw("libvpx-vp9")],
  },
  av1: {
    media: "video",
    container: "webm",
    // hardware AV1: NVENC (Ada+), QuickSync (Arc/Meteor Lake), AMF (RDNA3), VAAPI; software: SVT-AV1
    // (fast, default), then libaom-av1 / librav1e as alternates.
    encoders: [
      hw("av1_nvenc", "nvenc"),
      hw("av1_qsv", "qsv"),
      hw("av1_amf", "amf"),
      hw("av1_vaapi", "vaapi"),
      sw("libsvtav1"),
      sw("libaom-av1"),
      sw("librav1e"),
    ],
  },
  h264: {
    media: "video",
    container: "mp4",
    encoders: [
      hw("h264_nvenc", "nvenc"),
      hw("h264_videotoolbox", "videotoolbox"),
      hw("h264_qsv", "qsv"),
      hw("h264_amf", "amf"),
      hw("h264_vaapi", "vaapi"),
      sw("libx264"),
    ],
  },
  h265: {
    media: "video",
    container: "mp4",
    encoders: [
      hw("hevc_nvenc", "nvenc"),
      hw("hevc_videotoolbox", "videotoolbox"),
      hw("hevc_qsv", "qsv"),
      hw("hevc_amf", "amf"),
      hw("hevc_vaapi", "vaapi"),
      sw("libx265"),
    ],
  },
  // ProRes — pro egress only (ADR §The matrix, optional). Apple silicon does it in hardware; software is
  // the prores_ks encoder. Muxes to MOV/MP4.
  prores: {
    media: "video",
    container: "mp4",
    encoders: [hw("prores_videotoolbox", "videotoolbox"), sw("prores_ks"), sw("prores")],
  },
});

/**
 * AUDIO codecs (ADR §The matrix). Audio is almost always software (the heavy lifting is video); the few
 * hardware paths (e.g. aac_at on Apple AudioToolbox) sit first. `container` is the audio codec's natural
 * muxer when it leads (rarely — usually the VIDEO codec decides the container; selectContainer() pairs
 * them). Opus → WebM/Ogg; AAC → MP4; MP3 → MP3; FLAC → FLAC; Vorbis → WebM/Ogg; PCM → WAV.
 */
export const AUDIO_CODECS = /** @type {Record<string, CodecEntry>} */ ({
  opus: {
    media: "audio",
    container: "webm",
    encoders: [sw("libopus")],
  },
  aac: {
    media: "audio",
    container: "mp4",
    // libfdk_aac is higher quality but non-free (absent in stock ffmpeg); native `aac` is the portable
    // default; aac_at is Apple AudioToolbox hardware-assisted.
    encoders: [hw("aac_at", "videotoolbox"), sw("libfdk_aac"), sw("aac")],
  },
  mp3: {
    media: "audio",
    container: "mp4",
    encoders: [sw("libmp3lame")],
  },
  flac: {
    media: "audio",
    container: "mkv",
    encoders: [sw("flac")],
  },
  vorbis: {
    media: "audio",
    container: "webm",
    encoders: [sw("libvorbis"), sw("vorbis")],
  },
  pcm: {
    media: "audio",
    container: "mkv",
    encoders: [sw("pcm_s16le"), sw("pcm_s24le")],
  },
  // Broadcast egress (ADR §The matrix, optional): AC-3 / E-AC-3.
  ac3: {
    media: "audio",
    container: "mp4",
    encoders: [sw("ac3")],
  },
  eac3: {
    media: "audio",
    container: "mp4",
    encoders: [sw("eac3")],
  },
});

/** Every codec (video + audio) keyed by its canonical name. */
export const CODECS = /** @type {Record<string, CodecEntry>} */ ({ ...VIDEO_CODECS, ...AUDIO_CODECS });

/** All ffmpeg encoder names referenced anywhere in the registry (used to intersect with the host set). */
export const ALL_ENCODER_NAMES = Object.freeze(
  Array.from(new Set(Object.values(CODECS).flatMap((c) => c.encoders.map((e) => e.encoder)))),
);

/** @returns {CodecEntry|undefined} the registry entry for a codec name (lower-cased), or undefined. */
export function getCodecEntry(codec) {
  return CODECS[String(codec || "").toLowerCase()];
}

/** @returns {boolean} whether `codec` is a known VIDEO codec. */
export function isVideoCodec(codec) {
  return Object.prototype.hasOwnProperty.call(VIDEO_CODECS, String(codec || "").toLowerCase());
}

/** @returns {boolean} whether `codec` is a known AUDIO codec. */
export function isAudioCodec(codec) {
  return Object.prototype.hasOwnProperty.call(AUDIO_CODECS, String(codec || "").toLowerCase());
}
