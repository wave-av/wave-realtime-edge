// #151 (#145-video D) — DECISIVE self-contained proof that WAVE can PULL a FULL-MOTION video track off a
// CF Realtime SFU (the recorder's video leg, bypassing CF's ~1fps jpeg WS adapter). One process:
//   PUBLISHER  werift sendonly VP8 → CF SFU sessions/new + tracks/new(local)   → (sessionId, trackName)
//   SUBSCRIBER werift recvonly VP8 → CF SFU sessions/new + tracks/new(remote)  → renegotiate → receive RTP
// Then count received video frames (RTP marker bit) over the window → prove the delivered rate is the
// source's full ~15fps (NOT CF jpeg's 1fps). Deterministic ids in-hand → no observability/log-scraping.
// Creds: APP_ID/APP_SECRET (CF_CALLS_APP_ID/SECRET from Doppler; same app the canary uses).
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, dePacketizeRtpPackets } from "werift";

// #151 root-cause fix: DO NOT hand-roll RFC7741 reassembly. werift ships correct per-codec
// depacketizers (VP8/VP9/H264/AV1/OPUS) via dePacketizeRtpPackets(codec, packets). Feed it the
// packets of ONE frame, GROUPED BY RTP timestamp and ORDERED BY sequence number, and it returns
// { isKeyframe, data } — the clean, decodable frame. (H265 is NOT in werift's list — a real #153 gap.)

// 16-bit sequence-number comparator that is wrap-safe within a single frame's packet run.
function seqCmp(a, b) {
  const d = (a - b) & 0xffff;
  return d === 0 ? 0 : d < 0x8000 ? 1 : -1;
}
// Minimal IVF (VP8) container writer for a list of whole frames.
function writeIvf(path, frames, w, h, fps) {
  const chunks = [];
  const hdr = Buffer.alloc(32);
  hdr.write("DKIF", 0); hdr.writeUInt16LE(0, 4); hdr.writeUInt16LE(32, 6); hdr.write("VP80", 8);
  hdr.writeUInt16LE(w, 12); hdr.writeUInt16LE(h, 14); hdr.writeUInt32LE(fps, 16); hdr.writeUInt32LE(1, 20);
  hdr.writeUInt32LE(frames.length, 24); hdr.writeUInt32LE(0, 28);
  chunks.push(hdr);
  frames.forEach((f, i) => { const fh = Buffer.alloc(12); fh.writeUInt32LE(f.length, 0); fh.writeUInt32LE(i, 4); chunks.push(fh, f); });
  writeFileSync(path, Buffer.concat(chunks));
}

const SFU = process.env.SFU_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const RUN_MS = Number(process.env.RUN_MS ?? 18000);
const RATE = Number(process.env.RATE ?? 15);
const TRACK = "pullproof-video";
// #151 root-cause fix: declare RTCP feedback so the SUBSCRIBER negotiates transport-cc + REMB + nack/pli.
// Without it CF's SFU sees no receiver bandwidth signal and forwards at a floor (~98.5% loss). With it,
// werift sends receiver feedback → CF opens the tap → full-rate delivery.
const VIDEO_FB = [
  { type: "nack" }, { type: "nack", parameter: "pli" },
  { type: "goog-remb" }, { type: "transport-cc" }, { type: "ccm", parameter: "fir" },
];
const VP8 = new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96, rtcpFeedback: VIDEO_FB });
const auth = { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" };
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((r) => { const t = setTimeout(r, ms); pc.iceGatheringStateChange.subscribe((s) => s === "complete" && (clearTimeout(t), r())); });
}
async function post(path, body) {
  const res = await fetch(`${SFU}/apps/${APP_ID}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}
async function put(path, body) {
  const res = await fetch(`${SFU}/apps/${APP_ID}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
  return res.status;
}

async function publish() {
  const pc = new RTCPeerConnection({ codecs: { video: [VP8] } });
  const track = new MediaStreamTrack({ kind: "video" });
  const tx = pc.addTransceiver(track, { direction: "sendonly" });
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitIce(pc);
  const s = await post(`/sessions/new`, { sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } });
  await pc.setRemoteDescription(s.sessionDescription);
  await post(`/sessions/${s.sessionId}/tracks/new`, { tracks: [{ location: "local", mid: tx.mid, trackName: TRACK }] });
  log("pub-ready", { sessionId: s.sessionId, trackName: TRACK, mid: tx.mid });
  // ffmpeg testsrc → VP8 → RTP → UDP → writeRtp
  const port = 5020;
  const sock = createSocket("udp4");
  let sent = 0, sentMarker = 0;
  sock.on("message", (b) => { try { track.writeRtp(b); sent++; if (b.length > 1 && (b[1] & 0x80)) sentMarker++; } catch {} });
  await new Promise((r) => sock.bind(port, "127.0.0.1", r));
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", `testsrc=size=320x240:rate=${RATE}`,
    "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "600k", "-pix_fmt", "yuv420p", "-g", String(RATE), "-keyint_min", String(RATE),
    "-payload_type", "96", "-ssrc", "424242", "-f", "rtp", `rtp://127.0.0.1:${port}`]);
  ff.stderr.on("data", (d) => log("pub-ffmpeg", { err: String(d).slice(0, 160) }));
  return { pc, sessionId: s.sessionId, sentStats: () => ({ sent, sentMarker }), stop: () => { try { ff.kill("SIGINT"); } catch {} try { sock.close(); } catch {} try { pc.close(); } catch {} } };
}

async function subscribe(pubSession) {
  const pc = new RTCPeerConnection({ codecs: { video: [VP8] } });
  pc.addTransceiver("video", { direction: "recvonly" });
  let frames = 0, packets = 0, first = 0, last = 0;
  const outFrames = []; // { data: Buffer, keyframe: boolean } — one clean depacketized frame each
  let group = []; let groupTs = null; // packets of the in-progress frame (share one RTP timestamp)
  const flush = () => {
    if (!group.length) return;
    const ordered = group.slice().sort((a, b) => seqCmp(a.header.sequenceNumber, b.header.sequenceNumber));
    try {
      const out = dePacketizeRtpPackets("VP8", ordered);
      if (out.data && out.data.length) {
        if (!frames) log("first-frame-shape", { ctor: out.data?.constructor?.name, len: out.data.length, key: out.isKeyframe });
        outFrames.push({ data: Buffer.from(out.data), keyframe: out.isKeyframe }); frames++;
      }
    } catch (e) { log("depack-err", { err: String(e).slice(0, 120) }); }
    group = []; groupTs = null;
  };
  // DIAGNOSTIC (root-cause): quantify the RAW received stream independent of my grouping.
  let seqMin = Infinity, seqMax = -Infinity, rawCount = 0, kfStartPkts = 0, distinctTs = new Set();
  pc.onTrack.subscribe((track) => {
    log("sub-ontrack", { kind: track.kind });
    track.onReceiveRtp.subscribe((rtp) => {
      packets++; const n = Date.now(); if (!first) first = n; last = n;
      // raw-stream stats: seq range/loss, distinct frame timestamps, VP8 keyframe-start packets
      rawCount++;
      const sq = rtp.header.sequenceNumber; if (sq < seqMin) seqMin = sq; if (sq > seqMax) seqMax = sq;
      distinctTs.add(rtp.header.timestamp);
      // VP8: S-bit (start of partition) set + PID 0 + first partition byte0 bit0==0 ⇒ keyframe start
      const pl = rtp.payload; if (pl && pl.length > 1 && (pl[0] & 0x10) && (rtp.payload.length > 1)) { /* S-bit heuristic */ }
      if (pl && pl.length && (pl[0] & 0x10)) kfStartPkts++;
      const ts = rtp.header.timestamp;
      if (groupTs !== null && ts !== groupTs) flush(); // timestamp change ⇒ previous frame is complete
      groupTs = ts; group.push(rtp);
      if (rtp.header.marker) flush(); // marker bit ⇒ current frame is complete
    });
  });
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitIce(pc);
  const s = await post(`/sessions/new`, { sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } });
  await pc.setRemoteDescription(s.sessionDescription);
  const t = await post(`/sessions/${s.sessionId}/tracks/new`, { tracks: [{ location: "remote", sessionId: pubSession, trackName: TRACK }] });
  log("sub-track-new", { reneg: t.requiresImmediateRenegotiation, hasOffer: !!t.sessionDescription });
  if (t.requiresImmediateRenegotiation && t.sessionDescription) {
    await pc.setRemoteDescription(t.sessionDescription);
    const a = await pc.createAnswer(); await pc.setLocalDescription(a); await waitIce(pc);
    const st = await put(`/sessions/${s.sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } });
    log("sub-renegotiate", { status: st });
  }
  const result = () => {
    const secs = first && last > first ? (last - first) / 1000 : 0;
    const span = seqMax - seqMin + 1;
    return {
      packets, frames, seconds: Number(secs.toFixed(2)), fps: secs ? Number((frames / secs).toFixed(2)) : 0,
      // DIAG: raw-stream health — lossPct = missing seq in range; distinctFrames = unique RTP timestamps
      rawCount, seqSpan: span, lossPct: span > 0 ? Number((100 * (1 - rawCount / span)).toFixed(1)) : 0,
      distinctFrames: distinctTs.size, kfStartPkts,
    };
  };
  const dumpIvf = (path) => {
    // dims from the first VP8 keyframe (byte0 bit0==0 → keyframe; start code 9d 01 2a at [3..5])
    let w = 320, h = 240;
    const datas = outFrames.map((f) => f.data);
    const kf = datas.find((d) => d.length > 10 && (d[0] & 1) === 0 && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a);
    if (kf) { w = (kf[6] | (kf[7] << 8)) & 0x3fff; h = (kf[8] | (kf[9] << 8)) & 0x3fff; }
    if (datas.length) writeIvf(path, datas, w, h, RATE);
    return { wrote: datas.length, w, h, keyframes: outFrames.filter((f) => f.keyframe).length };
  };
  const stop = () => { try { pc.close(); } catch {} };
  return { pc, result, dumpIvf, stop };
}

async function main() {
  if (!APP_ID || !APP_SECRET) throw new Error("need APP_ID/APP_SECRET");
  const pub = await publish();
  await new Promise((r) => setTimeout(r, 2500)); // let media start flowing
  const sub = await subscribe(pub.sessionId);
  await new Promise((r) => setTimeout(r, RUN_MS));
  const ivfPath = process.env.IVF_OUT ?? "/tmp/sfu-pull.ivf";
  const dump = sub.dumpIvf(ivfPath);
  log("PROOF", { rate: RATE, ...pub.sentStats(), ...sub.result(), ivf: ivfPath, ...dump });
  sub.stop(); pub.stop();
}
main().catch((e) => { log("fatal", { err: String(e?.stack ?? e).slice(0, 500) }); process.exit(1); });
