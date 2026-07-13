// #153 — native-transcode fallback: the ffmpeg path for codecs werift's MediaRecorder can't mux (AV1 hangs,
// H265 unsupported). Pure routing tests always run; an ffmpeg INTEGRATION test proves the real transcode when
// ffmpeg is present (locally + in the rt-recorder image) and SKIPS cleanly on a bare runner without ffmpeg.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStrategyFor, transcodeToWebm } from "../server/native-transcode.mjs";

const haveFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;

describe("nativeStrategyFor — per-codec native routing (pure)", () => {
	it("AV1 rewraps losslessly (copy → av1-in-WebM)", () => {
		expect(nativeStrategyFor("AV1")).toMatchObject({ args: ["-c:v", "copy"], out: "av1" });
		expect(nativeStrategyFor("video/AV1")).toMatchObject({ out: "av1" }); // prefix-normalized
	});
	it("H265/HEVC normalize to AV1 (WebM has no interoperable HEVC mapping)", () => {
		expect(nativeStrategyFor("H265")).toMatchObject({ out: "av1" });
		expect(nativeStrategyFor("HEVC")).toMatchObject({ out: "av1" });
		expect(nativeStrategyFor("H265").args).toContain("libsvtav1");
	});
	it("werift-safe codecs get a defensive lossless rewrap (if ever routed native)", () => {
		for (const c of ["VP8", "VP9", "H264"]) expect(nativeStrategyFor(c)).toMatchObject({ args: ["-c:v", "copy"] });
	});
	it("an unknown codec has NO strategy (caller honest-fails, never guesses a muxing)", () => {
		expect(nativeStrategyFor("THEORA")).toBeNull();
		expect(nativeStrategyFor("")).toBeNull();
	});
	it("transcodeToWebm rejects an unknown codec rather than guess", async () => {
		await expect(transcodeToWebm({ input: "x", codec: "THEORA", outPath: "y" })).rejects.toThrow(/no strategy/);
	});
});

describe.skipIf(!haveFfmpeg)("transcodeToWebm — real AV1 + H265 → WebM (ffmpeg integration)", () => {
	const dir = mkdtempSync(join(tmpdir(), "rt-native-"));
	// Encode a tiny real-motion source once per codec (testsrc2 has motion), then transcode it through the fallback.
	function makeSource(vcodec, extraArgs, out) {
		const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=1", "-c:v", vcodec, ...extraArgs, "-y", out]);
		expect(r.status).toBe(0);
	}
	function probeCodec(f) {
		const r = spawnSync("ffprobe", ["-hide_banner", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", f]);
		return r.stdout.toString().trim();
	}

	it("AV1 source → WebM rewrap: av1, decode-clean, non-empty", async () => {
		const src = join(dir, "a.mp4");
		const out = join(dir, "a.webm");
		makeSource("libsvtav1", ["-preset", "10", "-b:v", "500k"], src);
		const res = await transcodeToWebm({ input: src, codec: "AV1", outPath: out });
		expect(res).toMatchObject({ container: "webm", codec: "av1" });
		expect(res.bytes).toBeGreaterThan(0);
		expect(probeCodec(out)).toBe("av1");
		// decode-to-null must exit 0 (the WebM is real, not a broken container)
		expect(spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", out, "-f", "null", "-"]).status).toBe(0);
	});

	it("H265 source → normalized to AV1-in-WebM: av1, decode-clean, non-empty", async () => {
		const src = join(dir, "h.mp4");
		const out = join(dir, "h.webm");
		makeSource("libx265", ["-preset", "ultrafast"], src);
		const res = await transcodeToWebm({ input: src, codec: "H265", outPath: out });
		expect(res.codec).toBe("av1");
		expect((await stat(out)).size).toBeGreaterThan(0);
		expect(probeCodec(out)).toBe("av1"); // HEVC normalized to AV1
		expect(spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", out, "-f", "null", "-"]).status).toBe(0);
	});
});
