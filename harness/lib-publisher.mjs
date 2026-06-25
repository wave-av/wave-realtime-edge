// #81 harness — WebRTC publisher: stream a real audio fixture into a CF Realtime SFU session as a participant.
//
// Pipeline: ffmpeg (-re realtime, loop) encodes the WAV fixture → Opus → RTP → UDP; we read the RTP off a
// dgram socket and writeRtp() it onto a werift sendonly audio track on a PeerConnection negotiated with the
// SFU. The SFU then has a REAL flowing participant track (sessionId + trackName) — exactly what the agent
// egress adapter subscribes to (and what was MISSING when bind→createEgress 503'd from a synthetic curl).

import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
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
 * Publish `wavPath` into a new SFU session. Returns { sessionId, trackName, pc, connected(), stop() }.
 * @param log ndjson logger (msg, fields)
 */
export async function createPublisher({ sfuBase, appId, appSecret, wavPath, trackName = "harness-mic", udpPort = 5004, loops = -1, log = () => {} }) {
  const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
  const track = new MediaStreamTrack({ kind: "audio" });
  const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
  pc.connectionStateChange.subscribe((s) => log("pub-conn", { state: s }));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  const sres = await fetch(`${sfuBase}/apps/${appId}/sessions/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } }),
  });
  if (!sres.ok) throw new Error(`publisher sessions/new ${sres.status}: ${(await sres.text()).slice(0, 300)}`);
  const sjson = await sres.json();
  const sessionId = sjson.sessionId;
  await pc.setRemoteDescription(sjson.sessionDescription);
  log("pub-session", { sessionId });

  const tres = await fetch(`${sfuBase}/apps/${appId}/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: [{ location: "local", mid: transceiver.mid, trackName }] }),
  });
  if (!tres.ok) throw new Error(`publisher tracks/new ${tres.status}: ${(await tres.text()).slice(0, 300)}`);
  log("pub-track", { trackName, mid: transceiver.mid });

  // ffmpeg → Opus/RTP/UDP. -re paces to realtime; -stream_loop N repeats the file (N=-1 infinite keeps the
  // track flowing forever — good for Leg 1; a finite N plays a bounded burst then STOPS, leaving a trailing
  // silence so the agent's VAD can endpoint the utterance and actually complete a turn — needed for Leg 2,
  // because continuous audio never endpoints and every turn gets interrupted before the agent can speak).
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", String(loops), "-i", wavPath,
    "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-application", "voip",
    "-payload_type", String(OPUS_PT), "-ssrc", "11111111",
    "-f", "rtp", `rtp://127.0.0.1:${udpPort}`,
  ]);
  ff.stderr.on("data", (d) => log("ffmpeg", { err: String(d).slice(0, 200) }));

  const udp = createSocket("udp4");
  let rtpCount = 0;
  udp.on("message", (buf) => {
    try {
      track.writeRtp(buf);
      if (++rtpCount % 100 === 0) log("pub-rtp", { sent: rtpCount });
    } catch (e) {
      log("pub-rtp-err", { message: String(e).slice(0, 120) });
    }
  });
  await new Promise((r) => udp.bind(udpPort, "127.0.0.1", r));
  log("pub-udp-bound", { udpPort });

  const connected = () =>
    new Promise((resolve) => {
      if (pc.connectionState === "connected") return resolve(true);
      const t = setTimeout(() => resolve(false), 12000);
      pc.connectionStateChange.subscribe((s) => {
        if (s === "connected") (clearTimeout(t), resolve(true));
        if (s === "failed") (clearTimeout(t), resolve(false));
      });
    });

  const stop = async () => {
    try { ff.kill("SIGKILL"); } catch {}
    try { udp.close(); } catch {}
    try { await pc.close(); } catch {}
  };

  return { sessionId, trackName, pc, connected, stop, rtpSent: () => rtpCount };
}
