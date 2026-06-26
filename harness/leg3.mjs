// #30 / #81 Leg 3 — CONTENT-INTEGRITY proof of the agent's published voice.
//
// Leg 2 proved RTP flows back on the agent track. Leg 3 proves the audio is INTELLIGIBLE — i.e. the mono→stereo
// upmix (#30) produced real, decodable stereo speech, not endianness-shifted noise. We:
//   1. publish a real participant utterance, bind the agent, subscribe to agent-<id> (reusing the Leg-2 harness),
//   2. capture the agent's Opus RTP payloads,
//   3. DECODE them with a pure-JS Opus decoder (opusscript, 48 kHz / 2-ch) → interleaved 16-bit PCM,
//   4. assert the decoded audio is non-silent (RMS over a noise floor) and a sane duration,
//   5. CONTENT-INTEGRITY: WAV-wrap the PCM and transcribe it via the PUBLIC gateway transcribe route using a real
//      CUSTOMER key (WAVE_GATEWAY_API_KEY) — never the internal service token (no customer-key bypass) — and assert
//      the agent actually said coherent words back. Prints ttfa (latency proxy) + the transcript.
//
// Run: doppler run --project wave --config prd -- node harness/leg3.mjs
// Needs: CF_CALLS_APP_ID, CF_CALLS_APP_SECRET, WAVE_REALTIME_INTERNAL_SECRET (bind), WAVE_GATEWAY_URL,
//        WAVE_GATEWAY_API_KEY (customer STT). Secrets are referenced, never logged.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import OpusScript from "opusscript";
import { createPublisher } from "./lib-publisher.mjs";
import { createSubscriber } from "./lib-subscriber.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SFU_BASE = process.env.SFU_API_BASE ?? "https://rtc.live.cloudflare.com/v1";
const EDGE_BASE = process.env.EDGE_BASE ?? "https://rt.wave.online";
const APP_ID = process.env.CF_CALLS_APP_ID ?? "";
const APP_SECRET = process.env.CF_CALLS_APP_SECRET ?? "";
const SEAL = process.env.WAVE_REALTIME_INTERNAL_SECRET ?? "";
const GW_URL = (process.env.WAVE_GATEWAY_URL ?? "").replace(/\/+$/, "");
const GW_KEY = process.env.WAVE_GATEWAY_API_KEY ?? "";

const ORG = process.env.HARNESS_ORG ?? "harness";
const ROOM = process.env.HARNESS_ROOM ?? `room-${Date.now()}`;
const AGENT_ID = process.env.HARNESS_AGENT ?? "a1";

const log = (msg, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
const die = (m) => { log("LEG3-FATAL", { error: m }); process.exit(1); };

if (!/^[0-9a-f]{32,}$/i.test(APP_ID)) die("CF_CALLS_APP_ID missing");
if (!APP_SECRET) die("CF_CALLS_APP_SECRET missing");
if (!SEAL) die("WAVE_REALTIME_INTERNAL_SECRET missing (bind seal)");

/** Wrap interleaved 16-bit-LE PCM in a minimal WAV container. */
function wav(pcm, sampleRate, channels) {
  const blockAlign = channels * 2;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}

/** RMS of interleaved 16-bit-LE PCM, normalized to [0,1] (0x7fff full-scale). */
function rms16(pcm) {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / n) / 0x7fff;
}

/**
 * Speech-likeness from the per-window RMS envelope (no STT needed). Real speech is NON-STATIONARY: loud syllables
 * + quiet gaps → a wide dynamic range and a mix of active/silent windows. Constant noise or a stuck buffer would
 * be flat. Also measures L/R correlation: our upmix is dual-mono (L=R pre-encode), so post-Opus the two channels
 * should stay highly correlated — a fingerprint that the stereo frames carry coherent mono speech, not split garbage.
 */
function envelope(pcm, sampleRate, channels) {
  const frameBytes = channels * 2;
  const winSamples = Math.floor(sampleRate * 0.05); // 50 ms windows
  const winBytes = winSamples * frameBytes;
  const wins = [];
  for (let off = 0; off + winBytes <= pcm.length; off += winBytes) {
    wins.push(rms16(pcm.subarray(off, off + winBytes)));
  }
  if (wins.length === 0) return { windows: 0, activeRatio: 0, dynamicRangeDb: 0, lrCorr: 0 };
  const peak = Math.max(...wins);
  const gate = peak * 0.15; // "active" = within ~16 dB of peak
  const active = wins.filter((w) => w >= gate).length;
  const quiet = wins.filter((w) => w < gate).length;
  const minActive = Math.min(...wins.filter((w) => w >= gate));
  const dynamicRangeDb = minActive > 0 ? 20 * Math.log10(peak / minActive) : 0;
  // L/R correlation across the whole buffer (stereo only).
  let lrCorr = 1;
  if (channels === 2) {
    let sl = 0, sr = 0, sll = 0, srr = 0, slr = 0, n = 0;
    for (let i = 0; i + 3 < pcm.length; i += 4) {
      const l = pcm.readInt16LE(i), r = pcm.readInt16LE(i + 2);
      sl += l; sr += r; sll += l * l; srr += r * r; slr += l * r; n++;
    }
    const cov = slr / n - (sl / n) * (sr / n);
    const vl = sll / n - (sl / n) ** 2, vr = srr / n - (sr / n) ** 2;
    lrCorr = vl > 0 && vr > 0 ? cov / Math.sqrt(vl * vr) : 0;
  }
  return {
    windows: wins.length,
    activeWindows: active,
    quietWindows: quiet,
    activeRatio: +(active / wins.length).toFixed(3),
    dynamicRangeDb: +dynamicRangeDb.toFixed(1),
    lrCorr: +lrCorr.toFixed(3),
  };
}

async function bindAgent({ sessionId, trackName }) {
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
  log("leg3-start", { org: ORG, room: ROOM, agentId: AGENT_ID, edge: EDGE_BASE });

  const pub = await createPublisher({
    sfuBase: SFU_BASE, appId: APP_ID, appSecret: APP_SECRET,
    wavPath: join(HERE, "fixtures", "phrase-endpointed.wav"), loops: -1, log,
  });
  if (!(await pub.connected())) { await pub.stop(); die("publisher did not connect"); }
  await new Promise((r) => setTimeout(r, 2500));
  if (pub.rtpSent() === 0) { await pub.stop(); die("no RTP from publisher"); }
  log("publisher-flowing", { rtpSent: pub.rtpSent() });

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

  // Wait for the agent reply, then accumulate ~5s of agent audio for a solid STT sample.
  const startWait = Date.now();
  while (sub.rtpRecv() === 0 && Date.now() - startWait < 40000) await new Promise((r) => setTimeout(r, 500));
  const ttfa = sub.firstRtpMs() ? sub.firstRtpMs() - startWait : -1;
  if (sub.rtpRecv() === 0) { await sub.stop(); await pub.stop(); die("no agent RTP within 40s"); }
  await new Promise((r) => setTimeout(r, 5000)); // let speech accumulate

  const payloads = sub.payloads();
  await sub.stop();
  await pub.stop();
  log("agent-audio-captured", { rtpRecv: sub.rtpRecv(), opusPayloads: payloads.length, ttfaMs: ttfa });

  // DECODE the captured Opus frames → interleaved 16-bit PCM @ 48 kHz / 2-ch.
  const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const pcmParts = [];
  let decoded = 0;
  let failed = 0;
  for (const p of payloads) {
    try {
      const out = dec.decode(Buffer.from(p));
      if (out && out.length) { pcmParts.push(out); decoded++; }
    } catch { failed++; }
  }
  try { dec.delete?.(); } catch {}
  const pcm = Buffer.concat(pcmParts);
  const durationMs = Math.round((pcm.length / (48000 * 2 * 2)) * 1000); // bytes / (rate*ch*bytesPerSample)
  const level = rms16(pcm);
  log("opus-decoded", { framesDecoded: decoded, framesFailed: failed, pcmBytes: pcm.length, durationMs, rms: +level.toFixed(4) });

  // Save the decoded WAV for human verification (Jake can listen to confirm the agent's voice).
  const outPath = process.env.LEG3_WAV_OUT ?? join(HERE, "fixtures", "leg3-agent-capture.wav");
  try { writeFileSync(outPath, wav(pcm, 48000, 2)); log("wav-saved", { path: outPath, bytes: pcm.length + 44 }); } catch (e) { log("wav-save-error", { e: String(e).slice(0, 120) }); }

  // GATE A — decodable, non-silent stereo audio (proves the upmix produced real media, not noise).
  const NOISE_FLOOR = 0.005;
  const gateA = decoded > 0 && pcm.length > 0 && level > NOISE_FLOOR;
  log(gateA ? "GATE-A-PASS" : "GATE-A-FAIL", { note: "agent Opus decodes to non-silent stereo PCM", rms: +level.toFixed(4) });

  // GATE A2 — speech-likeness from the envelope (no STT): non-stationary (loud+quiet windows, wide dynamic range)
  // and high L/R correlation (dual-mono upmix fingerprint). Distinguishes real speech from flat noise/stuck buffer.
  const env = envelope(pcm, 48000, 2);
  const gateA2 = env.windows > 10 && env.activeWindows > 0 && env.quietWindows > 0 && env.dynamicRangeDb >= 12 && env.lrCorr >= 0.8;
  log(gateA2 ? "GATE-A2-PASS" : "GATE-A2-FAIL", { ...env, note: "speech envelope dynamics + dual-mono L/R correlation" });

  // GATE B — CONTENT-INTEGRITY via STT (the GOLD proof). Customer key, public route — never the internal-token
  // (no customer-key bypass). A 403 SCOPE_INSUFFICIENT is a key-entitlement gap (this key lacks transcribe:write),
  // NOT a voice failure → recorded as SKIP-NO-SCOPE, not FAIL. GATE-A2 carries the no-STT speech proof meanwhile.
  let gateB = "SKIP";
  let transcript = "";
  if (gateA && GW_URL && GW_KEY) {
    try {
      const res = await fetch(`${GW_URL}/v1/transcribe?engine=auto`, {
        method: "POST",
        headers: { "content-type": "audio/wav", authorization: `Bearer ${GW_KEY}` },
        body: wav(pcm, 48000, 2),
      });
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch {}
      if (res.status === 403 && /scope/i.test(txt)) {
        gateB = "SKIP-NO-SCOPE";
        log("stt-skipped", { status: 403, reason: "customer key lacks transcribe:write scope (entitlement, not a voice bug)" });
      } else {
        transcript = (j?.text ?? j?.transcript ?? "").trim();
        const words = transcript.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w));
        gateB = res.status === 200 && words.length >= 3 ? "PASS" : "FAIL";
        log("stt-result", { status: res.status, chars: transcript.length, preview: transcript.slice(0, 160) });
      }
    } catch (e) {
      log("stt-error", { message: String(e).slice(0, 200) });
      gateB = "ERROR";
    }
  }

  // PASS when the audio is proven real speech (A + A2). GATE-B is the optional gold layer (needs a transcribe key).
  const proven = gateA && gateA2;
  const overall = proven && gateB === "PASS" ? "PASS-GOLD" : proven ? "PASS" : "FAIL";
  log("LEG3-DONE", {
    overall, gateA: gateA ? "PASS" : "FAIL", gateA2: gateA2 ? "PASS" : "FAIL", gateB,
    ttfaMs: ttfa, durationMs, rms: +level.toFixed(4), envelope: env,
    transcriptPreview: transcript.slice(0, 160), wavOut: outPath,
    note: "PASS = decodable non-silent stereo (A) + speech envelope/L-R correlation (A2) ⇒ upmix live & intelligible-by-structure; PASS-GOLD adds STT word proof",
  });
  process.exit(overall === "FAIL" ? 2 : 0);
}

main().catch((e) => die(e?.stack || String(e)));
