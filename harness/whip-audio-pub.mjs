// #147 discriminator — real direct-WHIP AUDIO (Opus) publisher against the canary. Same wiring as
// whip-video-pub.mjs but an Opus audio track → the recorder onPublish creates a `pcm` WS adapter (not jpeg).
// Purpose: decide whether CF's adapters/websocket/new "Backend error" is video/jpeg-specific or fundamental
// to the WS media-transport adapter on this app. If audio(pcm) ALSO 503s → architecture (alt recorder path);
// if audio works + only video fails → CF jpeg-transcode limitation (record audio-first, video via container).
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from "werift";

const CANARY = process.env.CANARY_BASE ?? "https://wave-realtime-edge-canary.jakefineman.workers.dev";
const WIS = readFileSync(process.env.WIS_FILE, "utf8").trim();
const ORG = process.env.ORG ?? "wave";
const UDP_PORT = 5008;
const RUN_MS = Number(process.env.RUN_MS ?? 30000);
const OPUS = new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 });
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), r()));
  });
}

async function main() {
  const pc = new RTCPeerConnection({ codecs: { audio: [OPUS] } });
  const track = new MediaStreamTrack({ kind: "audio" });
  pc.addTransceiver(track, { direction: "sendonly" });
  pc.connectionStateChange.subscribe((s) => log("pc-state", { state: s }));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  const res = await fetch(`${CANARY}/v1/whip/publish`, {
    method: "POST",
    headers: { "content-type": "application/sdp", "x-wave-org": ORG, "x-wave-internal": WIS },
    body: pc.localDescription.sdp,
  });
  const location = res.headers.get("location");
  log("whip-publish", { status: res.status, location });
  if (res.status !== 201) {
    log("whip-publish-body", { body: (await res.text()).slice(0, 400) });
    process.exit(1);
  }
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });

  // ffmpeg sine → Opus → RTP → UDP; read RTP off the socket and write onto the werift audio track.
  const sock = createSocket("udp4");
  sock.on("message", (buf) => {
    try {
      track.writeRtp(buf);
    } catch {
      /* ignore malformed */
    }
  });
  await new Promise((r) => sock.bind(UDP_PORT, "127.0.0.1", r));
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "2",
    "-payload_type", "111", "-ssrc", "424243", "-f", "rtp", `rtp://127.0.0.1:${UDP_PORT}`,
  ]);
  ff.stderr.on("data", (d) => log("ffmpeg", { err: String(d).slice(0, 200) }));
  log("media-flowing", { forMs: RUN_MS });

  await new Promise((r) => setTimeout(r, RUN_MS));

  ff.kill("SIGINT");
  const del = await fetch(`${CANARY}${location}`, {
    method: "DELETE",
    headers: { "x-wave-org": ORG, "x-wave-internal": WIS },
  });
  log("whip-teardown", { status: del.status });
  pc.close();
  sock.close();
  log("done", { resource: location });
}

main().catch((e) => {
  log("fatal", { err: String(e?.stack ?? e).slice(0, 500) });
  process.exit(1);
});
