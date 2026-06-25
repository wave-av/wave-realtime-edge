// #81 harness — DECISIVE compatibility spike: can werift (Node WebRTC) negotiate with the CF Realtime SFU?
//
// This is the single most important thing to learn before building the full publisher/subscriber/orchestrator
// rig: does CF Realtime's `/sessions/new` accept a werift-generated SDP offer and return an answer, and does
// ICE/DTLS actually connect? If yes, the werift-direct-to-SFU design is viable (and it RETURNS the sessionId +
// trackName the agent bind needs — the WHIP path hides those). If no, the stack flips to headless-browser.
//
// Run: doppler run --project wave --config prd -- node harness/spike-signaling.mjs
// Needs: CF_CALLS_APP_ID, CF_CALLS_APP_SECRET (CF Realtime SFU app creds; Doppler wave/prd). Never logs them.

import { RTCPeerConnection, MediaStreamTrack } from "werift";

const SFU_BASE = process.env.SFU_API_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.CF_CALLS_APP_ID ?? "";
const APP_SECRET = process.env.CF_CALLS_APP_SECRET ?? "";

function die(msg) {
  console.error(`SPIKE FAIL: ${msg}`);
  process.exit(1);
}
if (!/^[0-9a-f]{32,}$/i.test(APP_ID)) die("CF_CALLS_APP_ID missing/invalid (expected hex app id)");
if (!APP_SECRET) die("CF_CALLS_APP_SECRET missing");

/** Wait until ICE gathering completes or `ms` elapses (CF wants a non-trickle offer with candidates inline). */
function waitIceGatheringComplete(pc, ms = 3000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    const t = setTimeout(done, ms);
    pc.iceGatheringStateChange.subscribe((s) => {
      if (s === "complete") {
        clearTimeout(t);
        done();
      }
    });
  });
}

async function main() {
  console.log(`[spike] SFU base=${SFU_BASE} app=${APP_ID.slice(0, 6)}… (secret present=${!!APP_SECRET})`);

  const pc = new RTCPeerConnection();

  // A sendonly audio track — a synthetic Opus source. For the SIGNALING probe the track need not carry real
  // audio yet; we only need a valid m=audio sendonly section so CF negotiates an inbound audio track for us.
  const track = new MediaStreamTrack({ kind: "audio" });
  const transceiver = pc.addTransceiver(track, { direction: "sendonly" });

  pc.connectionStateChange.subscribe((s) => console.log(`[spike] connectionState=${s}`));
  pc.iceConnectionStateChange.subscribe((s) => console.log(`[spike] iceConnectionState=${s}`));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGatheringComplete(pc);
  const localSdp = pc.localDescription.sdp;
  console.log(`[spike] local offer built (${localSdp.length} bytes, m-lines: ${(localSdp.match(/^m=/gm) || []).length})`);

  // POST the offer to CF Realtime sessions/new (same shape sfu.ts uses: { sessionDescription: {type, sdp} }).
  const res = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionDescription: { type: "offer", sdp: localSdp } }),
  });
  const bodyText = await res.text();
  console.log(`[spike] sessions/new → HTTP ${res.status}`);
  if (!res.ok) die(`sessions/new rejected: ${bodyText.slice(0, 400)}`);

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    die(`sessions/new returned non-JSON: ${bodyText.slice(0, 200)}`);
  }
  const sessionId = json.sessionId;
  const answer = json.sessionDescription;
  console.log(`[spike] sessionId=${sessionId ?? "(none)"} answerType=${answer?.type ?? "(none)"}`);
  if (!sessionId || answer?.type !== "answer" || !answer.sdp) die("no sessionId/answer in response");

  await pc.setRemoteDescription(answer);
  console.log(`[spike] remote answer applied — watching ICE/DTLS for 12s…`);

  // Register the local track so CF gives it a trackName (what the agent bind subscribes to). mid from the txr.
  const mid = transceiver.mid;
  const tracksRes = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/${sessionId}/tracks/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: [{ location: "local", mid, trackName: "harness-mic" }] }),
  });
  console.log(`[spike] tracks/new → HTTP ${tracksRes.status} ${(await tracksRes.text()).slice(0, 200)}`);

  const ok = await new Promise((resolve) => {
    // Check CURRENT state first — DTLS often connects during the tracks/new await above, and werift's
    // subscribe only fires on FUTURE transitions (the race that made the first run report a false PARTIAL).
    if (pc.connectionState === "connected") return resolve(true);
    const t = setTimeout(() => resolve(false), 12000);
    pc.connectionStateChange.subscribe((s) => {
      if (s === "connected") {
        clearTimeout(t);
        resolve(true);
      }
      if (s === "failed") {
        clearTimeout(t);
        resolve(false);
      }
    });
  });

  console.log(ok ? "SPIKE PASS: werift ↔ CF Realtime connected (DTLS up)" : "SPIKE PARTIAL: signaling OK, connection did not reach 'connected' in 12s");
  await pc.close();
  process.exit(ok ? 0 : 2);
}

main().catch((e) => die(e?.stack || String(e)));
