// rt-encoder DECODE capability detection (#86 R1, ADR §Capability detection). The ENCODE half already
// exists (capability.mjs probeCapability → `ffmpeg -encoders`); a CapabilityDescriptor ALSO needs the
// DECODE half. The headline asymmetry the any-to-any matrix hinges on: an Ampere RTX-3070 HW-DECODES AV1
// (NVDEC) but cannot HW-ENCODE it (no av1_nvenc) — so decode caps are a SEPARATE set from encode caps and
// MUST be probed independently. This module mirrors capability.mjs EXACTLY: a PURE parser (parseDecoders)
// split from the spawn (probeDecoders) so it is unit-testable on `ffmpeg -decoders` fixture strings with
// NO ffmpeg present (CI has no GPU and must not shell out).
//
// We map ffmpeg DECODER names back to the registry codec names (the `(codec X)` suffix), so the descriptor
// reports decode support in the SAME codec vocabulary as encode (vp8/vp9/av1/h264/h265/opus/aac/…).

import { spawn } from "node:child_process";
import { CODECS } from "./codecs.mjs";

/**
 * @typedef {Object} DecodeCapability
 * @property {Set<string>} decoders  ffmpeg DECODER names available on this host (e.g. "av1", "h264",
 *                                    "av1_cuvid", "hevc", "libdav1d", "opus", "aac").
 */

// ffmpeg's `(codec X)` suffix names the CANONICAL codec; map those + bare decoder names to our registry
// codec keys. ffmpeg uses "hevc" for our "h265"; everything else lines up by name.
const FFMPEG_CODEC_TO_REGISTRY = Object.freeze({
  vp8: "vp8",
  vp9: "vp9",
  av1: "av1",
  h264: "h264",
  hevc: "h265",
  h265: "h265",
  prores: "prores",
  opus: "opus",
  aac: "aac",
  mp3: "mp3",
  flac: "flac",
  vorbis: "vorbis",
  pcm_s16le: "pcm",
  pcm_s24le: "pcm",
  ac3: "ac3",
  eac3: "eac3",
});

/**
 * Parse the stdout of `ffmpeg -hide_banner -decoders` into the set of decoder NAMES.
 *
 * Identical row format to `-encoders`: a legend/header block, a `------` separator, then one line per
 * decoder, e.g.:
 *   ` V....D av1                  Alliance for Open Media AV1 (codec av1)`
 *   ` V....D av1_cuvid            Nvidia CUVID AV1 decoder (codec av1)`
 *   ` A....D opus                 Opus (codec opus)`
 * Column 1 is a flag field whose first char is the media class (V/A/S); the 2nd token is the decoder NAME.
 *
 * @param {string} stdout raw `ffmpeg -decoders` output.
 * @returns {Set<string>} decoder names present on this host.
 */
export function parseDecoders(stdout) {
  const names = new Set();
  if (!stdout) return names;
  let pastHeader = false;
  for (const raw of String(stdout).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!pastHeader) {
      // the dashed separator marks the end of the legend/header block.
      if (/^\s*-{3,}\s*$/.test(line)) pastHeader = true;
      continue;
    }
    // a decoder row begins with a 6-char flag field then whitespace+name (same as parseEncoders).
    const m = line.match(/^\s*([VASD][\w.]{5})\s+(\S+)/);
    if (m) names.add(m[2]);
  }
  return names;
}

/**
 * Reduce a decoder-NAME set to the set of registry CODEC names this host can DECODE. A codec is decodable
 * if ANY decoder whose `(codec X)` (or bare name) maps to it is present — this collapses the many ffmpeg
 * decoders per codec (e.g. `av1`, `av1_cuvid`, `libdav1d` all → "av1") into one capability per codec.
 *
 * The `(codec X)` suffix is the authoritative mapping when present in the raw line; for robustness we also
 * accept the bare decoder name when it equals a known codec (e.g. "opus", "h264").
 *
 * @param {string} stdout raw `ffmpeg -decoders` output (re-parsed to read the `(codec X)` suffix).
 * @returns {Set<string>} registry codec names decodable on this host (e.g. "av1","h264","h265","opus").
 */
export function decodableCodecs(stdout) {
  const codecs = new Set();
  if (!stdout) return codecs;
  let pastHeader = false;
  for (const raw of String(stdout).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!pastHeader) {
      if (/^\s*-{3,}\s*$/.test(line)) pastHeader = true;
      continue;
    }
    const m = line.match(/^\s*([VASD][\w.]{5})\s+(\S+)/);
    if (!m) continue;
    const name = m[2];
    // Prefer the explicit `(codec X)` suffix; fall back to the bare decoder name.
    const suffix = line.match(/\(codec\s+([\w]+)\)/);
    const ffCodec = suffix ? suffix[1] : name;
    const reg = FFMPEG_CODEC_TO_REGISTRY[ffCodec.toLowerCase()];
    if (reg) codecs.add(reg);
  }
  return codecs;
}

/** Spawn ffmpeg with `args` and resolve its combined stdout (stderr captured for diagnostics only). */
function runFfmpeg(args, ffmpegBin) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const ff = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    ff.stdout.on("data", (c) => (out += c.toString()));
    ff.stderr.on("data", (c) => (err += c.toString()));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(out || err);
      else reject(new Error(`ffmpeg ${args[args.length - 1]} exited ${code}`));
    });
  });
}

/**
 * Probe THIS host's DECODE matrix by spawning `ffmpeg -decoders`. Pure parse is separated above; this is
 * the only impure part. Returns BOTH the raw decoder-name set AND the registry-codec decode set.
 * @param {{ ffmpegBin?: string }} [opts]
 * @returns {Promise<{ decoders: Set<string>, decodeCodecs: Set<string> }>}
 */
export async function probeDecoders(opts = {}) {
  const bin = opts.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg";
  const out = await runFfmpeg(["-hide_banner", "-decoders"], bin);
  return { decoders: parseDecoders(out), decodeCodecs: decodableCodecs(out) };
}

/** @returns {{ decoders: Set<string>, decodeCodecs: Set<string> }} empty decode capability (safe default). */
export function emptyDecodeCapability() {
  return { decoders: new Set(), decodeCodecs: new Set() };
}

/** All registry codec names (for callers building a full decode CodecImpl[] over the registry). */
export { CODECS as REGISTRY_CODECS };
