// WHEP-B feed (c) — WHIP-to-Stream: publish a sendonly WebRTC stream DIRECTLY to a CF Stream Live input's
// `webRTC.url` (the WHIP ingest endpoint). This is the feed the WHEP (WebRTC) egress path requires — CF Stream
// only serves `webRTCPlayback` for WHIP-ingested inputs (RTMPS/SRT ingest yields HLS/DASH, not WebRTC).
// Publishes fake media (H.264/Opus) and HOLDS until killed, so a WHEP subscriber can pull real RTP.
//
// Run: PUBLISH_URL="<input.webRTC.url>" HOLD_MS=120000 node harness/whip-to-stream-pub.mjs
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const PUBLISH_URL = process.env.PUBLISH_URL; // CF Stream input webRTC.url (WHIP ingest)
const HOLD_MS = Number(process.env.HOLD_MS ?? 120000);
const RATE = Number(process.env.RATE ?? 30);
// Optional REAL media: point Chrome's fake capture at looping files instead of the synthetic pattern.
// A real, high-motion source (e.g. Big Buck Bunny) sustains RTP where the low-entropy synthetic pattern
// can stall/flip the input to disconnected. FAKE_VIDEO_Y4M must be a Y4M (yuv420p); FAKE_AUDIO_WAV a 16-bit WAV.
const FAKE_VIDEO_Y4M = process.env.FAKE_VIDEO_Y4M;
const FAKE_AUDIO_WAV = process.env.FAKE_AUDIO_WAV;
const CHROME = process.env.CHROME_BIN
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>whip-to-stream</title><body>
<script>
window.WAVE = {
  async publish(url, rate) {
    const pc = new RTCPeerConnection();
    window.__pc = pc;
    pc.addEventListener('connectionstatechange', () => { window.__conn = pc.connectionState; });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: rate } });
    for (const t of stream.getTracks()) {
      const tr = pc.addTransceiver(t, { direction: 'sendonly' });
      // CF Stream Live WebRTC accepts VP9 (recommended), VP8, and h264 CONSTRAINED BASELINE Level 3.1.
      // Level 3.1 caps at 720p — a 1080p H.264 stream exceeds it and CF's WHIP pipeline errors (HLS 500).
      // Prefer VP9 (no profile-level ceiling, handles 1080p cleanly), then VP8, then H.264.
      if (t.kind === 'video' && RTCRtpSender.getCapabilities && tr.setCodecPreferences) {
        const codecs = RTCRtpSender.getCapabilities('video').codecs;
        const rank = m => (/vp9/i.test(m) ? 0 : /vp8/i.test(m) ? 1 : /h264/i.test(m) ? 2 : 3);
        const pref = [...codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
        tr.setCodecPreferences(pref);
      }
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
      setTimeout(res, 4000);
    });
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp });
    const answer = await r.text();
    if (r.status >= 300 || !/^v=0/.test(answer.trim())) return { ok: false, status: r.status, body: answer.slice(0,200) };
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    // Surface which codecs CF actually selected in its answer (the m= rtpmap lines).
    const vid = (answer.match(/a=rtpmap:\\d+ (?:VP8|VP9|H264|AV1)[^\\r\\n]*/gi) || []).slice(0, 6);
    return { ok: true, status: r.status, cfCodecs: vid };
  },
  state() { return { conn: window.__conn }; },
};
</script></body>`;

async function main() {
  if (!PUBLISH_URL) throw new Error('need PUBLISH_URL (CF Stream input webRTC.url)');
  const args = ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  // Chrome loops these files seamlessly, giving a stable, real, high-motion media source.
  if (FAKE_VIDEO_Y4M) args.push(`--use-file-for-fake-video-capture=${FAKE_VIDEO_Y4M}`);
  if (FAKE_AUDIO_WAV) args.push(`--use-file-for-fake-audio-capture=${FAKE_AUDIO_WAV}`);
  log('launch', { video: FAKE_VIDEO_Y4M ?? 'synthetic', audio: FAKE_AUDIO_WAV ?? 'synthetic' });
  const browser = await chromium.launch({ executablePath: CHROME, args });
  const server = createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_HTML); });
  const pageUrl = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/`)));
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl); // http://127.0.0.1 → secure context so navigator.mediaDevices exists
    const res = await page.evaluate(({ url, rate }) => window.WAVE.publish(url, rate), { url: PUBLISH_URL, rate: RATE });
    log('publish-result', res);
    if (!res.ok) { process.exitCode = 1; return; }
    // hold, reporting connection state
    const end = Date.now() + HOLD_MS;
    while (Date.now() < end) {
      const s = await page.evaluate(() => window.WAVE.state());
      log('holding', s);
      if (s.conn === 'failed' || s.conn === 'closed') break;
      await new Promise(r => setTimeout(r, 5000));
    }
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((e) => { log('ERROR', { err: String(e?.stack ?? e) }); process.exitCode = 1; });
