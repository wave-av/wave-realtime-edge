// #81 harness — real-media e2e orchestrator. LEG 1: a real flowing participant → agent bind → prove the
// egress adapter create SUCCEEDS (the exact thing that returned 503 from a synthetic curl last session,
// because no real track was publishing). Legs 2 (subscribe to the agent track) + 3 (content/meter asserts)
// build on this.
//
// Run: doppler run --project wave --config prd -- node harness/e2e.mjs
// Needs: CF_CALLS_APP_ID, CF_CALLS_APP_SECRET (SFU app), WAVE_REALTIME_INTERNAL_SECRET (gateway-trust seal).
//        Never logged. EDGE_BASE defaults to the live rt.wave.online.

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
const ROOM = process.env.HARNESS_ROOM ?? `room-${Date.now()}`;
const AGENT_ID = process.env.HARNESS_AGENT ?? "a1";

const log = (msg, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
const die = (m) => { console.error(`E2E FAIL: ${m}`); process.exit(1); };

if (!/^[0-9a-f]{32,}$/i.test(APP_ID)) die("CF_CALLS_APP_ID missing");
if (!APP_SECRET) die("CF_CALLS_APP_SECRET missing");
if (!SEAL) die("WAVE_REALTIME_INTERNAL_SECRET missing (gateway-trust seal for bind)");

async function bindAgent({ sessionId, trackName }) {
  // The edge dispatch (worker AGENT_DISPATCH_ROUTE) gates on x-wave-internal (gatewayGate) + reads org from
  // x-wave-org, then forwards to the room-scoped AgentSessionDO /bind with {config, org}. A 200 with adapter
  // ids means: auth ✓ → DO ✓ → config ✓ → BOTH the egress (subscribe) + ingest (publish) adapters created.
  const res = await fetch(`${EDGE_BASE}/v1/realtime/agents/bind`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wave-internal": SEAL, "x-wave-org": ORG },
    body: JSON.stringify({ config: { roomId: ROOM, agentId: AGENT_ID, participantSessionId: sessionId, participantTrackName: trackName } }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function main() {
  log("e2e-start", { org: ORG, room: ROOM, agentId: AGENT_ID, edge: EDGE_BASE });

  // #28 endpointed fixture: phrase.wav (~2.6s speech) + ~1.6s of low-level (-45dBFS) noise. The noise reads BELOW
  // the VAD rms threshold (speech-end fires) yet is non-zero so Opus keeps emitting packets — frames keep flowing
  // to the DO during the silence so the hangover actually trips (digital silence + DTX would stop packets and the
  // VAD would never see the quiet frames). loops=-1 (continuous) keeps frames flowing the whole run; each loop is
  // speech → silence → speech-end → ONE STT → turn → TTS publishes RTP before the next phrase can barge in.
  const pub = await createPublisher({
    sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET,
    wavPath: join(HERE, "fixtures", "phrase-endpointed.wav"), loops: -1, log,
  });
  log("publisher-created", { sessionId: pub.sessionId, trackName: pub.trackName });

  const ok = await pub.connected();
  if (!ok) { await pub.stop(); die("publisher PeerConnection did not connect"); }
  log("publisher-connected", {});

  // Let real Opus media flow so the SFU sees the track sending before the agent subscribes (createEgress
  // retries on not_found_track, but giving media a head start makes the bind deterministic).
  await new Promise((r) => setTimeout(r, 2500));
  log("publisher-flowing", { rtpSent: pub.rtpSent() });
  if (pub.rtpSent() === 0) { await pub.stop(); die("no RTP flowed from ffmpeg → werift (media path broken)"); }

  // LEG 1 assertion: bind the agent to the REAL participant track → egress + ingest adapters create.
  const bind = await bindAgent({ sessionId: pub.sessionId, trackName: pub.trackName });
  log("bind-result", { status: bind.status, body: bind.json ?? bind.text.slice(0, 300) });

  // Leg 1 PASS = bind 200 + ok. openAdapters does NOT throw only if BOTH the egress + ingest creates returned
  // 200 from CF (a failed create throws SfuAdapterError → the DO returns 502). So a 200 here proves both
  // adapters created — the 503 boundary is closed. (egressAdapterId/ingestAdapterId are surfaced only when the
  // worker parses CF's per-track adapterId; CF nests it under tracks[].adapterId — telemetry follow-up.)
  let result = "FAIL";
  if (bind.status === 200 && bind.json?.ok) {
    result = "PASS";
    log("LEG1-PASS", {
      bound: bind.json.bound,
      egressAdapterId: bind.json.egressAdapterId ?? "(not surfaced — telemetry follow-up)",
      ingestAdapterId: bind.json.ingestAdapterId ?? "(not surfaced — telemetry follow-up)",
      note: "bind 200 ⇒ egress (subscribe participant) + ingest (publish agent) adapters BOTH created — 503 CLOSED",
    });
  } else {
    log("LEG1-FAIL", { status: bind.status, body: bind.json ?? bind.text.slice(0, 300) });
  }

  // LEG 2: subscribe to the agent's published track and prove it SPEAKS back. The DO publishes agent-<id> as a
  // LOCAL track on the participant's session, so we pull it as a REMOTE track keyed by (participantSessionId,
  // agentTrackName). Keep the publisher flowing so the agent has input to transcribe → answer → speak.
  let leg2 = "SKIP";
  if (result === "PASS") {
    const agentTrackName = bind.json.bound?.agentTrackName ?? `agent-${AGENT_ID}`;
    try {
      const sub = await createSubscriber({
        sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET,
        remoteSessionId: pub.sessionId, agentTrackName, log,
      });
      const subOk = await sub.connected();
      log("subscriber-connected", { ok: subOk });

      // Wait for the agent's reply audio to flow back. The turn loop (STT→LLM→TTS) was observed taking up to
      // ~20s, so poll up to 35s for the first RTP on the agent track.
      const startWait = Date.now();
      const DEADLINE_MS = 35000;
      while (sub.rtpRecv() === 0 && Date.now() - startWait < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const ttfb = sub.firstRtpMs() ? sub.firstRtpMs() - startWait : -1;
      // Let a little more audio accumulate for a duration signal.
      if (sub.rtpRecv() > 0) await new Promise((r) => setTimeout(r, 3000));

      if (sub.rtpRecv() > 0) {
        leg2 = "PASS";
        log("LEG2-PASS", {
          agentTrackName, rtpRecv: sub.rtpRecv(), timeToFirstAgentAudioMs: ttfb,
          opusPayloadsCaptured: sub.payloads().length,
          note: "agent track flowed RTP back ⇒ ingest half proven: STT→LLM→TTS→publish reaches the subscriber",
        });
      } else {
        log("LEG2-FAIL", { agentTrackName, waitedMs: Date.now() - startWait, note: "no RTP on agent track within deadline" });
      }
      await sub.stop();
    } catch (e) {
      log("LEG2-ERROR", { message: (e?.stack || String(e)).slice(0, 400) });
      leg2 = "ERROR";
    }
  }

  await pub.stop();
  const overall = result === "PASS" && leg2 === "PASS" ? "PASS" : result === "PASS" ? "PARTIAL" : "FAIL";
  log("e2e-done", { leg1: result, leg2, overall });
  process.exit(overall === "PASS" ? 0 : overall === "PARTIAL" ? 3 : 2);
}

main().catch((e) => die(e?.stack || String(e)));
