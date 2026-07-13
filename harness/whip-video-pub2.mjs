// #148 (#145-video A) — parameterized direct-WHIP VIDEO publisher against the canary, to discriminate
// WHY CF's adapters/websocket/new outputCodec=jpeg internal_errors on the video leg (audio pcm works).
// Two suspect variables, isolated here (ffmpeg — not werift — does the RTP packetization, so packetization
// is already RFC-conformant; the remaining source-side suspects are KEYFRAME CADENCE and SOURCE CODEC):
//   CODEC = vp8 | vp9 | h264   (env, default vp8)
//   GOP   = keyframe interval in frames (env, default 15 ≈ 1s @ 15fps; the werift baseline used libvpx
//           -deadline realtime with NO explicit -g → sparse/odd keyframes, the #148 hypothesis)
// Everything else is byte-identical to whip-video-pub.mjs (the known path that reached the SFU).
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from "werift";

const CANARY = process.env.CANARY_BASE ?? "https://wave-realtime-edge-canary.jakefineman.workers.dev";
const WIS = readFileSync(process.env.WIS_FILE, "utf8").trim();
const ORG = process.env.ORG ?? "wave";
const UDP_PORT = Number(process.env.UDP_PORT ?? 5006);
const RUN_MS = Number(process.env.RUN_MS ?? 15000);
const GOP = Number(process.env.GOP ?? 15);
const CODEC = (process.env.CODEC ?? "vp8").toLowerCase();
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, codec: CODEC, gop: GOP, ...f }));

const CODECS = {
  vp8: new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 }),
  vp9: new RTCRtpCodecParameters({ mimeType: "video/VP9", clockRate: 90000, payloadType: 98 }),
  h264: new RTCRtpCodecParameters({
    mimeType: "video/H264", clockRate: 90000, payloadType: 102,
    parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  }),
};

function ffArgs(pt) {
  const src = ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15"];
  const out = ["-payload_type", String(pt), "-ssrc", "424242", "-f", "rtp", `rtp://127.0.0.1:${UDP_PORT}`];
  if (CODEC === "vp8")
    return [...src, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k",
      "-pix_fmt", "yuv420p", "-g", String(GOP), "-keyint_min", String(GOP), ...out];
  if (CODEC === "vp9")
    return [...src, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k",
      "-pix_fmt", "yuv420p", "-g", String(GOP), "-keyint_min", String(GOP), ...out];
  if (CODEC === "h264")
    return [...src, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
      "-pix_fmt", "yuv420p", "-bf", "0", "-g", String(GOP), "-keyint_min", String(GOP),
      "-x264-params", "scenecut=0", ...out];
  throw new Error(`unknown CODEC=${CODEC}`);
}

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), r()));
  });
}

async function main() {
  const codecParams = CODECS[CODEC];
  if (!codecParams) throw new Error(`unknown CODEC=${CODEC}`);
  const pt = codecParams.payloadType;
  const pc = new RTCPeerConnection({ codecs: { video: [codecParams] } });
  const track = new MediaStreamTrack({ kind: "video" });
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

  const sock = createSocket("udp4");
  sock.on("message", (buf) => {
    try {
      track.writeRtp(buf);
    } catch {
      /* ignore malformed */
    }
  });
  await new Promise((r) => sock.bind(UDP_PORT, "127.0.0.1", r));
  const ff = spawn("ffmpeg", ffArgs(pt));
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
