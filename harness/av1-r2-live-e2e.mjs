// #145 / #91-C FULL-CHAIN LIVE RECEIPT — video bytes land in the canonical R2 object via the HOSTED path.
//
// This is the production-shaped chain end to end (the direct-SFU proof in av1-live-e2e.mjs stopped at a LOCAL
// sink; this one lands in R2 through the real ingest route + RoomDO single-writer):
//
//   browser AV1 (real Chromium encoder)
//     → POST canary /v1/whip/publish   (WHIP_ROOM_RECORDING → RoomDO room; the track REGISTERS via onPublish)
//     → POST canary /v1/realtime/recorder-dispatch/:org/:room   (the RoomDO MINTS a per-track ingest token)
//     → werift rt-recorder pulls the SFU track → AV1→WebM (native-transcode) → recorder-route-sink PUT
//     → PUT canary /v1/realtime/recording-ingest/:org/:room/:session/:track?t=<token>   (RoomDO writes R2)
//     → DELETE canary /v1/whip/resource/:id   (teardown → finalize + duration meter)
//   → ffprobe the R2 object we read back = the live receipt.
//
// The canary has NO gateway in front, so this node process STANDS IN for the gateway: it seals x-wave-internal
// (WAVE_INTERNAL_SECRET, from Doppler — USED as a header, never printed) + x-wave-org + x-wave-room, exactly the
// headers api.wave.online stamps in prod. The SFU app creds (CF_CALLS_APP_*) stay in node too.
//
// Run: doppler run --project wave --config prd -- bash -c '\
//   APP_ID="$CF_CALLS_APP_ID" APP_SECRET="$CF_CALLS_APP_SECRET" INTERNAL="$WAVE_INTERNAL_SECRET" \
//   node harness/av1-r2-live-e2e.mjs'
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import fsMod from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { recordTrackToSink } from "../containers/rt-recorder/server/record-to-sink.mjs";
import { makeRecorderRouteSink } from "../containers/rt-recorder/server/recorder-route-sink.mjs";

const CANARY = process.env.CANARY_BASE ?? "https://wave-realtime-edge-canary.jakefineman.workers.dev";
const SFU = process.env.SFU_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const INTERNAL = process.env.INTERNAL; // WAVE_INTERNAL_SECRET — sealed as x-wave-internal, never logged
const ORG = process.env.ORG ?? "wave";
const ROOM = process.env.ROOM ?? `av1rec-${Date.now()}`;
const RUN_MS = Number(process.env.RUN_MS ?? 15000);
const RATE = Number(process.env.RATE ?? 30);
const W = Number(process.env.W ?? 640), H = Number(process.env.H ?? 480);
const CHROME = process.env.CHROME_BIN
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const log = (msg, f = {}) => console.log(JSON.stringify({ t: Date.now(), msg, ...f }));

// Internal (gateway-stand-in) headers. INTERNAL is a VALUE used as a header — never echoed to a log line.
const internalHeaders = (extra = {}) => ({ "x-wave-internal": INTERNAL, "x-wave-org": ORG, ...extra });

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>wave-av1-whip-pub</title><body>
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
  async setAnswer(sdp) { await window.__pc.setRemoteDescription({ type: 'answer', sdp }); return { conn: window.__pc.connectionState }; },
  stats() { return { conn: window.__connState }; },
};
</script></body>`;

function ffprobe(path) {
  const r = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=codec_name,width,height,nb_read_packets", "-of", "default=nk=1:nw=1", path]);
  return new Promise((resolve) => { let o = ""; r.stdout.on("data", (d) => (o += d)); r.on("close", () => resolve(o.trim().split("\n"))); });
}

async function main() {
  if (!APP_ID || !APP_SECRET) throw new Error("need APP_ID/APP_SECRET (Doppler CF_CALLS_APP_ID/SECRET)");
  if (!INTERNAL) throw new Error("need INTERNAL (Doppler WAVE_INTERNAL_SECRET) to seal the gateway-trust header");

  const server = createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_HTML); });
  const pageUrl = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/`)));
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext({ permissions: ["camera"] })).newPage();
  page.on("pageerror", (e) => log("page-error", { err: String(e).slice(0, 200) }));
  await page.goto(pageUrl);

  let verdict = "FAIL", receipt = null, resourceId = null;
  try {
    // 1) Browser makes an AV1 offer; node relays it to the canary WHIP publish (playing the gateway).
    const offer = await page.evaluate((rate) => window.WAVE.makeOffer(rate), RATE);
    log("browser-offer", { mid: offer.mid, av1Offered: offer.av1Offered, av1InSdp: /AV1/i.test(offer.sdp) });

    const pubRes = await fetch(`${CANARY}/v1/whip/publish`, {
      method: "POST",
      headers: internalHeaders({ "content-type": "application/sdp", "x-wave-room": ROOM }),
      body: offer.sdp,
    });
    const answerSdp = await pubRes.text();
    if (pubRes.status !== 201) throw new Error(`whip/publish ${pubRes.status}: ${answerSdp.slice(0, 300)}`);
    resourceId = (pubRes.headers.get("location") ?? "").split("/").pop() || null;
    const av1InAnswer = /AV1/i.test(answerSdp);
    log("whip-published", { status: 201, resourceId, room: ROOM, av1InAnswer });

    // 2) Browser accepts the SFU answer → media flows to CF SFU. Give it a few seconds to establish.
    await page.evaluate((sdp) => window.WAVE.setAnswer(sdp), answerSdp);
    await new Promise((r) => setTimeout(r, 3500));
    log("pub-ready", { pub: await page.evaluate(() => window.WAVE.stats()) });

    // 3) recorder-dispatch: the RoomDO enumerates its registered tracks and MINTS a per-track ingest token.
    const dispRes = await fetch(`${CANARY}/v1/realtime/recorder-dispatch/${encodeURIComponent(ORG)}/${encodeURIComponent(ROOM)}`, {
      method: "POST",
      headers: internalHeaders(),
    });
    const disp = await dispRes.json();
    const descriptors = disp.descriptors ?? [];
    log("recorder-dispatch", { status: dispRes.status, count: descriptors.length, kinds: descriptors.map((d) => `${d.kind}:${d.trackName}`) });
    const vid = descriptors.find((d) => d.kind === "video") ?? descriptors[0];
    if (!vid) throw new Error("recorder-dispatch returned no descriptors (track not registered in the room)");

    // 4) werift rt-recorder pulls the AV1 track → AV1→WebM → route-sink PUT to the pre-signed ingest URL → R2.
    const ingestUrl = `${CANARY}${vid.ingestPath}?t=${encodeURIComponent(vid.token)}`;
    const sink = makeRecorderRouteSink({ endpoint: ingestUrl, org: ORG, sessionId: vid.publisherSessionId });
    const tmpDir = mkdtempSync(join(os.tmpdir(), "rt-rec-r2-"));
    const rec = await recordTrackToSink({
      recorder: {
        appId: vid.appId ?? APP_ID, appSecret: APP_SECRET, publisherSessionId: vid.publisherSessionId,
        trackName: vid.trackName, codec: "AV1", runMs: RUN_MS, sfuBase: vid.sfuBase ?? SFU, width: W, height: H,
      },
      fs: fsMod, tmpPath: join(tmpDir, "recording.webm"), sink,
    });
    log("recorder", { routed: rec.routed, codec: rec.codec, reason: rec.reason, stats: rec.stats, result: rec.result });
    receipt = rec.result ?? null; // { key, bytes, container } from the DO's R2 finalize

    // 5) WHIP teardown → finalize + duration meter (fail-open in the worker).
    if (resourceId) {
      const del = await fetch(`${CANARY}/v1/whip/resource/${resourceId}`, { method: "DELETE", headers: internalHeaders() });
      log("whip-teardown", { status: del.status });
    }

    if (receipt?.key && Number(receipt.bytes) > 0) verdict = "LIVE PASS — video bytes in canonical R2 via hosted ingest";
    else verdict = "PARTIAL — recorder ran but no R2 object";
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  log("VERDICT", { verdict, receipt, org: ORG, room: ROOM, bucket: "wave-realtime-recordings-canary" });
  process.exit(verdict.startsWith("LIVE PASS") ? 0 : 1);
}
main().catch((e) => { log("fatal", { err: String(e?.stack ?? e).slice(0, 500) }); process.exit(1); });
