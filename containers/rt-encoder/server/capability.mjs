// rt-encoder CAPABILITY detection (ADR §Capability detection — "the host-adaptive core"). At startup we
// probe what THIS host's ffmpeg can actually do: `ffmpeg -hide_banner -encoders` (the available encoder
// set) and `ffmpeg -hide_banner -hwaccels` (the hardware-accel methods). The parse is a PURE function
// (parseEncoders / parseHwaccels) split from the spawn (probeCapability) so it is unit-testable on
// fixture strings with NO ffmpeg present — CI has no GPU and must not shell out.
//
// We never trust the registry's claim that an encoder exists; we INTERSECT the registry with what ffmpeg
// reports on this box. CF Containers → a software-only set; a Mac/NVIDIA box → that plus its hw encoders.

import { spawn } from "node:child_process";

/**
 * @typedef {Object} Capability
 * @property {Set<string>} encoders  ffmpeg encoder names available on this host (e.g. "libvpx",
 *                                    "h264_nvenc", "hevc_videotoolbox", "libopus").
 * @property {Set<string>} hwaccels  hardware-accel methods (e.g. "cuda","videotoolbox","qsv","vaapi").
 */

/**
 * Parse the stdout of `ffmpeg -hide_banner -encoders` into the set of encoder NAMES.
 *
 * The format is a header block, an `------` separator, then one line per encoder:
 *   ` V....D libx264              libx264 H.264 ... (codec h264)`
 *   ` A....D libopus              libopus Opus (codec opus)`
 * Column 1 is a flag field whose first char is the media class (V/A/S); the 2nd token is the encoder
 * NAME (what `-c:v`/`-c:a` takes). We collect the name; the `(codec X)` suffix is metadata we ignore.
 *
 * @param {string} stdout raw `ffmpeg -encoders` output.
 * @returns {Set<string>} encoder names present on this host.
 */
export function parseEncoders(stdout) {
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
    // an encoder row begins with a 6-char flag field: [VASD.][F.][S.][X.][B.][D.] then whitespace+name.
    // Be permissive about the exact flag chars; require the leading media class + a name token.
    const m = line.match(/^\s*([VASD][\w.]{5})\s+(\S+)/);
    if (m) names.add(m[2]);
  }
  return names;
}

/**
 * Parse the stdout of `ffmpeg -hide_banner -hwaccels` into the set of hwaccel method names.
 * Format: a header line ("Hardware acceleration methods:") then one method per line.
 * @param {string} stdout raw `ffmpeg -hwaccels` output.
 * @returns {Set<string>} hwaccel method names (e.g. "videotoolbox","cuda","qsv","vaapi").
 */
export function parseHwaccels(stdout) {
  const methods = new Set();
  if (!stdout) return methods;
  for (const raw of String(stdout).split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    if (/hardware acceleration methods/i.test(line)) continue;
    // a method is a single bare token (no spaces); skip anything that looks like prose.
    if (/^[a-z0-9_]+$/.test(line)) methods.add(line);
  }
  return methods;
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
      // `-encoders`/`-hwaccels` exit 0 and write to stdout; some builds also echo to stderr. Prefer
      // stdout but fall back to stderr if stdout was empty (defensive — never lose the listing).
      if (code === 0) resolve(out || err);
      else reject(new Error(`ffmpeg ${args[args.length - 1]} exited ${code}`));
    });
  });
}

/**
 * Probe THIS host by spawning ffmpeg twice. Pure parse is separated above; this is the only impure part.
 * @param {{ ffmpegBin?: string }} [opts]
 * @returns {Promise<Capability>}
 */
export async function probeCapability(opts = {}) {
  const bin = opts.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg";
  const [encOut, hwOut] = await Promise.all([
    runFfmpeg(["-hide_banner", "-encoders"], bin),
    runFfmpeg(["-hide_banner", "-hwaccels"], bin).catch(() => ""), // hwaccels is advisory; don't fail probe
  ]);
  return { encoders: parseEncoders(encOut), hwaccels: parseHwaccels(hwOut) };
}

/** @returns {Capability} an empty capability (no encoders) — used as a safe default before probing. */
export function emptyCapability() {
  return { encoders: new Set(), hwaccels: new Set() };
}
