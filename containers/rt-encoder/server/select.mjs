// rt-encoder SELECTION POLICY (ADR §Capability detection + §Mux constraint). Given a requested codec and
// the host's AVAILABLE encoder set, pick the best encoder impl (hardware-first, software fallback) — and
// HONEST-FAIL when the requested codec has NO available encoder. Per the ADR: "never silently substitute
// a different codec." We throw a typed CodecUnavailableError so the caller decides (recording is best-
// effort/fail-open; egress may surface the error) — but we NEVER quietly encode a codec the caller didn't
// ask for. selectContainer() then pairs the chosen video+audio codecs into the right muxer container.

import { getCodecEntry, isVideoCodec } from "./codecs.mjs";

/** Thrown when a requested codec has no encoder available on this host. Typed so callers can branch. */
export class CodecUnavailableError extends Error {
  /** @param {string} codec @param {string[]} tried encoder names that were checked but absent. */
  constructor(codec, tried) {
    super(
      `no available ffmpeg encoder for codec "${codec}" on this host` +
        (tried.length ? ` (tried: ${tried.join(", ")})` : ""),
    );
    this.name = "CodecUnavailableError";
    this.code = "CODEC_UNAVAILABLE";
    this.codec = codec;
    this.tried = tried;
  }
}

/** Thrown when the requested codec name is not in the registry at all (unknown codec). */
export class UnknownCodecError extends Error {
  /** @param {string} codec */
  constructor(codec) {
    super(`unknown codec "${codec}" (not in the rt-encoder registry)`);
    this.name = "UnknownCodecError";
    this.code = "UNKNOWN_CODEC";
    this.codec = codec;
  }
}

/**
 * @typedef {Object} SelectPolicy
 * @property {boolean} [preferHardware=true]  prefer hardware encoders when available (ADR default).
 * @property {boolean} [allowHardware=true]   permit hardware at all (false → software-only, e.g. forced).
 */

/**
 * @typedef {Object} SelectedEncoder
 * @property {string} codec                 the requested codec (lower-cased).
 * @property {string} encoder               the chosen ffmpeg encoder name.
 * @property {"sw"|"hw"} kind               hardware or software.
 * @property {string} accel                 accel family ("none" for software).
 * @property {string} container             the container this codec implies (from the registry).
 */

/**
 * Pick the best AVAILABLE encoder for `codec`. Walks the registry's BEST-FIRST list; with preferHardware
 * (default) it returns the first available hardware encoder, else the first available software one. With
 * preferHardware=false it returns the first available SOFTWARE encoder (hardware skipped). HONEST-FAIL:
 * if no listed encoder is in `available`, throws CodecUnavailableError — NEVER substitutes another codec.
 *
 * @param {"video"|"audio"} kind   media kind (validated against the registry entry's media).
 * @param {string} codec           requested codec name (case-insensitive).
 * @param {Set<string>} available  encoder names available on this host (from capability.parseEncoders).
 * @param {SelectPolicy} [policy]
 * @returns {SelectedEncoder}
 * @throws {UnknownCodecError|CodecUnavailableError}
 */
export function selectEncoder(kind, codec, available, policy = {}) {
  const name = String(codec || "").toLowerCase();
  const entry = getCodecEntry(name);
  if (!entry) throw new UnknownCodecError(name);
  if (kind && entry.media !== kind) {
    throw new UnknownCodecError(`${name} (expected ${kind}, registry says ${entry.media})`);
  }
  const avail = available instanceof Set ? available : new Set(available || []);
  const preferHardware = policy.preferHardware !== false;
  const allowHardware = policy.allowHardware !== false;

  // Candidate impls in policy order. Registry is hardware-first; if hardware is disallowed OR not
  // preferred, we reorder so software comes first (still honest — only the host-present ones are chosen).
  const usable = entry.encoders.filter((e) => (e.kind === "hw" ? allowHardware : true));
  const ordered = preferHardware
    ? usable // registry already hw-first
    : [...usable].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "sw" ? -1 : 1));

  const tried = [];
  for (const impl of ordered) {
    tried.push(impl.encoder);
    if (avail.has(impl.encoder)) {
      return {
        codec: name,
        encoder: impl.encoder,
        kind: impl.kind,
        accel: impl.accel,
        container: entry.container,
      };
    }
  }
  // No available encoder for this codec — honest-fail. Do NOT fall through to another codec.
  throw new CodecUnavailableError(name, tried);
}

/**
 * @typedef {Object} NegotiatedCodec
 * @property {string} codec        the chosen codec (first in preference order with an available encoder).
 * @property {string} encoder      the chosen ffmpeg encoder name.
 * @property {"sw"|"hw"} kind      hardware or software.
 * @property {string} accel        accel family ("none" for software).
 * @property {string} container    the container this codec implies.
 * @property {number} score        1.0 at the top preference, decreasing down the ladder (never 0 for a
 *                                  codec that works): score = 1 - depth/preferences.length.
 * @property {number} depth        0 = top preference chosen; N = the Nth fallback was needed.
 * @property {string[]} demoted    codecs higher in the ladder that were unavailable (skipped, for logging).
 */

/**
 * SCORED FALLBACK LADDER (#86 P2, scored-transport-fallback-ladder). Given an ORDERED preference list of
 * dest codecs (best-first, e.g. ["av1","vp9","vp8","h264"]) and the host's available encoders, return the
 * first codec we can actually encode — scoring DOWN each rung instead of hard-failing on the top choice.
 *
 * This is the EXPLICIT negotiation the ADR's honest-fail rule permits: selectEncoder still THROWS for a
 * single named codec (no silent substitution), but the negotiator deliberately walks a DECLARED ladder
 * and records the demotion (`depth`/`score`/`demoted`) so the caller can log/observe it. We honest-fail
 * (throw) only when the ENTIRE ladder is unavailable — never silently produce nothing.
 *
 * @param {"video"|"audio"} kind   media kind.
 * @param {string|string[]} preferences  ordered dest-codec preference (best first). A bare string = one rung.
 * @param {Set<string>} available  encoder names available on this host.
 * @param {SelectPolicy} [policy]
 * @returns {NegotiatedCodec}
 * @throws {CodecUnavailableError} when no codec in the ladder has an available encoder.
 */
export function negotiateCodec(kind, preferences, available, policy = {}) {
  const ladder = (Array.isArray(preferences) ? preferences : [preferences])
    .map((c) => String(c || "").toLowerCase())
    .filter(Boolean);
  if (!ladder.length) throw new Error("negotiateCodec: empty preference list");
  const avail = available instanceof Set ? available : new Set(available || []);
  const demoted = [];
  for (let depth = 0; depth < ladder.length; depth++) {
    const codec = ladder[depth];
    try {
      const sel = selectEncoder(kind, codec, avail, policy);
      return { ...sel, score: 1 - depth / ladder.length, depth, demoted: [...demoted] };
    } catch (err) {
      // an unavailable OR unknown rung is simply skipped (it's not on offer); any other error propagates.
      if (err instanceof CodecUnavailableError || err instanceof UnknownCodecError) {
        demoted.push(codec);
        continue;
      }
      throw err;
    }
  }
  // The whole ladder is unavailable — honest-fail with the full chain in the message.
  throw new CodecUnavailableError(ladder.join(" → "), demoted);
}

/**
 * Pick the muxer CONTAINER for a (videoCodec, audioCodec) pair (ADR §Mux constraint, codec-aware muxer):
 *   - VP8/VP9/AV1 (+ Opus/Vorbis)  → webm
 *   - H.264/H.265/ProRes (+ AAC)   → mp4
 *   - any mismatch / FLAC / PCM    → mkv (Matroska carries everything — the universal fallback)
 * Audio-only (no video) follows the audio codec's natural container.
 *
 * @param {string|null|undefined} videoCodec  e.g. "vp9","h264" (or null for audio-only).
 * @param {string|null|undefined} audioCodec  e.g. "opus","aac" (or null for video-only).
 * @returns {"webm"|"mp4"|"mkv"}
 */
export function selectContainer(videoCodec, audioCodec) {
  const v = videoCodec ? String(videoCodec).toLowerCase() : null;
  const a = audioCodec ? String(audioCodec).toLowerCase() : null;

  const WEBM_VIDEO = new Set(["vp8", "vp9", "av1"]);
  const MP4_VIDEO = new Set(["h264", "h265", "prores"]);
  const WEBM_AUDIO = new Set(["opus", "vorbis"]);
  const MP4_AUDIO = new Set(["aac", "mp3", "ac3", "eac3"]);

  // Audio-only: follow the audio codec.
  if (!v) {
    if (a && WEBM_AUDIO.has(a)) return "webm";
    if (a && MP4_AUDIO.has(a)) return "mp4";
    return "mkv";
  }
  // Video-led: the video codec picks the family; if the audio codec disagrees, fall back to MKV which
  // carries any combination (never silently drop or transcode the audio to fit the container).
  if (WEBM_VIDEO.has(v)) {
    if (!a || WEBM_AUDIO.has(a)) return "webm";
    return "mkv"; // e.g. VP9 + AAC — not a valid WebM pairing → MKV.
  }
  if (MP4_VIDEO.has(v)) {
    if (!a || MP4_AUDIO.has(a)) return "mp4";
    return "mkv"; // e.g. H.264 + Opus → MKV.
  }
  return "mkv";
}

/** @returns {boolean} convenience guard re-exported for index.mjs wiring. */
export function isKnownVideoCodec(codec) {
  return isVideoCodec(codec);
}
