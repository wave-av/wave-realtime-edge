// #154 LIVE E2E — the transport hop the offline proof (av1-depacketize-proof.mjs) does not exercise: a REAL
// Chromium AV1 WebRTC encoder publishes into the CF Realtime SFU, and the PRODUCTION recorder module
// (containers/rt-recorder subscribeAndRecord, codec=AV1) pulls it back, depacketizes with AV1RtpPayload, writes
// IVF, and native-transcodes to WebM. ffprobe av1 = the live receipt. This closes the two open unknowns:
//   (1) does CF SFU forward AV1 RTP to a werift subscriber, and
//   (2) does Chrome's AV1 OBU/RTP layout feed cleanly through our Av1FrameAssembler.
// LOCAL sink only (a temp IVF/WebM) — no R2, no WAVE_INTERNAL_SECRET, no gateway. APP creds stay in NODE.
//
// Run: doppler run --project wave --config prd -- bash -c \
//   'APP_ID="$CF_CALLS_APP_ID" APP_SECRET="$CF_CALLS_APP_SECRET" node harness/av1-live-e2e.mjs'
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { chromium } from "playwright-core";
import { subscribeAndRecord } from "../containers/rt-recorder/server/sfu-track-recorder.mjs";
import { transcodeToWebm } from "../containers/rt-recorder/server/native-transcode.mjs";

const SFU = process.env.SFU_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const RUN_MS = Number(process.env.RUN_MS ?? 15000);
const RATE = Number(process.env.RATE ?? 30);
const W = Number(process.env.W ?? 640), H = Number(process.env.H ?? 480);
const IVF_OUT = process.env.IVF_OUT ?? "/tmp/av1-live.ivf";
const WEBM_OUT = process.env.WEBM_OUT ?? "/tmp/av1-live.webm";
const TRACK = "browserpub-av1";
const CHROME = process.env.CHROME_BIN
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const auth = { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" };
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

async function post(path, body) {
  const res = await fetch(`${SFU}/apps/${APP_ID}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

// Page: real browser getUserMedia (fake device) → sendonly track forced to AV1 → offer. No secret in the page.
const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>wave-av1-pub</title><body>
<script>
window.WAVE = {
  async makeOffer(rate) {
    const pc = new RTCPeerConnection();
    window.__pc = pc;
    pc.addEventListener('connectionstatechange', () => { window.__connState = pc.connectionState; });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: ${W}, height: ${H}, frameRate: rate } });
    const tx = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' });
    let av1Offered = false;
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      const av1 = caps.codecs.filter(c => /\\/AV1$/i.test(c.mimeType));
      av1Offered = av1.length > 0;
      if (av1.length && tx.setCodecPreferences) tx.setCodecPreferences(av1); // AV1 first/only
    } catch (e) {}
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
      setTimeout(res, 4000);
    });
    return { sdp: pc.localDescription.sdp, mid: tx.mid, av1Offered };
  },
  async setAnswer(answer) { await window.__pc.setRemoteDescription(answer); return { conn: window.__pc.connectionState }; },
  stats() { return { conn: window.__connState }; },
};
</script></body>`;

function ffprobe(path) {
  const r = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=codec_name,width,height,nb_read_packets", "-of", "default=nk=1:nw=1", path]);
  return new Promise((resolve) => { let o = ""; r.stdout.on("data", (d) => (o += d)); r.on("close", () => resolve(o.trim().split("\n"))); });
}

async function main() {
  if (!APP_ID || !APP_SECRET) throw new Error("need APP_ID/APP_SECRET (Doppler wave/prd CF_CALLS_APP_ID/SECRET)");

  const server = createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_HTML); });
  const pageUrl = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/`)));

  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext({ permissions: ["camera"] })).newPage();
  page.on("pageerror", (e) => log("page-error", { err: String(e).slice(0, 200) }));
  await page.goto(pageUrl);

  // 1) Browser publishes an AV1 track into CF SFU (local-track publish REST; node holds the secret).
  const offer = await page.evaluate((rate) => window.WAVE.makeOffer(rate), RATE);
  const av1InSdp = /AV1/i.test(offer.sdp);
  log("browser-offer", { mid: offer.mid, av1Offered: offer.av1Offered, av1InSdp });
  const s = await post(`/sessions/new`, { sessionDescription: { type: "offer", sdp: offer.sdp } });
  await page.evaluate((ans) => window.WAVE.setAnswer(ans), s.sessionDescription);
  await post(`/sessions/${s.sessionId}/tracks/new`, { tracks: [{ location: "local", mid: offer.mid, trackName: TRACK }] });
  await new Promise((r) => setTimeout(r, 2500));
  log("pub-ready", { sessionId: s.sessionId, track: TRACK, pub: await page.evaluate(() => window.WAVE.stats()) });

  // 2) PRODUCTION recorder module pulls the AV1 track → depacketize → IVF (my #154 code path).
  const rec = await subscribeAndRecord({
    appId: APP_ID, appSecret: APP_SECRET, publisherSessionId: s.sessionId, trackName: TRACK,
    codec: "AV1", webmPath: IVF_OUT.replace(/\.ivf$/, ""), runMs: RUN_MS, sfuBase: SFU, width: W, height: H,
  });
  log("recorder", rec);

  await browser.close();
  server.close();

  // 3) native-transcode the IVF → WebM (the driver's real fallback), then ffprobe both = the receipt.
  let verdict = "FAIL";
  if (rec.nativeInput?.input) {
    let ivfBytes = 0; try { ivfBytes = statSync(rec.nativeInput.input).size; } catch {}
    const t = await transcodeToWebm({ input: rec.nativeInput.input, codec: "AV1", outPath: WEBM_OUT, log });
    const [ivfCodec, ivfW, ivfH, ivfPk] = await ffprobe(rec.nativeInput.input);
    const [webmCodec, , , webmPk] = await ffprobe(WEBM_OUT);
    const ok = ivfCodec === "av1" && webmCodec === "av1" && Number(webmPk) > 10;
    verdict = ok ? "LIVE PASS — browser AV1 → CF SFU → recorder → IVF → WebM (av1)" : "PARTIAL";
    log("receipt", { ivf: { codec: ivfCodec, w: ivfW, h: ivfH, packets: ivfPk, bytes: ivfBytes }, webm: { codec: webmCodec, packets: webmPk, bytes: t.bytes } });
  } else {
    log("no-native-input", { reason: rec.reason, stats: rec.stats });
  }
  log("VERDICT", { verdict, recorderStats: rec.stats });
  process.exit(verdict.startsWith("LIVE PASS") ? 0 : 1);
}
main().catch((e) => { log("fatal", { err: String(e?.stack ?? e).slice(0, 500) }); process.exit(1); });
