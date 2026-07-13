// #152 — RESOLVE the sender-vs-subscriber fork for the raw-SFU video pull (#151/#145-video), and produce the
// #151 recorder receipt: a REAL WebM muxed from a live browser-published track pulled off the CF Realtime SFU.
//
// The werift-forward SYNTHETIC rig (sfu-pull-proof.mjs) starved at ~1 packet/frame — bad SENDER or bad
// SUBSCRIBER? We need a KNOWN-GOOD source. Here a REAL Chromium getUserMedia→VP8 encoder publishes into the
// SFU; the SAME werift recvonly subscriber pulls it and feeds werift's OWN MediaRecorder (jitter buffer +
// per-codec depacketizer + WebM mux — covers VP8/VP9/H264/AV1/Opus). Then ffprobe the WebM = an iron receipt.
//
//   ROOT-CAUSE PROGRESSION (systematic-debugging):
//     H1 rtcpFeedback fixes starvation ....... FALSE (synthetic rig, loss unchanged).
//     Root cause of starvation ............... the SYNTHETIC werift-forward SENDER. Browser-pub ⇒ lossPct≈0.
//     New symptom (clean input): undecodable . no keyframe on mid-stream join ⇒ send RTCP PLI → IDR. FIXED.
//     New symptom: a few corrupt frames ...... my hand-rolled ts-grouping mishandled reorder. FIX = use
//                                              werift's MediaRecorder (library jitter buffer), not hand-roll.
//
// SECURITY: the CF app secret NEVER enters the browser page. Node holds APP_ID/APP_SECRET (Doppler) and does
// ALL SFU REST. The page only does getUserMedia/createOffer/ICE and hands its SDP offer to node.
//
// Run: doppler run --project wave --config prd -- bash -c \
//   'APP_ID="$CF_CALLS_APP_ID" APP_SECRET="$CF_CALLS_APP_SECRET" node browser-pub-sfu-proof.mjs'
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { chromium } from "playwright-core";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { MediaRecorder } from "werift/nonstandard";

const SFU = process.env.SFU_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const RUN_MS = Number(process.env.RUN_MS ?? 18000);
const RATE = Number(process.env.RATE ?? 30);
const CODEC = (process.env.CODEC ?? "VP8").toUpperCase(); // VP8 | VP9 | H264 — the browser publish codec (#153)
const WEBM_OUT = process.env.WEBM_OUT ?? `/tmp/browser-pull-${CODEC.toLowerCase()}.webm`;
const TRACK = "browserpub-video";
const CHROME = process.env.CHROME_BIN
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const VIDEO_FB = [
  { type: "nack" }, { type: "nack", parameter: "pli" },
  { type: "goog-remb" }, { type: "transport-cc" }, { type: "ccm", parameter: "fir" },
];
// Subscriber codec params — must match the browser publish codec so the SFU forwards it unchanged.
const CODEC_PARAMS = {
  VP8: new RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96, rtcpFeedback: VIDEO_FB }),
  VP9: new RTCRtpCodecParameters({ mimeType: "video/VP9", clockRate: 90000, payloadType: 98, rtcpFeedback: VIDEO_FB }),
  H264: new RTCRtpCodecParameters({
    mimeType: "video/H264", clockRate: 90000, payloadType: 102, rtcpFeedback: VIDEO_FB,
    parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  }),
  AV1: new RTCRtpCodecParameters({ mimeType: "video/AV1", clockRate: 90000, payloadType: 45, rtcpFeedback: VIDEO_FB }),
};
const SUB_CODEC = CODEC_PARAMS[CODEC] ?? CODEC_PARAMS.VP8;
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

// The page script: real browser getUserMedia (fake device) → sendonly track (forced codec) → offer. No secret.
const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>wave-browser-pub</title><body>
<script>
window.WAVE = {
  async makeOffer(rate, codec) {
    const pc = new RTCPeerConnection();
    window.__pc = pc;
    pc.addEventListener('iceconnectionstatechange', () => { window.__iceState = pc.iceConnectionState; });
    pc.addEventListener('connectionstatechange', () => { window.__connState = pc.connectionState; });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: 640, height: 480, frameRate: rate } });
    const track = stream.getVideoTracks()[0];
    const tx = pc.addTransceiver(track, { direction: 'sendonly' });
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      const want = caps.codecs.filter(c => new RegExp('/' + codec + '$', 'i').test(c.mimeType));
      if (want.length && tx.setCodecPreferences) tx.setCodecPreferences(want);
    } catch (e) {}
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
      setTimeout(res, 4000);
    });
    return { sdp: pc.localDescription.sdp, mid: tx.mid };
  },
  async setAnswer(answer) { await window.__pc.setRemoteDescription(answer); return { conn: window.__pc.connectionState }; },
  stats() { return { conn: window.__connState, ice: window.__iceState }; },
};
</script></body>`;

// werift recvonly subscriber → feed the pulled track into werift's OWN MediaRecorder (jitter+depack+WebM mux).
async function subscribe(pubSession, trackName, webmPath) {
  const pc = new RTCPeerConnection({ codecs: { video: [SUB_CODEC] } });
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  const recorder = new MediaRecorder({ numOfTracks: 1, path: webmPath, disableLipSync: true, disableNtp: true });
  recorder.onError.subscribe((e) => log("rec-err", { err: String(e).slice(0, 160) }));
  let packets = 0, first = 0, last = 0, ssrc = null, addedToRecorder = false;
  // raw-stream DIAG (independent of muxing): the fork evidence — is the transport clean end to end?
  let seqMin = Infinity, seqMax = -Infinity; const distinctTs = new Set();
  // PLI pump: on a mid-GOP join there is no keyframe. Ask CF (→ browser) for an IDR until the mux gets one.
  let gotFrame = false, plisSent = 0;
  const pliPump = setInterval(() => {
    if (ssrc == null || gotFrame) return;
    try { transceiver.receiver.sendRtcpPLI(ssrc); plisSent++; } catch (e) { log("pli-err", { err: String(e).slice(0, 100) }); }
  }, 700);
  pc.onTrack.subscribe(async (track) => {
    const hasCodec = !!track.codec;
    log("sub-ontrack", { kind: track.kind, hasCodec });
    // onTrack fires twice: a codec-less placeholder (initial answer) then the REAL negotiated track (post
    // renegotiate). The RTP flows on the codec-bearing one — that is the track the WebM writer must record.
    if (!addedToRecorder && hasCodec) { addedToRecorder = true; await recorder.addTrack(track); }
    track.onReceiveRtp.subscribe((rtp) => {
      packets++; const n = Date.now(); if (!first) first = n; last = n; gotFrame = true;
      if (ssrc == null) { ssrc = rtp.header.ssrc; try { transceiver.receiver.sendRtcpPLI(ssrc); plisSent++; } catch {} }
      const sq = rtp.header.sequenceNumber; if (sq < seqMin) seqMin = sq; if (sq > seqMax) seqMax = sq;
      distinctTs.add(rtp.header.timestamp);
    });
  });
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitIce(pc);
  const s = await post(`/sessions/new`, { sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } });
  await pc.setRemoteDescription(s.sessionDescription);
  const t = await post(`/sessions/${s.sessionId}/tracks/new`, { tracks: [{ location: "remote", sessionId: pubSession, trackName }] });
  log("sub-track-new", { reneg: t.requiresImmediateRenegotiation, hasOffer: !!t.sessionDescription });
  if (t.requiresImmediateRenegotiation && t.sessionDescription) {
    await pc.setRemoteDescription(t.sessionDescription);
    const a = await pc.createAnswer(); await pc.setLocalDescription(a); await waitIce(pc);
    const st = await put(`/sessions/${s.sessionId}/renegotiate`, { sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } });
    log("sub-renegotiate", { status: st });
  }
  const result = () => {
    const secs = first && last > first ? (last - first) / 1000 : 0;
    const span = seqMax >= seqMin ? seqMax - seqMin + 1 : 0;
    return {
      packets, seconds: Number(secs.toFixed(2)),
      seqSpan: span, lossPct: span > 0 ? Number((100 * (1 - packets / span)).toFixed(1)) : 0,
      distinctFrames: distinctTs.size, sourceFps: secs ? Number((distinctTs.size / secs).toFixed(2)) : 0, plisSent,
    };
  };
  const stop = async () => { clearInterval(pliPump); try { await recorder.stop(); } catch (e) { log("rec-stop-err", { err: String(e).slice(0, 120) }); } try { pc.close(); } catch {} };
  return { result, stop };
}

// ffprobe the muxed WebM = the iron receipt: real container, real codec, real frame count/fps, decodable.
function ffprobe(path) {
  return new Promise((resolve) => {
    const ff = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,nb_read_packets,avg_frame_rate,r_frame_rate",
      "-count_packets", "-of", "json", path]);
    let out = "", err = "";
    ff.stdout.on("data", (d) => { out += d; });
    ff.stderr.on("data", (d) => { err += d; });
    ff.on("close", () => {
      try { resolve({ ok: true, stream: JSON.parse(out).streams?.[0] ?? null, err: err.slice(0, 200) }); }
      catch { resolve({ ok: false, err: (err || out).slice(0, 200) }); }
    });
  });
}
// Decode-to-null: 0 errors ⇒ the muxed bitstream is clean end to end.
function decodeCheck(path) {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-v", "error", "-i", path, "-f", "null", "-"]);
    let err = "";
    ff.stderr.on("data", (d) => { err += String(d); });
    ff.on("close", (code) => { const lines = err.split("\n").filter((l) => l.trim()); resolve({ exit: code, errLines: lines.length, sample: lines.slice(0, 3) }); });
  });
}

async function main() {
  if (!APP_ID || !APP_SECRET) throw new Error("need APP_ID/APP_SECRET (Doppler wave/prd CF_CALLS_APP_ID/SECRET)");

  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_HTML); });
  const pageUrl = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/`)));
  log("page-server", { pageUrl, codec: CODEC });

  // Chrome's built-in fake device caps ~20fps. To prove TRUE full-motion, feed a real 30fps Y4M via
  // --use-file-for-fake-video-capture (FAKE_VIDEO=/path/to.y4m) — Chrome encodes it at the file's native rate.
  const fakeVideo = process.env.FAKE_VIDEO;
  const launchArgs = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
  if (fakeVideo) launchArgs.push(`--use-file-for-fake-video-capture=${fakeVideo}`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: launchArgs });
  const ctx = await browser.newContext({ permissions: ["camera"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("page-error", { err: String(e).slice(0, 200) }));
  await page.goto(pageUrl);

  const offer = await page.evaluate(([rate, codec]) => window.WAVE.makeOffer(rate, codec), [RATE, CODEC]);
  const codecInSdp = new RegExp(CODEC, "i").test(offer.sdp);
  log("browser-offer", { mid: offer.mid, codecInSdp, sdpLen: offer.sdp.length });
  const s = await post(`/sessions/new`, { sessionDescription: { type: "offer", sdp: offer.sdp } });
  const setA = await page.evaluate((ans) => window.WAVE.setAnswer(ans), s.sessionDescription);
  await post(`/sessions/${s.sessionId}/tracks/new`, { tracks: [{ location: "local", mid: offer.mid, trackName: TRACK }] });
  log("pub-ready", { sessionId: s.sessionId, trackName: TRACK, mid: offer.mid, setAnswer: setA });

  await new Promise((r) => setTimeout(r, 3000));
  log("pub-stats", await page.evaluate(() => window.WAVE.stats()));
  const sub = await subscribe(s.sessionId, TRACK, WEBM_OUT);
  await new Promise((r) => setTimeout(r, RUN_MS));

  await sub.stop();
  await browser.close();
  server.close();
  await new Promise((r) => setTimeout(r, 300)); // let the WebM flush to disk

  const res = sub.result();
  let sizeBytes = 0; try { sizeBytes = statSync(WEBM_OUT).size; } catch {}
  const probe = sizeBytes > 0 ? await ffprobe(WEBM_OUT) : { ok: false, err: "no webm written" };
  const decode = sizeBytes > 0 ? await decodeCheck(WEBM_OUT) : { exit: -1, errLines: -1, sample: ["no webm"] };
  const st = probe.stream ?? {};
  const nbFrames = Number(st.nb_read_packets ?? 0);
  const notStarved = res.packets > 0 && res.distinctFrames < res.packets && res.lossPct < 5; // multi-packet frames, no loss
  // decode is CLEAN when ffmpeg exits 0 with no BITSTREAM errors. The streaming-WebM "Unknown-sized element"
  // container note is benign (werift writes a live/infinite Segment) — not a decode failure.
  const bitstreamErr = decode.sample.some((s) => /Invalid data|Header size|Error submitting|Decoding error|non existing PPS|corrupt/i.test(s));
  const decodesClean = decode.exit === 0 && !bitstreamErr && nbFrames > 10;
  const clean = notStarved && decodesClean && st.codec_name;
  const fullMotion = res.sourceFps >= 24;
  log("PROOF", {
    codec: CODEC, ...res, webm: WEBM_OUT, sizeBytes,
    muxed: { codec: st.codec_name, w: st.width, h: st.height, frames: nbFrames, avg_frame_rate: st.avg_frame_rate },
    decode,
    VERDICT: clean
      ? (fullMotion ? "CLEAN + FULL-MOTION (werift subscriber VIABLE → port to src/ #151)" : "CLEAN, sourceFps<24 (source/fake-device cap — subscriber is fine)")
      : "DIRTY/STARVED (check diag)",
  });
}
main().catch((e) => { log("fatal", { err: String(e?.stack ?? e).slice(0, 500) }); process.exit(1); });
