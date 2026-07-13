// #145 (#91-C) — real direct-WHIP VIDEO publisher against the canary, to prove the #144 WHIP→RoomDO
// recorder+negotiation wiring end-to-end (publish → recorded AV1 in R2). NOT committed — a live-proof harness.
//
// Pipeline: ffmpeg testsrc → libvpx VP8 → RTP → UDP → werift sendonly video track on a PeerConnection whose
// SDP offer is POSTed to the canary's /v1/whip/publish (gateway-trust header from the minted canary secret).
// The canary (WHIP_ROOM_RECORDING=1) routes the publish through a RoomDO room → recorder tap (RT_ENCODER=
// container, AV1_DEFAULT=1) records the pulled track to wave-realtime-recordings-canary as AV1.
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from "werift";

const CANARY = process.env.CANARY_BASE ?? "https://wave-realtime-edge-canary.jakefineman.workers.dev";
const WIS = readFileSync(process.env.WIS_FILE, "utf8").trim();
const ORG = process.env.ORG ?? "wave";
const UDP_PORT = 5006;
const RUN_MS = Number(process.env.RUN_MS ?? 15000);
const VP8 = new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 });
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), r()));
  });
}

async function main() {
  const pc = new RTCPeerConnection({ codecs: { video: [VP8] } });
  const track = new MediaStreamTrack({ kind: "video" });
  pc.addTransceiver(track, { direction: "sendonly" });
  pc.connectionStateChange.subscribe((s) => log("pc-state", { state: s }));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  // POST the WHIP offer through the canary /v1/whip/publish (gateway-trust + org headers).
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

  // ffmpeg testsrc → VP8 → RTP → UDP; read RTP off the socket and write onto the werift track.
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
    "-f", "lavfi", "-i", `testsrc=size=320x240:rate=15`,
    "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-pix_fmt", "yuv420p",
    "-payload_type", "96", "-ssrc", "424242", "-f", "rtp", `rtp://127.0.0.1:${UDP_PORT}`,
  ]);
  ff.stderr.on("data", (d) => log("ffmpeg", { err: String(d).slice(0, 200) }));
  log("media-flowing", { forMs: RUN_MS });

  await new Promise((r) => setTimeout(r, RUN_MS));

  // Teardown: stop media + DELETE the WHIP resource (fires the teardown meter + finalizes the recording).
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
