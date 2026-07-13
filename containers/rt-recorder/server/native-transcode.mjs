// native-transcode.mjs — #153 the native ffmpeg fallback for codecs the werift MediaRecorder cannot mux.
//
// WHY: werift 0.23.0's MediaRecorder HANGS on AV1 RTP and has no H265 depacketizer (browsers don't carry H265
// over WebRTC anyway). codec-select routes those to "native-transcode" instead of hanging (honest degrade).
// This module is that fallback: it shells ffmpeg (bundled in the rt-recorder image) to turn the pulled/ingested
// stream into the ONE canonical WebM object — the SAME SKIP-tier container the werift path produces, so the
// recorder's output contract is codec-COMPLETE regardless of the input codec.
//
// STRATEGY (per codec):
//   • AV1  → REWRAP into WebM (`-c:v copy`): AV1 lives in Matroska/WebM natively, so no re-encode — lossless,
//            fast, and cheap. The werift limitation was MUXING AV1 RTP, not AV1-in-WebM; ffmpeg muxes it fine.
//   • H265 → RE-ENCODE to AV1 in WebM: WebM cannot carry HEVC cleanly (no interoperable Matroska HEVC mapping),
//            so normalize to AV1 (the #83 AV1-default archival profile). One transcode, decode-clean output.
//   • VP8/VP9/H264 → REWRAP (`-c:v copy`): defensive — if a werift-safe codec is ever routed here (e.g. a
//            werift depacketizer regression), we still capture it losslessly rather than drop the recording.
//
// INPUT is an ffmpeg input spec + optional pre-`-i` args, so the SAME function serves every source shape:
//   • a file / fMP4 path (proven here with real AV1 + H265 clips),
//   • `pipe:0` for a stdin byte stream,
//   • an SDP (`-protocol_whitelist … -i stream.sdp`) for the live werift→UDP→ffmpeg RTP bridge (#153 Stage 2).
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

/** Per-codec native strategy: the ffmpeg output-codec args + the resulting stored codec + why (honest degrade). */
const NATIVE_STRATEGY = {
	AV1: { args: ["-c:v", "copy"], out: "av1", why: "AV1 rewraps into WebM losslessly (no re-encode)" },
	H265: {
		args: ["-c:v", "libsvtav1", "-preset", "8", "-crf", "32", "-pix_fmt", "yuv420p"],
		out: "av1",
		why: "WebM has no interoperable HEVC mapping → normalize to AV1 (#83 AV1-default)",
	},
	HEVC: {
		args: ["-c:v", "libsvtav1", "-preset", "8", "-crf", "32", "-pix_fmt", "yuv420p"],
		out: "av1",
		why: "HEVC alias of H265 → normalize to AV1",
	},
	VP8: { args: ["-c:v", "copy"], out: "vp8", why: "defensive rewrap — werift-safe codec routed native" },
	VP9: { args: ["-c:v", "copy"], out: "vp9", why: "defensive rewrap — werift-safe codec routed native" },
	H264: { args: ["-c:v", "copy"], out: "h264", why: "defensive rewrap — werift-safe codec routed native" },
};

/** Normalize a codec name to the strategy key (uppercase, strip a video/ prefix). */
function normalize(codec) {
	return String(codec || "").trim().toUpperCase().replace(/^VIDEO\//, "");
}

/**
 * Resolve the native ffmpeg strategy for a codec. Returns null for an unknown codec (the caller HONEST-FAILS —
 * records nothing rather than guess a muxing, config-no-silent-noop).
 * @returns {{ args:string[], out:string, why:string }|null}
 */
export function nativeStrategyFor(codec) {
	return NATIVE_STRATEGY[normalize(codec)] ?? null;
}

/**
 * Transcode/rewrap a source into the canonical WebM object via ffmpeg. Resolves { outPath, bytes, container,
 * codec } on a clean exit that wrote a non-empty file; REJECTS on a non-zero ffmpeg exit, a spawn error, an
 * unknown codec, or a zero-byte output (never a silent empty recording — this stream IS the recording).
 *
 * @param {object} o
 * @param {string}   o.input       ffmpeg input spec (file path | "pipe:0" | an .sdp path)
 * @param {string}   o.codec       negotiated codec name (AV1|H265|HEVC|VP8|VP9|H264) — picks the strategy
 * @param {string}   o.outPath     where to write the WebM
 * @param {string[]} [o.inputArgs] extra args BEFORE `-i` (e.g. `-protocol_whitelist`, `-f`, stdin plumbing)
 * @param {import("node:stream").Readable} [o.stdin] a byte stream to pipe to ffmpeg stdin (with input "pipe:0")
 * @param {string}   [o.ffmpegPath] ffmpeg binary (default "ffmpeg")
 * @param {number}   [o.timeoutMs]  kill ffmpeg after this many ms (0 = no timeout)
 * @param {(evt:string, data?:object)=>void} [o.log]
 * @returns {Promise<{ outPath:string, bytes:number, container:"webm", codec:string }>}
 */
export async function transcodeToWebm({ input, codec, outPath, inputArgs = [], stdin, ffmpegPath = "ffmpeg", timeoutMs = 0, log = () => {} }) {
	const strat = nativeStrategyFor(codec);
	if (!strat) throw new Error(`native-transcode: no strategy for codec ${codec} — refusing to guess a muxing`);
	const args = ["-hide_banner", "-v", "error", ...inputArgs, "-i", input, ...strat.args, "-f", "webm", "-y", outPath];
	log("native-transcode-start", { codec: normalize(codec), out: strat.out, why: strat.why });

	await new Promise((resolve, reject) => {
		const ff = spawn(ffmpegPath, args, { stdio: [stdin ? "pipe" : "ignore", "ignore", "pipe"] });
		let stderr = "";
		let timer = null;
		if (timeoutMs > 0) timer = setTimeout(() => ff.kill("SIGKILL"), timeoutMs);
		ff.stderr.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > 4096) stderr = stderr.slice(-4096); // bound retained tail
		});
		ff.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(new Error(`native-transcode: ffmpeg spawn failed: ${e.message}`));
		});
		ff.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`native-transcode: ffmpeg exit ${code}${stderr ? ` — ${stderr.trim().slice(-300)}` : ""}`));
		});
		if (stdin) {
			stdin.on("error", (e) => reject(new Error(`native-transcode: stdin error: ${e.message}`)));
			stdin.pipe(ff.stdin);
		}
	});

	const { size } = await stat(outPath);
	if (size <= 0) throw new Error("native-transcode: ffmpeg produced a zero-byte output — refusing an empty recording");
	log("native-transcode-done", { bytes: size, codec: strat.out });
	return { outPath, bytes: size, container: "webm", codec: strat.out };
}
