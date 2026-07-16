// WHEP-D live media receipt — subscribe (recvonly) to a live CF-Stream WHEP source through the PRODUCTION
// gateway and prove inbound-rtp bytesReceived > 0. Mirrors whip-billable-publish's Chromium pattern but
// REVERSED: recvonly transceivers, POST the offer to /v1/whep/subscribe?resource=<uid>, apply the answer,
// then poll getStats() until real RTP bytes arrive.
//
// Prereqs: the <uid> live-input must be CONNECTED (an ffmpeg RTMPS/SRT feed running), and BEARER must carry
// whep:read/whep:write for the SAME org that provisioned the source (KV org-match §9.6).
//
// Run: doppler run --project wave --config prd -- bash -c '\
//   BEARER="$WHEP_DOGFOOD_KEY" RESOURCE=<uid> node harness/whep-subscribe-proof.mjs'
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const GW = process.env.GATEWAY_BASE ?? "https://api.wave.online";
const BEARER = process.env.BEARER; // WHEP_DOGFOOD_KEY — whep:read/write, never printed
const RESOURCE = process.env.RESOURCE; // CF Stream live-input uid (?resource=)
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS ?? 30000);
const CHROME = process.env.CHROME_BIN
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>wave-whep-subscribe</title><body>
<script>
window.WAVE = {
  async makeOffer() {
    const pc = new RTCPeerConnection();
    window.__pc = pc;
    window.__bytes = 0;
    pc.addEventListener('connectionstatechange', () => { window.__connState = pc.connectionState; });
    pc.addEventListener('track', (e) => { window.__gotTrack = (window.__gotTrack||0)+1; });
    // recvonly: we are the viewer — CF Stream sends, we receive.
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
      setTimeout(res, 4000);
    });
    return { sdp: pc.localDescription.sdp };
  },
  async setAnswer(sdp) { await window.__pc.setRemoteDescription({ type: 'answer', sdp }); return { conn: window.__pc.connectionState }; },
  async stats() {
    const pc = window.__pc; let bytes = 0, packets = 0, kinds = [];
    const report = await pc.getStats();
    report.forEach(s => {
      if (s.type === 'inbound-rtp') { bytes += (s.bytesReceived||0); packets += (s.packetsReceived||0); kinds.push(s.kind); }
    });
    return { conn: window.__connState, tracks: window.__gotTrack||0, bytes, packets, kinds };
  },
};
</script></body>`;

async function main() {
  if (!BEARER) throw new Error("need BEARER (Doppler WHEP_DOGFOOD_KEY)");
  if (!RESOURCE) throw new Error("need RESOURCE (CF Stream live-input uid)");
  const server = createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_HTML); });
  const pageUrl = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/`)));
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl);
    const offer = await page.evaluate(() => window.WAVE.makeOffer());
    log("offer-ready", { sdpBytes: offer.sdp.length });

    // SUBSCRIBE_URL overrides the gateway path (e.g. to POST directly to CF Stream's webRTCPlayback URL for
    // isolation). NO_AUTH omits the Bearer (CF playback is secret-free).
    const url = process.env.SUBSCRIBE_URL ?? `${GW}/v1/whep/subscribe?resource=${encodeURIComponent(RESOURCE)}`;
    const noAuth = process.env.NO_AUTH === "1";
    const res = await page.evaluate(async ({ url, sdp, bearer, noAuth }) => {
      const headers = { "content-type": "application/sdp" };
      if (!noAuth) headers.authorization = "Bearer " + bearer;
      const r = await fetch(url, { method: "POST", headers, body: sdp });
      return { status: r.status, body: await r.text(), loc: r.headers.get("location") };
    }, { url, sdp: offer.sdp, bearer: BEARER, noAuth });
    log("subscribe-response", { status: res.status, answerBytes: res.body.length, hasLocation: !!res.loc });
    if (res.status !== 201 || !/^v=0/.test(res.body.trim())) {
      log("subscribe-FAILED", { status: res.status, body: res.body.slice(0, 300) });
      process.exitCode = 1; return;
    }
    await page.evaluate((sdp) => window.WAVE.setAnswer(sdp), res.body);

    const start = Date.now(); let last = null;
    while (Date.now() - start < MAX_WAIT_MS) {
      last = await page.evaluate(() => window.WAVE.stats());
      if (last.bytes > 0) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    log("final-stats", last);
    if (last && last.bytes > 0) {
      log("RECEIPT-PROVEN", { bytesReceived: last.bytes, packets: last.packets, kinds: last.kinds });
      process.exitCode = 0;
    } else {
      log("RECEIPT-NOT-OBTAINED", { last });
      process.exitCode = 2;
    }
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((e) => { log("ERROR", { err: String(e?.stack ?? e) }); process.exitCode = 1; });
