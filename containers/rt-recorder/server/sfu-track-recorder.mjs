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
// CODEC ROUTING (#153/#154): VP8/VP9/H264/Opus are fed to werift MediaRecorder (proven). AV1 HANGS werift's
// MediaRecorder *mux* (#153) — but its low-level RTP *receiver* + `AV1RtpPayload` depacketizer do NOT hang, so
// AV1 takes the #154 bridge: werift recvonly receive → depacketize (Av1FrameAssembler) → OBU temporal units →
// IVF (Av1IvfWriter) → native-transcode (ffmpeg) → WebM. H265 has NO werift depacketizer at all → honest-fail
// (the caller records it on the native ffmpeg/GPU path, #83/#88). Never a hang, never a silent wrong-codec mux.

import { RTCPeerConnection, RTCRtpCodecParameters, AV1RtpPayload } from "werift";
import { MediaRecorder } from "werift/nonstandard";
import { statSync, writeFileSync } from "node:fs";
import { makeSfuClient } from "./sfu-rest.mjs";
import { CODEC_DESCRIPTORS, VIDEO_FB, routeCodec } from "./codec-select.mjs";
import { Av1FrameAssembler } from "./av1-depacketize.mjs";
import { Av1IvfWriter } from "./av1-ivf.mjs";

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
 * The proven three-call CF SFU subscribe handshake: offer → new session → pull remote track → answer the
 * renegotiation offer. Shared by the werift-MediaRecorder path and the #154 AV1-depacketize path.
 */
async function doHandshake(pc, client, publisherSessionId, trackName) {
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
  width,
  height,
}) {
  const route = routeCodec(codec);
  if (route.name === "AV1") {
    // #154 bridge: werift's RTP receiver + AV1 depacketizer do not hang (only its MediaRecorder mux does).
    return recordAv1ToIvf({ appId, appSecret, publisherSessionId, trackName, ivfBasePath: webmPath, runMs, sfuBase, fetchImpl, stopTimeoutMs, width, height });
  }
  if (route.recorder !== "mediarecorder") {
    // H265/HEVC have no werift depacketizer; unknown → honest-fail. The caller records on the native path.
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

  await doHandshake(pc, client, publisherSessionId, trackName);

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

/**
 * #154 AV1 bridge: subscribe to a published AV1 SFU track over a werift recvonly PC, depacketize its RTP with
 * `AV1RtpPayload` into OBU temporal units (this path NEVER touches werift's MediaRecorder, which hangs on AV1),
 * write those TUs into an IVF file, and return `nativeInput` so the driver rewraps it to WebM via ffmpeg.
 *
 * Geometry: the IVF header needs a non-zero width/height. The negotiated session knows the resolution, so the
 * caller MUST supply `width`/`height` (honest-fail if absent — no 0x0 placeholder). ffmpeg re-derives the true
 * geometry from the in-band OBU_SEQUENCE_HEADER downstream regardless, so the IVF value is advisory.
 *
 * @returns {Promise<{routed:"native-transcode", codec:"AV1", nativeInput?:{input:string}, reason?:string, stats:object}>}
 */
async function recordAv1ToIvf({ appId, appSecret, publisherSessionId, trackName, ivfBasePath, runMs, sfuBase, fetchImpl, stopTimeoutMs, width, height }) {
  if (!(width > 0) || !(height > 0)) {
    // No geometry from the session descriptor → honest-fail rather than fabricate a 0x0/placeholder container.
    log("av1-no-geometry", { width, height });
    return { routed: "native-transcode", codec: "AV1", reason: "AV1 bridge needs session width/height", stats: { frames: 0 } };
  }
  const ivfPath = `${ivfBasePath}.av1.ivf`;
  const params = codecParamsFor("AV1");
  const client = makeSfuClient({ fetchImpl, sfuBase, appId, appSecret });
  const pc = new RTCPeerConnection({ codecs: { video: [params] } });
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });

  const assembler = new Av1FrameAssembler({
    deSerialize: AV1RtpPayload.deSerialize,
    getFrame: AV1RtpPayload.getFrame,
  });
  const writer = new Av1IvfWriter({ width, height, timebaseDen: 90000 });

  let packets = 0, first = 0, last = 0, ssrc = null, gotFrame = false, plisSent = 0, baseTs = null;

  // PLI pump: on a mid-GOP join there is no keyframe → force an IDR until the first TU lands (banked fix #1).
  const pliPump = setInterval(() => {
    if (ssrc == null || gotFrame) return;
    try {
      transceiver.receiver.sendRtcpPLI(ssrc);
      plisSent++;
    } catch (e) {
      log("pli-err", { err: String(e).slice(0, 100) });
    }
  }, 700);

  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      packets++;
      const n = Date.now();
      if (!first) first = n;
      last = n;
      if (ssrc == null) {
        ssrc = rtp.header.ssrc;
        try {
          transceiver.receiver.sendRtcpPLI(ssrc);
          plisSent++;
        } catch {
          /* best-effort first PLI */
        }
      }
      // Marker bit closes the temporal unit; getFrame reassembles the OBUs → one AV1 frame.
      const frame = assembler.push(rtp.payload, AV1RtpPayload.isDetectedFinalPacketInSequence(rtp.header));
      if (frame) {
        gotFrame = true;
        if (baseTs == null) baseTs = rtp.header.timestamp;
        // IVF PTS in the 90kHz RTP timebase, relative to the first recorded frame.
        writer.write(frame, (rtp.header.timestamp - baseTs) >>> 0);
      }
    });
  });

  await doHandshake(pc, client, publisherSessionId, trackName);
  await new Promise((r) => setTimeout(r, runMs));
  clearInterval(pliPump);
  await Promise.race([pc.close().catch(() => {}), new Promise((r) => setTimeout(r, stopTimeoutMs))]);

  const ivf = writer.finalize();
  const secs = first && last > first ? (last - first) / 1000 : 0;
  const stats = {
    codec: "AV1",
    packets,
    frames: writer.frameCount,
    keyframes: assembler.keyframes,
    droppedPackets: assembler.dropped,
    seconds: Number(secs.toFixed(2)),
    plisSent,
    ivfBytes: ivf ? ivf.length : 0,
  };
  log("av1-done", stats);
  if (!ivf) {
    // Recorded nothing decodable (no keyframe / no frames) → honest signal, no empty IVF written.
    return { routed: "native-transcode", codec: "AV1", reason: "no AV1 frames assembled", stats };
  }
  writeFileSync(ivfPath, ivf);
  return { routed: "native-transcode", codec: "AV1", nativeInput: { input: ivfPath }, stats };
}
