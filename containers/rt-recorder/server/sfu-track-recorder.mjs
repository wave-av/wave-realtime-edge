// rt-recorder (#151 / #145-video D) — the PROVEN self-host raw-SFU track recorder (werift, Node-only).
//
// PROVENANCE: this is harness/browser-pub-sfu-proof.mjs's `subscribe()` core, promoted to a production module
// (#152 proved it full-motion + decode-clean for VP8/VP9/H264 @30fps, lossPct:0). It PULLS a published SFU
// track over a recvonly WebRTC PeerConnection and feeds the RTP into werift's own `MediaRecorder` (jitter
// buffer + per-codec depacketizer + WebM/Matroska mux) → a finalized container file. The Worker (RoomDO)
// orchestrates and hands this process the SFU descriptor; werift needs a Node runtime so this NEVER runs in
// the Worker isolate — it is the self-host recorder seam (#72 Path B).
//
// TWO FIXES THAT MATTERED (systematic-debugging, banked in memory):
//   1. PLI keyframe request — on a mid-GOP join there is no keyframe, so inter-frames are undecodable. We
//      capture the incoming SSRC from the first RTP and pump `receiver.sendRtcpPLI(ssrc)` until a frame lands.
//   2. Use werift's MediaRecorder, do NOT hand-roll depacketize — its jitter buffer handles reorder. onTrack
//      fires TWICE (codec-less placeholder, then the real negotiated track); add the CODEC-BEARING one.
//
// CODEC ROUTING (#153): only VP8/VP9/H264/Opus are fed to werift MediaRecorder. AV1 HANGS werift 0.23.0 and
// H265 is unsupported → `routeCodec` returns "native-transcode" and we RETURN EARLY (never touch werift), so
// the caller falls back to the native ffmpeg/GPU recorder (#83/#88) instead of hanging. Honest degrade.

import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import { statSync } from "node:fs";
import { makeSfuClient } from "./sfu-rest.mjs";
import { CODEC_DESCRIPTORS, VIDEO_FB, routeCodec } from "./codec-select.mjs";

const log = (msg, f = {}) => console.log(JSON.stringify({ mod: "rt-recorder", msg, ...f }));

/** Build the werift subscriber codec params for a routed codec name (adds the rtcpFeedback the SFU honors). */
function codecParamsFor(name) {
  const d = CODEC_DESCRIPTORS[name];
  if (!d) return null;
  return new RTCRtpCodecParameters({ ...d, rtcpFeedback: VIDEO_FB });
}

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), r()));
  });
}

/**
 * Subscribe to a published SFU track and record it to `webmPath` for `runMs`. Returns a stats digest with the
 * output path (or a { routed:"native-transcode" } signal when the codec is not werift-safe — the caller then
 * records on the native path instead). NEVER hangs: `MediaRecorder.stop()` is raced against a timeout.
 *
 * @param {object} o
 * @param {string} o.appId          CF Realtime app id (hex32)
 * @param {string} o.appSecret      CF Realtime app secret (Bearer) — kept out of logs
 * @param {string} o.publisherSessionId  the SFU sessionId that published the track
 * @param {string} o.trackName      the published track name to pull
 * @param {string} o.codec          negotiated codec name (VP8|VP9|H264|AV1|H265|OPUS) — routes the path
 * @param {string} o.webmPath       local output path for the finalized container
 * @param {number} [o.runMs=15000]  record window
 * @param {string} [o.sfuBase]      SFU REST base (default CF prod)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.stopTimeoutMs=4000]  hard cap on MediaRecorder.stop() so a stuck mux can't hang teardown
 */
export async function subscribeAndRecord({
  appId,
  appSecret,
  publisherSessionId,
  trackName,
  codec,
  webmPath,
  runMs = 15000,
  sfuBase,
  fetchImpl,
  stopTimeoutMs = 4000,
}) {
  const route = routeCodec(codec);
  if (route.recorder !== "mediarecorder") {
    // AV1 hangs werift; H265 unsupported; unknown → honest-fail. Do NOT touch werift — signal the native path.
    log("codec-routed-native", { codec: route.name, reason: route.reason });
    return { routed: "native-transcode", codec: route.name, reason: route.reason, webmPath: null };
  }
  const params = codecParamsFor(route.name);
  if (!params) return { routed: "native-transcode", codec: route.name, reason: "no codec params", webmPath: null };

  const client = makeSfuClient({ fetchImpl, sfuBase, appId, appSecret });
  const pc = new RTCPeerConnection({ codecs: { video: [params] } });
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  const recorder = new MediaRecorder({ numOfTracks: 1, path: webmPath, disableLipSync: true, disableNtp: true });
  recorder.onError.subscribe((e) => log("rec-err", { err: String(e).slice(0, 160) }));

  let packets = 0, first = 0, last = 0, ssrc = null, addedToRecorder = false, gotFrame = false, plisSent = 0;
  let seqMin = Infinity, seqMax = -Infinity;
  const distinctTs = new Set();

  // PLI pump: force an IDR on a mid-GOP join until the mux gets its first frame (fix #1).
  const pliPump = setInterval(() => {
    if (ssrc == null || gotFrame) return;
    try {
      transceiver.receiver.sendRtcpPLI(ssrc);
      plisSent++;
    } catch (e) {
      log("pli-err", { err: String(e).slice(0, 100) });
    }
  }, 700);

  pc.onTrack.subscribe(async (track) => {
    const hasCodec = !!track.codec;
    // onTrack fires twice; the RTP flows on the codec-bearing track — that is the one to record (fix #2).
    if (!addedToRecorder && hasCodec) {
      addedToRecorder = true;
      await recorder.addTrack(track);
    }
    track.onReceiveRtp.subscribe((rtp) => {
      packets++;
      const n = Date.now();
      if (!first) first = n;
      last = n;
      gotFrame = true;
      if (ssrc == null) {
        ssrc = rtp.header.ssrc;
        try {
          transceiver.receiver.sendRtcpPLI(ssrc);
          plisSent++;
        } catch {
          /* best-effort first PLI */
        }
      }
      const sq = rtp.header.sequenceNumber;
      if (sq < seqMin) seqMin = sq;
      if (sq > seqMax) seqMax = sq;
      distinctTs.add(rtp.header.timestamp);
    });
  });

  // The proven three-call handshake (sfu-rest): offer → session → pull remote → answer renegotiation.
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);
  const session = await client.createSession(pc.localDescription.sdp);
  await pc.setRemoteDescription(session.sessionDescription);
  const pull = await client.pullRemoteTrack(session.sessionId, publisherSessionId, trackName);
  log("sub-track-new", { reneg: pull.requiresImmediateRenegotiation, hasOffer: !!pull.sessionDescription });
  if (pull.requiresImmediateRenegotiation && pull.sessionDescription) {
    await pc.setRemoteDescription(pull.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    const status = await client.renegotiate(session.sessionId, pc.localDescription.sdp);
    log("sub-renegotiate", { status });
  }

  await new Promise((r) => setTimeout(r, runMs));
  clearInterval(pliPump);

  // Hang-proof stop: a stuck depacketizer must never wedge teardown (banked AV1 lesson applied defensively).
  await Promise.race([recorder.stop(), new Promise((r) => setTimeout(r, stopTimeoutMs))]);
  try {
    await pc.close();
  } catch {
    /* best-effort */
  }

  const secs = first && last > first ? (last - first) / 1000 : 0;
  const span = seqMax >= seqMin ? seqMax - seqMin + 1 : 0;
  const lossPct = span > 0 ? Number((((span - packets) / span) * 100).toFixed(2)) : 0;
  let bytes = 0;
  try {
    bytes = statSync(webmPath).size;
  } catch {
    /* no file → 0 bytes (recorded nothing) */
  }
  const stats = {
    codec: route.name,
    packets,
    seconds: Number(secs.toFixed(2)),
    sourceFps: secs > 0 ? Number((distinctTs.size / secs).toFixed(2)) : 0,
    lossPct,
    plisSent,
    bytes,
    recordedFrame: gotFrame,
  };
  log("sub-done", stats);
  return { routed: "mediarecorder", codec: route.name, webmPath: bytes > 0 ? webmPath : null, stats };
}
