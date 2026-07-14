// #151 (#145-video D) — LIVE PROOF that WAVE can PULL a full-motion video track directly off the CF
// Realtime SFU (bypassing CF's ~1fps jpeg WS adapter entirely). A werift recvonly PeerConnection subscribes
// to a track another session published, receives the VP8 RTP, and counts video frames (RTP marker bit) over
// a window → proves the delivered frame rate is the source's full rate (≈15fps), NOT CF's 1fps jpeg ceiling.
//
// This is the node-side seam the production recorder's video leg should use (RECORDER_TARGET=selfhost, #72):
// own SFU subscription → encoded frames → WebmMuxer (src/muxer/webm.ts) → R2. AV1 is a later optimization.
//
// Inputs (env): APP_ID, APP_SECRET (CF Realtime app — same app the canary published into; from Doppler),
//   PUB_SESSION (the publisher's SFU sessionId), TRACK (its trackName), RUN_MS.
// SFU sessionId is derivable from the canary trackName: `whip-<sfuSessionId>-<mid>`.
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";

const SFU_BASE = process.env.SFU_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const PUB_SESSION = process.env.PUB_SESSION;
const TRACK = process.env.TRACK;
const RUN_MS = Number(process.env.RUN_MS ?? 20000);
const VP8 = new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 });
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

const auth = { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" };

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), r()));
  });
}

async function main() {
  if (!APP_ID || !APP_SECRET || !PUB_SESSION || !TRACK) throw new Error("need APP_ID/APP_SECRET/PUB_SESSION/TRACK");
  const pc = new RTCPeerConnection({ codecs: { video: [VP8] } });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.connectionStateChange.subscribe((s) => log("sub-conn", { state: s }));

  // frame accounting: a video frame ends when the RTP marker bit is set
  let frames = 0, packets = 0, firstTs = 0, lastTs = 0;
  pc.onTrack.subscribe((track) => {
    log("sub-ontrack", { kind: track.kind });
    track.onReceiveRtp.subscribe((rtp) => {
      packets++;
      const now = Date.now();
      if (!firstTs) firstTs = now;
      lastTs = now;
      if (rtp.header.marker) frames++;
    });
  });

  // 1) create subscriber session with our recvonly offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);
  const sres = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/new`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } }),
  });
  if (!sres.ok) throw new Error(`sessions/new ${sres.status}: ${(await sres.text()).slice(0, 300)}`);
  const sjson = await sres.json();
  const subSession = sjson.sessionId;
  await pc.setRemoteDescription(sjson.sessionDescription);
  log("sub-session", { subSession });

  // 2) pull the remote track → SFU returns an offer requiring renegotiation
  const tres = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/${subSession}/tracks/new`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ tracks: [{ location: "remote", sessionId: PUB_SESSION, trackName: TRACK }] }),
  });
  if (!tres.ok) throw new Error(`tracks/new remote ${tres.status}: ${(await tres.text()).slice(0, 300)}`);
  const tjson = await tres.json();
  log("sub-track-new", { reneg: tjson.requiresImmediateRenegotiation, hasOffer: !!tjson.sessionDescription, err: tjson.errorDescription });

  // 3) renegotiate: answer the SFU's offer
  if (tjson.requiresImmediateRenegotiation && tjson.sessionDescription) {
    await pc.setRemoteDescription(tjson.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    const rres = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/${subSession}/renegotiate`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } }),
    });
    log("sub-renegotiate", { status: rres.status });
  }

  await new Promise((r) => setTimeout(r, RUN_MS));
  const secs = firstTs ? (lastTs - firstTs) / 1000 : 0;
  log("sub-result", { packets, frames, seconds: Number(secs.toFixed(2)), fps: secs ? Number((frames / secs).toFixed(2)) : 0 });
  await pc.close();
}

main().catch((e) => {
  log("fatal", { err: String(e?.stack ?? e).slice(0, 500) });
  process.exit(1);
});
