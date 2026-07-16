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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 480, frameRate: rate } });
    for (const t of stream.getTracks()) pc.addTransceiver(t, { direction: 'sendonly' });
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
    return { ok: true, status: r.status };
  },
  state() { return { conn: window.__conn }; },
};
</script></body>`;

async function main() {
  if (!PUBLISH_URL) throw new Error('need PUBLISH_URL (CF Stream input webRTC.url)');
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
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
