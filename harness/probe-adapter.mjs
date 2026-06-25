// #81 harness — diagnose the egress 503. With a REAL flowing track, call CF Realtime adapters/websocket/new
// DIRECTLY and print the FULL response (status + body + headers) the worker swallows into "returned 503".
// Run: doppler run --project wave --config prd -- node harness/probe-adapter.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublisher } from "./lib-publisher.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SFU_BASE = process.env.SFU_API_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.CF_CALLS_APP_ID ?? "";
const APP_SECRET = process.env.CF_CALLS_APP_SECRET ?? "";
const log = (msg, f = {}) => console.log(JSON.stringify({ msg, ...f }));

async function tryCreate(label, url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  log(`probe:${label}`, { status: res.status, ct: res.headers.get("content-type"), body: text.slice(0, 600) });
}

async function main() {
  const pub = await createPublisher({ sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET, wavPath: join(HERE, "fixtures", "phrase.wav"), log });
  await pub.connected();
  await new Promise((r) => setTimeout(r, 2500));
  log("flowing", { sessionId: pub.sessionId, trackName: pub.trackName, rtp: pub.rtpSent() });

  const remoteTrack = { location: "remote", sessionId: pub.sessionId, trackName: pub.trackName, endpoint: "wss://rt.wave.online/v1/realtime/agents/egress/harness/room/" + pub.sessionId + "/" + pub.trackName + "?t=probe", outputCodec: "pcm" };

  // 1) The exact call container-adapter.ts makes.
  await tryCreate("websocket/new", `${SFU_BASE}/apps/${APP_ID}/adapters/websocket/new`, { tracks: [remoteTrack] });
  // 2) Alternate documented path shapes (in case the API moved).
  await tryCreate("adapters/new", `${SFU_BASE}/apps/${APP_ID}/adapters/new`, { tracks: [remoteTrack] });
  // 3) Is the SFU app itself healthy for normal pulls? (sanity: a remote pull track via tracks/new on a 2nd session)
  const s2 = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/new`, { method: "POST", headers: { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" }, body: "{}" });
  const s2j = await s2.json().catch(() => ({}));
  log("probe:sessions/new(empty)", { status: s2.status, sessionId: s2j.sessionId });
  if (s2j.sessionId) {
    const pull = await fetch(`${SFU_BASE}/apps/${APP_ID}/sessions/${s2j.sessionId}/tracks/new`, { method: "POST", headers: { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ tracks: [{ location: "remote", sessionId: pub.sessionId, trackName: pub.trackName }] }) });
    log("probe:pull-remote-track", { status: pull.status, body: (await pull.text()).slice(0, 300) });
  }

  await pub.stop();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
