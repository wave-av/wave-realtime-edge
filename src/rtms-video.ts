/**
 * Zoom RTMS video transcode (#88 M2 — video INGEST leg, behind WAVE_RTMS_VIDEO, default OFF).
 *
 * Zoom RTMS delivers MEDIA_DATA_VIDEO frames as base64 JPEG-encoded video stills in the same
 * `content.data` envelope the mock server uses for audio (see rtms-protocol.ts parseRtmsMessage).
 * This mirrors rtms-audio.ts's transcode, except video needs no resample: Zoom emits complete
 * still frames, not a continuous sample stream, so the mapping is a validated pass-through.
 *
 * The target codec name ("jpeg") is not invented here — it mirrors the JPEG convention this repo
 * ALREADY uses for raw SFU video on the EGRESS/recording side (`outputCodec:"jpeg"`,
 * encoders/container-adapter.ts, RT-R10 #72: "the SFU pushes video as outputCodec:'jpeg' frames").
 * For INGEST (`location:"local"`, the direction this module feeds — see agent-ingest-adapter.ts)
 * the adapter contract is symmetric: a local track with `inputCodec:"jpeg"` publishes a new video
 * track sourced from the JPEG stills we send, exactly as `inputCodec:"pcm"` does for audio.
 *
 * ── HONEST SCOPING (mirrors rtms-audio.ts's own note, before its #145 live-spike proof) ──────────
 * VERIFIED here (unit tests): one MEDIA_DATA_VIDEO frame's JPEG payload passes through unchanged to
 * the ingest send path, and a missing/non-JPEG payload is rejected before it ever reaches a socket.
 * UNVERIFIED until a live Zoom meeting: that Zoom's real `video_params` actually negotiate JPG (Zoom's
 * RTMS video codec is configurable, not fixed), and that CF's websocket media-transport adapter
 * genuinely accepts `inputCodec:"jpeg"` on a `location:"local"` track — the ingest adapter contract
 * is flagged LIVE-SPIKE in agent-ingest-adapter.ts even for the already-proven PCM case.
 *
 * This module gets you to "SFU video track push" ONLY. End-to-end video RECORDING/PERCEPTION
 * downstream of that push is a SEPARATE, already-known CF-platform block (issue #147: the WS
 * media-adapter recorder-pull path is blocked for video/jpeg output) and is NOT proven or claimed
 * by this module or by WAVE_RTMS_VIDEO.
 *
 * No I/O, pure + unit-testable — mirrors rtms-audio.ts.
 */

export class RtmsVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RtmsVideoError";
  }
}

/** JPEG Start-Of-Image marker — the first two bytes of every valid JPEG stream. */
const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;

/** True when `bytes` starts with the JPEG SOI marker (0xFFD8) — a cheap, allocation-free sanity check. */
export function isLikelyJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === JPEG_SOI_0 && bytes[1] === JPEG_SOI_1;
}

/**
 * Zoom RTMS → SFU: one MEDIA_DATA_VIDEO frame's JPEG bytes → the exact bytes the SFU video ingest
 * track (`inputCodec:"jpeg"`) expects. Zoom's RTMS video frame IS already JPEG-encoded (see module
 * header), so this is a validated pass-through — the video analogue of `rtmsAudioToSfuPcm`'s
 * resample, minus the resample (video is stills, not a sample stream to retime).
 *
 * Throws RtmsVideoError on an empty or non-JPEG payload. Callers (rtms-bridge-core.ts `pumpVideo`)
 * MUST catch and drop, never throw up the socket path — media safety > one dropped frame, exactly
 * mirroring `pumpAudio`'s fail-safe contract.
 */
export function rtmsVideoToSfuJpeg(rtmsVideoBytes: Uint8Array): Uint8Array {
  if (rtmsVideoBytes.length === 0) throw new RtmsVideoError("empty video frame");
  if (!isLikelyJpeg(rtmsVideoBytes)) throw new RtmsVideoError("video frame is not JPEG-encoded (missing SOI marker)");
  return rtmsVideoBytes;
}
