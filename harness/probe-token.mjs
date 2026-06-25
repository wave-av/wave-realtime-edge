// #81 — confirm the egress-503 fix direction: with a VALID capability token on the endpoint, does CF's
// websocket handshake succeed (→ adapter creates)? Mirrors mintRecorderToken (HMAC-SHA256, base64url, no pad).
// Run: doppler run --project wave --config prd -- node harness/probe-token.mjs
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublisher } from "./lib-publisher.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SFU_BASE = process.env.SFU_API_BASE ?? "https://rtc.live.cloudflare.com/v1";
const APP_ID = process.env.CF_CALLS_APP_ID ?? "";
const APP_SECRET = process.env.CF_CALLS_APP_SECRET ?? "";
const SEAL = process.env.WAVE_REALTIME_INTERNAL_SECRET ?? "";
const log = (msg, f = {}) => console.log(JSON.stringify({ msg, ...f }));

function mintToken(secret, org, sessionId, trackName, ttlSec = 7200) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac("sha256", secret).update(`${org}.${sessionId}.${trackName}.${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

async function main() {
  if (!SEAL) { console.error("WAVE_REALTIME_INTERNAL_SECRET missing"); process.exit(1); }
  const pub = await createPublisher({ sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET, wavPath: join(HERE, "fixtures", "phrase.wav"), log });
  await pub.connected();
  await new Promise((r) => setTimeout(r, 2500));
  const org = "harness", room = "room", track = pub.trackName;
  const tok = mintToken(SEAL, org, pub.sessionId, track);
  const endpoint = `wss://rt.wave.online/v1/realtime/agents/egress/${org}/${room}/${pub.sessionId}/${track}?t=${tok}`;
  log("flowing", { sessionId: pub.sessionId, track, rtp: pub.rtpSent() });

  const res = await fetch(`${SFU_BASE}/apps/${APP_ID}/adapters/websocket/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${APP_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: [{ location: "remote", sessionId: pub.sessionId, trackName: track, endpoint, outputCodec: "pcm" }] }),
  });
  const text = await res.text();
  log("websocket/new(valid-token)", { status: res.status, body: text.slice(0, 500) });
  const handshakeOk = res.ok && !/handshake|errorCode/i.test(text);
  log(handshakeOk ? "FIX-CONFIRMED" : "STILL-FAILING", { handshakeOk });

  await pub.stop();
  process.exit(handshakeOk ? 0 : 2);
}
main().catch((e) => { console.error(e); process.exit(1); });
