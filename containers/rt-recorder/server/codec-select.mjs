// rt-recorder (#151 / #145-video D) — PURE codec routing for the self-host raw-SFU recorder.
//
// WHY THIS EXISTS: the recorder PULLS a published SFU track over WebRTC (werift, Node-only) and feeds the
// RTP into werift's own `MediaRecorder` (jitter buffer + per-codec depacketizer + WebM/Matroska mux). That
// path is PROVEN full-motion + decode-clean for VP8/VP9/H264 (+ Opus audio) — see harness/browser-pub-sfu-
// proof.mjs receipts (#152). But it is NOT codec-complete (#153): werift 0.23.0 `MediaRecorder` HANGS on a
// browser AV1 RTP stream (event-loop block on the AV1 OBU depacketizer), and H265 is not in werift's
// depacketizer table at all. So the recorder must ROUTE by codec: the proven set → werift MediaRecorder;
// AV1/H265 → the native-transcode fallback (record the negotiated codec on the container's ffmpeg / GPU
// path, #83/#88) rather than hanging the werift recorder. This module is the pure decision — no werift
// import, no I/O — so it is unit-testable in isolation and the integration glue stays thin.
//
// Everything here is PURE DATA + PURE FUNCTIONS. `sfu-track-recorder.mjs` maps CODEC_DESCRIPTORS into real
// `RTCRtpCodecParameters` at the werift seam; keeping the descriptors as plain objects here keeps the heavy
// node-only werift import out of the test path.

/** rtcpFeedback the subscriber advertises so CF/browser honor NACK + PLI (keyframe-on-join) + congestion. */
export const VIDEO_FB = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "goog-remb" },
  { type: "transport-cc" },
  { type: "ccm", parameter: "fir" },
];

/**
 * Subscriber codec descriptors — MUST match the browser/publisher codec so the SFU forwards the track
 * unchanged (the SFU does not transcode; a mismatched offer yields no forwarded media). Payload types mirror
 * the proven harness. H264 carries the constrained-baseline params CF/browsers negotiate. These are plain
 * data; the werift seam constructs `RTCRtpCodecParameters` from them.
 */
export const CODEC_DESCRIPTORS = {
  VP8: { mimeType: "video/VP8", clockRate: 90000, payloadType: 96 },
  VP9: { mimeType: "video/VP9", clockRate: 90000, payloadType: 98 },
  H264: {
    mimeType: "video/H264",
    clockRate: 90000,
    payloadType: 102,
    parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  },
  AV1: { mimeType: "video/AV1", clockRate: 90000, payloadType: 45 },
  OPUS: { mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 },
};

/**
 * How the recorder handles each codec:
 *   • "mediarecorder"  — feed the pulled track into werift MediaRecorder (PROVEN: VP8/VP9/H264/Opus).
 *   • "native-transcode" — werift MediaRecorder is unsafe (AV1 hangs) or unsupported (H265) → record on the
 *     native ffmpeg/GPU path (#83 AV1-default, #88 av1_nvenc) or normalize downstream; do NOT feed werift.
 * `reason` documents WHY, so a log line / test asserts the honest degrade (never a silent substitution).
 */
const ROUTING = {
  VP8: { recorder: "mediarecorder", reason: "proven full-motion + decode-clean (#152)" },
  VP9: { recorder: "mediarecorder", reason: "proven full-motion + decode-clean (#152)" },
  H264: { recorder: "mediarecorder", reason: "proven; werift writes Matroska V_MPEG4/ISO/AVC (#152)" },
  OPUS: { recorder: "mediarecorder", reason: "audio proven live (#145 audio leg)" },
  AV1: {
    recorder: "native-transcode",
    reason: "werift 0.23.0 MediaRecorder HANGS on browser AV1 RTP; route to native/GPU (#83/#88)",
  },
  H265: {
    recorder: "native-transcode",
    reason: "not in werift depacketizer table (browsers don't do H265 WebRTC); native-record or normalize",
  },
  HEVC: {
    recorder: "native-transcode",
    reason: "alias of H265 — native-record or normalize",
  },
};

/** Normalize a codec name to the registry key (uppercase, strip video/ audio/ prefix, HEVC→H265 alias off). */
export function normalizeCodecName(name) {
  const n = String(name || "").trim().toUpperCase().replace(/^(VIDEO|AUDIO)\//, "");
  return n;
}

/**
 * Route a codec to its recorder path. Unknown codecs are HONEST-FAILED (supported:false) rather than guessed
 * — the caller logs loudly and records nothing for that track (config-no-silent-noop), never a wrong-codec mux.
 * @returns {{ name:string, recorder:"mediarecorder"|"native-transcode"|null, supported:boolean, reason:string }}
 */
export function routeCodec(name) {
  const key = normalizeCodecName(name);
  const r = ROUTING[key];
  if (!r) return { name: key, recorder: null, supported: false, reason: `unknown codec ${key}` };
  return { name: key, recorder: r.recorder, supported: true, reason: r.reason };
}

/** True iff this codec is safe to feed into the werift MediaRecorder (the proven pull path). */
export function isMediaRecorderSafe(name) {
  return routeCodec(name).recorder === "mediarecorder";
}

/** Reverse map: negotiated SDP payloadType → codec name (used to pick the codec from a real negotiated offer). */
export function codecFromPayloadType(pt) {
  const n = Number(pt);
  for (const [name, d] of Object.entries(CODEC_DESCRIPTORS)) {
    if (d.payloadType === n) return name;
  }
  return null;
}
