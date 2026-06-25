// #81 harness — WebRTC subscriber: pull the agent's published track back out of the SFU and prove the agent
// actually SPEAKS (the ingest half of the loop). The AgentSessionDO publishes `agent-<id>` as a LOCAL track on
// the PARTICIPANT's session (see src/agent-session.ts: ingest adapter location:"local", sessionId:
// participantSessionId, trackName: agentTrackName). So we subscribe to it as a REMOTE track keyed by
// (participantSessionId, agentTrackName) from a fresh recvonly session and count the RTP flowing back.
//
// Leg 2 proof = RTP arrives on agent-<id> (agent is speaking) + time-to-first-packet (a barge-in/latency proxy).
// Leg 3 (decode → STT the reply → content-integrity + meter) builds on the captured packets.

import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from "werift";

const OPUS_PT = 111;
const OPUS = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: OPUS_PT });

function waitIce(pc, ms = 3000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), resolve()));
  });
}

/**
 * Subscribe to `agentTrackName` published on `remoteSessionId`. Returns
 * { pc, connected(), rtpRecv(), firstRtpMs(), payloads(), stop() }.
 * @param log ndjson logger (msg, fields)
 */
export async function createSubscriber({ sfuBase, appId, appSecret, remoteSessionId, agentTrackName, log = () => {} }) {
  const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
  // recvonly: we only want to RECEIVE the agent track.
  const transceiver = pc.addTransceiver("audio", { direction: "recvonly" });
  pc.connectionStateChange.subscribe((s) => log("sub-conn", { state: s }));

  let rtpCount = 0;
  let firstRtpAt = 0;
  const payloads = [];
  const onTrack = (track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      if (firstRtpAt === 0) { firstRtpAt = Date.now(); log("sub-first-rtp", {}); }
      rtpCount++;
      // Keep the raw Opus payloads (bounded) for Leg 3 decode/STT — never the whole stream.
      if (payloads.length < 2000 && rtp.payload?.length) payloads.push(rtp.payload);
      if (rtpCount % 100 === 0) log("sub-rtp", { recv: rtpCount });
    });
  };
  pc.onTrack.subscribe((track) => onTrack(track));
  if (transceiver.receiver?.track) onTrack(transceiver.receiver.track);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  // Fresh subscriber session with our recvonly offer.
  const sres = await fetch(`${sfuBase}/apps/${appId}/sessions/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } }),
  });
  if (!sres.ok) throw new Error(`subscriber sessions/new ${sres.status}: ${(await sres.text()).slice(0, 300)}`);
  const sjson = await sres.json();
  const sessionId = sjson.sessionId;
  await pc.setRemoteDescription(sjson.sessionDescription);
  log("sub-session", { sessionId });

  // Pull the agent's track as a REMOTE track. CF may require an immediate renegotiation (it returns an offer
  // we must answer) when adding a remote track that changes the transport's m-lines.
  const tres = await fetch(`${sfuBase}/apps/${appId}/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: [{ location: "remote", sessionId: remoteSessionId, trackName: agentTrackName, mid: transceiver.mid }] }),
  });
  if (!tres.ok) throw new Error(`subscriber tracks/new ${tres.status}: ${(await tres.text()).slice(0, 300)}`);
  const tjson = await tres.json();
  log("sub-track-pulled", { trackName: agentTrackName, renegotiate: !!tjson.requiresImmediateRenegotiation });

  if (tjson.requiresImmediateRenegotiation && tjson.sessionDescription) {
    await pc.setRemoteDescription(tjson.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    const rres = await fetch(`${sfuBase}/apps/${appId}/sessions/${sessionId}/renegotiate`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } }),
    });
    if (!rres.ok) throw new Error(`subscriber renegotiate ${rres.status}: ${(await rres.text()).slice(0, 300)}`);
    log("sub-renegotiated", {});
  }

  const connected = () =>
    new Promise((resolve) => {
      if (pc.connectionState === "connected") return resolve(true);
      const t = setTimeout(() => resolve(false), 12000);
      pc.connectionStateChange.subscribe((s) => {
        if (s === "connected") (clearTimeout(t), resolve(true));
        if (s === "failed") (clearTimeout(t), resolve(false));
      });
    });

  const stop = async () => { try { await pc.close(); } catch {} };

  return {
    pc, sessionId, connected, stop,
    rtpRecv: () => rtpCount,
    firstRtpMs: () => firstRtpAt,
    payloads: () => payloads,
  };
}
