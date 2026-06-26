// #29 ISOLATION PROBE — does our createSubscriber receive RTP from a KNOWN-GOOD track?
//
// The agent track (agent-a1) shows 0 RTP at the subscriber even after the published-session fix. Before chasing
// an edge-side cause (mono/stereo), prove the SUBSCRIBER + CF Calls remote-pull mechanics themselves work: point
// createSubscriber at the PUBLISHER's OWN track (which is definitely sending — the publisher streams ~50 RTP/s).
//   • RTP flows here  ⇒ subscriber is GOOD ⇒ the agent track genuinely has no playable media (edge-side: mono vs
//                       stereo buffer-mode, etc.).
//   • 0 RTP here too  ⇒ the subscriber / pull path is the bug (harness-side, no deploy needed).
//
// Pure diagnostic. No bind, no agent — just publisher → SFU → subscriber loopback on the same track.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublisher } from "./lib-publisher.mjs";
import { createSubscriber } from "./lib-subscriber.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SFU_BASE = process.env.SFU_API_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.CF_CALLS_APP_ID ?? "";
const APP_SECRET = process.env.CF_CALLS_APP_SECRET ?? "";

const log = (msg, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
const die = (m) => { log("PROBE-FATAL", { error: m }); process.exit(1); };

if (!APP_ID || !APP_SECRET) die("CF_CALLS_APP_ID/SECRET missing (run via doppler)");

const pub = await createPublisher({
  sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET,
  wavPath: join(HERE, "fixtures", "phrase-endpointed.wav"), loops: -1, log,
});
if (!(await pub.connected())) die("publisher did not connect");
await new Promise((r) => setTimeout(r, 2500));
log("publisher-flowing", { rtpSent: pub.rtpSent() });

// Subscribe to the PUBLISHER'S OWN track — a known-good, actively-sending remote track.
const sub = await createSubscriber({
  sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET,
  remoteSessionId: pub.sessionId, agentTrackName: pub.trackName, log,
});
log("subscriber-connected", { ok: await sub.connected() });

const start = Date.now();
while (sub.rtpRecv() === 0 && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 2000));

const recv = sub.rtpRecv();
log(recv > 0 ? "PROBE-PASS" : "PROBE-FAIL", {
  rtpRecv: recv,
  ttfbMs: sub.firstRtpMs() ? sub.firstRtpMs() - start : -1,
  verdict: recv > 0
    ? "subscriber+pull GOOD → agent-track 0-RTP is EDGE-SIDE (mono/stereo buffer-mode)"
    : "subscriber/pull is the bug → fix lib-subscriber (no deploy needed)",
});
await sub.stop(); await pub.stop();
process.exit(0);
