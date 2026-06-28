// AUDIO cross-codec NEGOTIATION matrix (#86 P3 — "any flavor each end", the AUDIO leg). Sibling to
// cross-codec.test.mjs (which proves the VIDEO matrix + one Opus→AAC audio row); this proves the FULL
// per-leg AUDIO transcode path: an encoded SOURCE in audio codec A negotiated to a DEST in audio codec B
// (A ≠ B) produces a correct ffmpeg argv (right demuxer-in for A, encoder-out for B, right container)
// AND — where a real ffmpeg is present — actually renders a sample that DECODES as codec B at the far end.
//
// Why a dedicated audio matrix: PR #95 wired encoded VIDEO sources (h264/vp8/vp9/av1) but only opus/aac
// as encoded AUDIO sources, with a single Opus→AAC row. This file closes the audio gap: it exercises the
// newly-added encoded-audio source legs (mp3, vorbis, flac) and the cross pairings the registry already
// supports, end-to-end, on the SAME buildCommand the recorder/egress use in production.
//
// Two tiers (identical discipline to the video matrix):
//   • Tier 1 (always, CI-safe, NO ffmpeg): pure argv assertions over buildCommand for each pair, plus the
//     honest-fail guards (encoded audio source needs a target; unknown source/codec throws).
//   • Tier 2 (gated on a real ffmpeg in PATH): synthesize a tiny encoded fixture for codec A, pipe it
//     through buildCommand's exact argv, and ffprobe the output to assert codec_name === B.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand } from "../server/command.mjs";

// A software-only host audio set (CF Containers reality): exactly the AUDIO encoders the matrix needs, no
// hardware. These are the registry's software impls for each audio codec.
const SW = new Set(["libopus", "aac", "libmp3lame", "libvorbis", "flac"]);

// The AUDIO cross-codec matrix. Each row: a SOURCE codec ≠ DEST codec, with the expected negotiated argv
// shape and (for Tier 2) how to synthesize the source fixture + which encoder ffmpeg should report out.
// Demuxers (allowlisted, keyed by source codec): opus/vorbis→ogg, aac→aac(ADTS), mp3→mp3, flac→flac.
// Dest containers (from the registry): opus/vorbis→webm, aac/mp3→mp4, flac→mkv(matroska).
const MATRIX = [
  {
    name: "Opus → Vorbis (audio, ogg src → webm dest, both Ogg-family codecs)",
    source: "opus", target: "vorbis",
    expectDemux: ["-f", "ogg", "-i", "-"], expectEncoder: "libvorbis", expectContainer: "webm",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "ogg", "-"],
  },
  {
    name: "AAC → Opus (audio, ADTS src → webm dest)",
    source: "aac", target: "opus",
    expectDemux: ["-f", "aac", "-i", "-"], expectEncoder: "libopus", expectContainer: "webm",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-f", "adts", "-"],
  },
  {
    name: "MP3 → AAC (audio, mp3 src → mp4 dest)",
    source: "mp3", target: "aac",
    expectDemux: ["-f", "mp3", "-i", "-"], expectEncoder: "aac", expectContainer: "mp4",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-f", "mp3", "-"],
  },
  {
    name: "Vorbis → Opus (audio, ogg src → webm dest)",
    source: "vorbis", target: "opus",
    expectDemux: ["-f", "ogg", "-i", "-"], expectEncoder: "libopus", expectContainer: "webm",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libvorbis", "-f", "ogg", "-"],
  },
  {
    name: "FLAC → Opus (audio, lossless flac src → webm dest)",
    source: "flac", target: "opus",
    expectDemux: ["-f", "flac", "-i", "-"], expectEncoder: "libopus", expectContainer: "webm",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "flac", "-f", "flac", "-"],
  },
  {
    name: "Opus → MP3 (audio, ogg src → mp4 dest)",
    source: "opus", target: "mp3",
    expectDemux: ["-f", "ogg", "-i", "-"], expectEncoder: "libmp3lame", expectContainer: "mp4",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "ogg", "-"],
  },
];

// ── Tier 1: argv negotiation (CI-safe) ─────────────────────────────────────────────────────────────
describe("#86 audio cross-codec negotiation — argv (source ≠ dest)", () => {
  for (const row of MATRIX) {
    it(`${row.name} → builds demux-in + audio-encoder-out`, () => {
      const cmd = buildCommand({ sourceCodec: row.source, targetCodec: row.target, available: SW });
      expect(cmd.source).toBe(row.source);
      expect(cmd.target).toBe(row.target);
      expect(cmd.encoder).toBe(row.expectEncoder);
      expect(cmd.container).toBe(row.expectContainer);
      // the source demuxer prefix must appear verbatim (allowlisted, no injection)
      const joined = cmd.args.join(" ");
      expect(joined).toContain(row.expectDemux.join(" "));
      // audio is always wired to -c:a (never -c:v) — the chosen encoder on the audio flag
      expect(joined).toContain(`-c:a ${row.expectEncoder}`);
      expect(joined).not.toContain("-c:v");
    });
  }

  it("encoded audio source with NO target → throws (never silently re-emits source codec)", () => {
    expect(() => buildCommand({ sourceCodec: "mp3" })).toThrow(/requires an explicit target codec/);
    expect(() => buildCommand({ sourceCodec: "flac" })).toThrow(/requires an explicit target codec/);
    expect(() => buildCommand({ sourceCodec: "vorbis" })).toThrow(/requires an explicit target codec/);
  });

  it("unknown audio source codec → throws with the allowlist", () => {
    expect(() => buildCommand({ sourceCodec: "speex", targetCodec: "opus" })).toThrow(
      /unsupported source codec/,
    );
  });

  it("honest-fail: requested dest audio codec with no available encoder → CODEC_UNAVAILABLE", () => {
    // host has only libopus; ask to transcode mp3 → flac (no flac encoder present)
    const onlyOpus = new Set(["libopus"]);
    expect(() =>
      buildCommand({ sourceCodec: "mp3", targetCodec: "flac", available: onlyOpus }),
    ).toThrow(/no available ffmpeg encoder/);
  });

  it("raw pcm default audio path is unchanged (no target) — additive, no drift", () => {
    const a = buildCommand({ sourceCodec: "pcm" });
    expect(a.target).toBe("opus");
    expect(a.encoder).toBe("libopus");
    expect(a.container).toBe("ogg");
  });
});

// ── Tier 2: real render (gated on ffmpeg presence) ─────────────────────────────────────────────────
const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-hide_banner", "-version"]).status === 0;
const liveIt = hasFfmpeg && hasFfprobe ? it : it.skip;

describe("#86 audio cross-codec negotiation — real render decodes as dest codec", () => {
  // 60s budget: up to 6 real ffmpeg transcodes + ffprobe (each fixture+transcode+probe spawn) far
  // exceeds vitest's 5s default; the video matrix is smaller so it fit, the audio matrix needs the room.
  liveIt("renders the audio matrix and each output decodes as the dest audio codec", () => {
    const dir = mkdtempSync(join(tmpdir(), "axc-86-"));
    try {
      for (const row of MATRIX) {
        // 1. synthesize an encoded SOURCE fixture in audio codec A (stdout → buffer)
        const fix = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...row.fixtureArgs], {
          maxBuffer: 64 * 1024 * 1024,
        });
        // a fixture encoder may be absent on a minimal ffmpeg build — skip that row honestly, don't fail.
        if (fix.status !== 0 || fix.stdout.length === 0) continue;

        // 2. drive the SAME argv buildCommand produced — the production negotiation path
        const cmd = buildCommand({ sourceCodec: row.source, targetCodec: row.target, available: SW });
        const run = spawnSync("ffmpeg", cmd.args, { input: fix.stdout, maxBuffer: 64 * 1024 * 1024 });
        expect(run.status, `transcode ${row.name}: ${run.stderr}`).toBe(0);
        expect(run.stdout.length, `output bytes ${row.name}`).toBeGreaterThan(0);

        // 3. probe the far end — it must decode as audio codec B (the dest), not A
        const out = join(dir, `${row.source}_to_${row.target}.bin`);
        writeFileSync(out, run.stdout);
        const probe = spawnSync("ffprobe", [
          "-hide_banner", "-v", "error", "-select_streams", "a:0",
          "-show_entries", "stream=codec_name", "-of", "csv=p=0", out,
        ]);
        expect(probe.status, `probe ${row.name}: ${probe.stderr}`).toBe(0);
        expect(probe.stdout.toString().trim(), row.name).toBe(row.target);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
