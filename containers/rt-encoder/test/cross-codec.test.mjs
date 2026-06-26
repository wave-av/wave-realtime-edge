// Cross-codec NEGOTIATION matrix (#86 capability-negotiation — "any flavor each end"). The selector
// (select.test.mjs) proves we pick the right ENCODER for a dest codec; this proves the full per-leg
// transcode path: a SOURCE in codec A negotiated to a DEST in codec B (A ≠ B) produces a correct ffmpeg
// argv (demuxer-in for A, encoder-out for B, right container) AND — where a real ffmpeg is present —
// actually renders a sample that DECODES as codec B at the far end.
//
// Two tiers:
//   • Tier 1 (always, CI-safe, NO ffmpeg): pure argv assertions over buildCommand for each pair, plus the
//     honest-fail guards (encoded source needs a target; unknown source/codec throws).
//   • Tier 2 (gated on a real ffmpeg in PATH): generate a tiny encoded fixture for codec A, pipe it
//     through buildCommand's exact argv, and ffprobe the output to assert codec_name === B. This is the
//     "render at the far end (recorded sample)" done-check, byte-for-byte the proven manual matrix.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand } from "../server/command.mjs";

// A software-only host set (CF Containers reality): exactly the encoders the matrix needs, no hardware.
const SW = new Set(["libvpx", "libvpx-vp9", "libsvtav1", "libx264", "libopus", "aac"]);

// The cross-codec matrix. Each row: a SOURCE codec ≠ DEST codec, with the expected negotiated argv shape
// and (for Tier 2) how to synthesize the source fixture + which encoder ffmpeg should report on output.
const MATRIX = [
  {
    name: "H264 → VP8 (video, mp4-family src → webm-family dest)",
    source: "h264", target: "vp8",
    expectDemux: ["-f", "h264", "-i", "-"], expectEncoder: "libvpx", expectContainer: "webm",
    fixtureArgs: ["-f", "lavfi", "-i", "testsrc=size=128x128:rate=10:duration=1", "-c:v", "libx264", "-f", "h264", "-"],
  },
  {
    name: "VP8 → AV1 (video, webm-family src → av1 dest)",
    source: "vp8", target: "av1",
    expectDemux: ["-f", "ivf", "-i", "-"], expectEncoder: "libsvtav1", expectContainer: "webm",
    fixtureArgs: ["-f", "lavfi", "-i", "testsrc=size=128x128:rate=10:duration=1", "-c:v", "libvpx", "-f", "ivf", "-"],
  },
  {
    name: "Opus → AAC (audio, ogg src → mp4 dest)",
    source: "opus", target: "aac",
    expectDemux: ["-f", "ogg", "-i", "-"], expectEncoder: "aac", expectContainer: "mp4",
    fixtureArgs: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "ogg", "-"],
  },
];

// ── Tier 1: argv negotiation (CI-safe) ─────────────────────────────────────────────────────────────
describe("#86 cross-codec negotiation — argv (source ≠ dest)", () => {
  for (const row of MATRIX) {
    it(`${row.name} → builds demux-in + encoder-out`, () => {
      const cmd = buildCommand({ sourceCodec: row.source, targetCodec: row.target, available: SW });
      expect(cmd.source).toBe(row.source);
      expect(cmd.target).toBe(row.target);
      expect(cmd.encoder).toBe(row.expectEncoder);
      expect(cmd.container).toBe(row.expectContainer);
      // the source demuxer prefix must appear verbatim (allowlisted, no injection)
      const joined = cmd.args.join(" ");
      expect(joined).toContain(row.expectDemux.join(" "));
      // the chosen encoder must be wired to the right media flag
      const flag = row.source === "opus" || row.source === "aac" ? "-c:a" : "-c:v";
      expect(joined).toContain(`${flag} ${row.expectEncoder}`);
    });
  }

  it("encoded source with NO target → throws (never silently re-emits source codec)", () => {
    expect(() => buildCommand({ sourceCodec: "h264" })).toThrow(/requires an explicit target codec/);
  });

  it("unknown source codec → throws with the allowlist", () => {
    expect(() => buildCommand({ sourceCodec: "theora", targetCodec: "vp8" })).toThrow(/unsupported source codec/);
  });

  it("raw jpeg/pcm default path is unchanged (no target) — additive, no drift", () => {
    const v = buildCommand({ sourceCodec: "jpeg" });
    expect(v.target).toBe("vp8");
    expect(v.encoder).toBe("libvpx");
    const a = buildCommand({ sourceCodec: "pcm" });
    expect(a.target).toBe("opus");
    expect(a.encoder).toBe("libopus");
  });
});

// ── Tier 2: real render (gated on ffmpeg presence) ─────────────────────────────────────────────────
const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-hide_banner", "-version"]).status === 0;
const liveIt = hasFfmpeg && hasFfprobe ? it : it.skip;

describe("#86 cross-codec negotiation — real render decodes as dest codec", () => {
  liveIt("renders {H264→VP8, VP8→AV1, Opus→AAC} and each decodes at the far end", () => {
    const dir = mkdtempSync(join(tmpdir(), "xc-86-"));
    try {
      for (const row of MATRIX) {
        // 1. synthesize an encoded SOURCE fixture in codec A (stdout → buffer)
        const fix = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...row.fixtureArgs], {
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(fix.status, `fixture ${row.source}`).toBe(0);
        expect(fix.stdout.length).toBeGreaterThan(0);

        // 2. drive the SAME argv buildCommand produced — the production negotiation path
        const cmd = buildCommand({ sourceCodec: row.source, targetCodec: row.target, available: SW });
        const run = spawnSync("ffmpeg", cmd.args, { input: fix.stdout, maxBuffer: 64 * 1024 * 1024 });
        expect(run.status, `transcode ${row.name}: ${run.stderr}`).toBe(0);
        expect(run.stdout.length, `output bytes ${row.name}`).toBeGreaterThan(0);

        // 3. probe the far end — it must decode as codec B (the dest), not A
        const out = join(dir, `${row.source}_to_${row.target}.bin`);
        writeFileSync(out, run.stdout);
        const stream = row.source === "opus" || row.source === "aac" ? "a:0" : "v:0";
        const probe = spawnSync("ffprobe", [
          "-hide_banner", "-v", "error", "-select_streams", stream,
          "-show_entries", "stream=codec_name", "-of", "csv=p=0", out,
        ]);
        expect(probe.status, `probe ${row.name}: ${probe.stderr}`).toBe(0);
        expect(probe.stdout.toString().trim(), row.name).toBe(row.target);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
