// #81 / #31 Leg 4 — BARGE-IN latency receipt. Proves the LIVE agent stops talking when the user speaks over it,
// and measures how fast (<300ms target).
//
// The barge-in code is merged & live (src/agent-turn.ts bargeIn(): a VAD speech-start while a turn is in flight
// aborts the in-flight LLM/TTS → the agent goes silent). The VAD only emits a fresh speech-start AFTER a silence
// (speech-end), so a real barge-in is: utterance #1 → the agent endpoints it & starts replying → the user STOPS,
// then speaks over the agent. We reproduce exactly that, end to end, against the deployed edge:
//   1. publish utterance #1 (phrase + low-level noise tail) ONCE → the agent VAD speech-ends → runs a turn,
//   2. bind the agent, subscribe to agent-<id>, WAIT until the agent's RTP is actively flowing (it's SPEAKING),
//   3. BARGE: re-arm a fresh loud utterance on the SAME participant track (bargeSwap) → a fresh VAD onset →
//      speech-start → bargeIn() aborts the turn → the agent's RTP STOPS,
//   4. measure latency = (last agent RTP packet observed) − (first barge packet actually sent). This is the
//      HONEST END-TO-END number: it includes the up/down network RTT (harness↔SFU↔agent) and the VAD onset
//      debounce (~40ms). The agent's INTERNAL detection is also logged server-side as `agent-turn-interrupt`
//      (framesToAbort) — query CF observability for it to corroborate (printed at the end with the room/agent ids).
//
// t0 is anchored to the FIRST barge packet leaving ffmpeg (rtpSent crossing its post-utterance plateau), NOT the
// bargeSwap() call — ffmpeg spawn latency (~100-300ms) would otherwise inflate the measurement.
//
// Run: doppler run --project wave --config prd -- node harness/leg4-bargein.mjs
// Needs: CF_CALLS_APP_ID, CF_CALLS_APP_SECRET, WAVE_REALTIME_INTERNAL_SECRET (bind). Secrets referenced, never logged.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublisher } from "./lib-publisher.mjs";
import { createSubscriber } from "./lib-subscriber.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SFU_BASE = process.env.SFU_API_BASE ?? "https://rtc.live.cloudflare.com/v1";
const EDGE_BASE = process.env.EDGE_BASE ?? "https://rt.wave.online";
const APP_ID = process.env.CF_CALLS_APP_ID ?? "";
const APP_SECRET = process.env.CF_CALLS_APP_SECRET ?? "";
const SEAL = process.env.WAVE_REALTIME_INTERNAL_SECRET ?? "";

const ORG = process.env.HARNESS_ORG ?? "harness";
const ROOM = process.env.HARNESS_ROOM ?? `room-barge-${Date.now()}`;
const AGENT_ID = process.env.HARNESS_AGENT ?? "b1";
const TARGET_MS = Number(process.env.BARGE_TARGET_MS ?? 300);

const log = (msg, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
const die = (m) => { log("LEG4-FATAL", { error: m }); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!/^[0-9a-f]{32,}$/i.test(APP_ID)) die("CF_CALLS_APP_ID missing");
if (!APP_SECRET) die("CF_CALLS_APP_SECRET missing");
if (!SEAL) die("WAVE_REALTIME_INTERNAL_SECRET missing (bind seal)");

async function bindAgent({ sessionId, trackName }) {
  const res = await fetch(`${EDGE_BASE}/v1/realtime/agents/bind`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wave-internal": SEAL, "x-wave-org": ORG },
    body: JSON.stringify({ config: { roomId: ROOM, agentId: AGENT_ID, participantSessionId: sessionId, participantTrackName: trackName } }),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** Poll `read()` every 20ms until it changes from `from`, or `timeoutMs` elapses. Returns { at, value } or null. */
async function waitForChange(read, from, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = read();
    if (v !== from) return { at: Date.now(), value: v };
    await sleep(20);
  }
  return null;
}

async function main() {
  const phrase = join(HERE, "fixtures", "phrase-endpointed.wav");
  const bed = join(HERE, "fixtures", "silence-bed.wav");
  log("leg4-start", { org: ORG, room: ROOM, agentId: AGENT_ID, edge: EDGE_BASE, targetMs: TARGET_MS });

  // 1. Start on the SILENCE BED (faint noise, < VAD threshold), looped. This keeps RTP frames flowing on the
  //    participant track at ALL times (like a real mic) — essential so the VAD can transition speaking→silence
  //    between utterances and arm a FRESH onset for the barge. The agent's egress adapter subscribes post-bind,
  //    so we must keep the track alive THEN play utterance #1 (otherwise the agent never hears it).
  const pub = await createPublisher({
    sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET, wavPath: bed, loops: -1, log,
  });
  if (!(await pub.connected())) { await pub.stop(); die("publisher did not connect"); }
  await sleep(1500);
  if (pub.rtpSent() === 0) { await pub.stop(); die("no RTP from publisher (bed)"); }

  // 2. Bind the agent and subscribe to its track WHILE the bed flows.
  const bind = await bindAgent({ sessionId: pub.sessionId, trackName: pub.trackName });
  log("bind-result", { status: bind.status, ok: bind.json?.ok });
  if (bind.status !== 200 || !bind.json?.ok) { await pub.stop(); die(`bind failed: ${bind.status}`); }
  const agentTrackName = bind.json.bound?.agentTrackName ?? `agent-${AGENT_ID}`;
  const agentSessionId = bind.json.agentSessionId ?? pub.sessionId;
  const sub = await createSubscriber({
    sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET,
    remoteSessionId: agentSessionId, agentTrackName, log,
  });
  await sub.connected();
  await sleep(1500); // let the egress subscription settle; the agent now hears the bed (silence)

  // 3. UTTERANCE #1 — play the phrase ONCE so the agent hears it, endpoints it (noise tail → speech-end), and
  //    runs a turn. Then return to the bed so silence frames keep flowing (VAD speaking→speech-end→silence).
  log("utterance1-play", {});
  pub.bargeSwap(phrase, 0);
  await sleep(4300); // phrase-endpointed.wav ≈ 4.18s — let it finish
  pub.bargeSwap(bed, -1); // back to the silence bed while the agent computes + speaks its reply

  // 4. WAIT until the agent is actively SPEAKING (RTP flowing + climbing). The bed has been flowing throughout, so
  //    by the time the agent replies (~2-3s of STT/LLM/TTS) the VAD has long since endpointed to silence → armed.
  const waitStart = Date.now();
  while (sub.rtpRecv() === 0 && Date.now() - waitStart < 40000) await sleep(200);
  if (sub.rtpRecv() === 0) { await sub.stop(); await pub.stop(); die("agent never spoke (0 RTP within 40s) — nothing to barge"); }
  const climb0 = sub.rtpRecv();
  await sleep(400);
  const climb1 = sub.rtpRecv();
  log("agent-speaking", { rtpAt0: climb0, rtpAfter400ms: climb1, deltaPkts: climb1 - climb0 });
  if (climb1 - climb0 < 3) { await sub.stop(); await pub.stop(); die("agent RTP not actively flowing — reply ended before barge"); }

  // 5. BARGE — swap from the bed to a fresh loud phrase on the SAME track. A fresh VAD onset (the agent's turn is
  //    in flight) → speech-start → bargeIn() aborts the turn. Anchor t0 to the first BARGE packet: the swap kills
  //    the bed ffmpeg (rtpSent freezes after stragglers drain), then the phrase ffmpeg resumes it. We drain 40ms
  //    so the bed's in-flight packets settle, snapshot the plateau, then wait for the resume = first barge packet.
  pub.bargeSwap(phrase, 0);
  await sleep(40);
  const plateau = pub.rtpSent();
  const firstBarge = await waitForChange(() => pub.rtpSent(), plateau, 4000);
  if (!firstBarge) { await sub.stop(); await pub.stop(); die("barge audio never started (ffmpeg failed to emit)"); }
  const t0 = firstBarge.at; // first barge RTP left ffmpeg → the user has begun speaking over the agent
  log("barge-fired", { t0Iso: new Date(t0).toISOString(), rtpSentAtBarge: firstBarge.value });

  // 5. Measure the STOP: sample the agent RTP count every 20ms; the agent's last packet before a sustained plateau
  //    (≥250ms unchanged) is the moment it went silent. latency = lastAgentPacket − t0.
  let lastCount = sub.rtpRecv();
  let lastChangeAt = Date.now();
  let stopAt = 0;
  const QUIET_MS = 250;
  const CAP_MS = 4000; // the agent will re-reply to the barge utterance seconds later; cap before that resumption
  const loopStart = Date.now();
  while (Date.now() - loopStart < CAP_MS) {
    await sleep(20);
    const c = sub.rtpRecv();
    if (c !== lastCount) { lastCount = c; lastChangeAt = Date.now(); continue; }
    if (Date.now() - lastChangeAt >= QUIET_MS && lastChangeAt > t0) { stopAt = lastChangeAt; break; }
  }

  const finalCount = sub.rtpRecv();
  await sub.stop();
  await pub.stop();

  const latencyMs = stopAt ? stopAt - t0 : -1;
  const stopped = stopAt > 0;
  // GATE: the agent was speaking, then went silent after the barge, within the target.
  const gateSpoke = climb1 - climb0 >= 3;
  const gateStopped = stopped;
  const gateLatency = stopped && latencyMs >= 0 && latencyMs < TARGET_MS;
  const overall = gateSpoke && gateStopped && gateLatency ? "PASS" : gateSpoke && gateStopped ? "OVER-TARGET" : "FAIL";

  log("LEG4-DONE", {
    overall,
    bargeInLatencyMs: latencyMs,
    targetMs: TARGET_MS,
    gateSpoke, gateStopped, gateLatency,
    agentRtpBeforeBarge: climb1,
    agentRtpAtStop: lastCount,
    agentRtpFinal: finalCount,
    room: ROOM, agentId: AGENT_ID, org: ORG,
    note: "latency = first-barge-packet → last-agent-packet (END-TO-END: incl. up/down network RTT + ~40ms VAD onset debounce). " +
      "Corroborate the agent's INTERNAL detection via CF observability: msg='agent-turn-interrupt' filtered to this room/agentId (framesToAbort).",
    observabilityHint: `query_worker_observability: msg="agent-turn-interrupt" AND agentId="${AGENT_ID}" AND room="${ROOM}"`,
  });
  process.exit(overall === "FAIL" ? 2 : 0);
}

main().catch((e) => die(e?.stack || String(e)));
