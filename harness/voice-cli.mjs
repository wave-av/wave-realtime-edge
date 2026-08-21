#!/usr/bin/env node
/**
 * voice-cli.mjs — the headless voice-agent CLI (the local / on-prem / cloud rendering).
 *
 * Drives the FULL duplex loop with NO browser and NO WebRTC: bind in headless mode, stream a WAV's PCM
 * over the audio-in WS, receive the agent's TTS over the TTS WS, and write it to an output WAV.
 *
 * Usage: node harness/voice-cli.mjs --room <room> --audio in.wav [--out out.wav] [--agent voice-agent]
 * Env:   WAVE_INTERNAL_SECRET (bind seal) · EDGE_BASE (default https://rt.wave.online) · HARNESS_ORG
 *
 * The input WAV must be 16-bit LE PCM (48 kHz, mono or stereo — mono is upmixed L=R). Each PCM chunk is
 * Packet-framed (proto3 {seq, ts, payload}) exactly as the egress path the audio-in replaces.
 */

import { readFileSync, writeFileSync } from "node:fs";

const EDGE_BASE = (process.env.EDGE_BASE ?? "https://rt.wave.online").replace(/\/+$/, "");
const SEAL = process.env.WAVE_INTERNAL_SECRET ?? "";
const ORG = process.env.HARNESS_ORG ?? "harness";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean),
);
const ROOM = args.room ?? "";
const AGENT_ID = args.agent ?? "voice-agent";
const AUDIO = args.audio ?? "";
const OUT = args.out ?? "out.wav";

const log = (msg, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
const die = (m) => { log("VOICE-CLI-FATAL", { error: m }); process.exit(1); };
if (!SEAL) die("WAVE_INTERNAL_SECRET missing (bind seal)");
if (!ROOM) die("--room is required");
if (!AUDIO) die("--audio (input WAV path) is required");

// ── proto3 Packet framing (mirrors the edge's encodeIngestFrame / decodePacket) ──
function varint(v) { const o = []; while (v >= 0x80) { o.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } o.push(v & 0x7f); return o; }
function encodePacket(payload, seq, ts) {
  const head = [...varint(0x08), ...varint(seq), ...varint(0x10), ...varint(ts), ...varint(0x2a), ...varint(payload.length)];
  return Buffer.concat([Buffer.from(head), payload]);
}
function decodePacket(frame) {
  const b = frame; let i = 0;
  while (i < b.length) {
    const tag = b[i++]; const wire = tag & 7;
    if (wire === 0) { while (i < b.length && (b[i] & 0x80) !== 0) i++; i++; }
    else if (wire === 2) {
      let len = 0, s = 0;
      while (i < b.length) { const byte = b[i++]; len |= (byte & 0x7f) << s; if ((byte & 0x80) === 0) break; s += 7; }
      if ((tag >> 3) === 5) return b.subarray(i, i + len);
      i += len;
    } else break;
  }
  return Buffer.alloc(0);
}

// ── WAV decode/encode (16-bit LE PCM) ──
function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let off = 12, channels = 1, sampleRate = 48000, bits = 16, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(off + 10); sampleRate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    if (id === "data") { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");
  return { sampleRate, channels, bits, pcm: Buffer.from(data) };
}
function encodeWav(pcm, sampleRate, channels) {
  const blockAlign = channels * 2;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + pcm.length, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}
// upmix mono 16-bit LE -> stereo interleaved (L=R), 48k assumed
function upmixMonoToStereo(mono) {
  const out = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i += 2) { out[i * 2] = mono[i]; out[i * 2 + 1] = mono[i + 1]; out[i * 2 + 2] = mono[i]; out[i * 2 + 3] = mono[i + 1]; }
  return out;
}

// ── helpers ──
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WS error connecting " + url.split("?")[0]));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const SESSIONID = () => Array.from({ length: 24 }, () => "0123456789abcdefghijklmnopqrstuvwxyz_-"[Math.floor(Math.random() * 38)]).join("");

async function bind() {
  const participantSessionId = SESSIONID();
  const res = await fetch(`${EDGE_BASE}/v1/realtime/agents/bind`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wave-internal": SEAL, "x-wave-org": ORG },
    body: JSON.stringify({ config: { roomId: ROOM, agentId: AGENT_ID, participantSessionId, participantTrackName: "mic", headless: true } }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200 || !json.ok) die(`bind failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  log("voice-cli-bound", { room: ROOM, agentId: AGENT_ID, hasAudioIn: !!json.audioInEndpoint, hasTts: !!json.ttsEndpoint });
  if (!json.audioInEndpoint || !json.ttsEndpoint) die("bind response missing audioInEndpoint or ttsEndpoint");
  return json;
}

async function main() {
  const bindJson = await bind();
  const wav = decodeWav(readFileSync(AUDIO));
  if (wav.bits !== 16) die(`input must be 16-bit PCM (got ${wav.bits}-bit)`);
  if (wav.sampleRate !== 48000) die(`input must be 48 kHz (got ${wav.sampleRate} Hz)`);
  let pcm = wav.channels === 1 ? upmixMonoToStereo(wav.pcm) : wav.pcm;

  const [audioIn, tts] = await Promise.all([connect(bindJson.audioInEndpoint), connect(bindJson.ttsEndpoint)]);
  log("voice-cli-ws-open", { pcmBytes: pcm.length });

  const outPcm = [];
  let ttsClosed = false;
  tts.onmessage = (ev) => {
    const payload = decodePacket(Buffer.from(ev.data));
    if (payload.length > 0) outPcm.push(payload);
  };
  tts.onclose = () => { ttsClosed = true; };

  // Stream the PCM in ≤32KB chunks, Packet-framed, with a monotonic 48 kHz sample timestamp.
  const CHUNK = 32000;
  let seq = 0;
  let ts = 0;
  const started = Date.now();
  const bytesPerMs = 48000 * 2 * 2 / 1000; // 48k stereo 16-bit
  for (let off = 0; off < pcm.length; off += CHUNK) {
    const chunk = pcm.subarray(off, off + CHUNK);
    try {
      audioIn.send(encodePacket(chunk, seq++, ts));
    } catch (e) {
      log("voice-cli-send-error", { error: e.message, off });
      break;
    }
    ts += Math.floor(chunk.length / 4);
    const target = (off + chunk.length) / bytesPerMs;
    const elapsed = Date.now() - started;
    if (target > elapsed) await sleep(target - elapsed);
  }
  log("voice-cli-sent", { frames: seq, readyState: audioIn.readyState });
  // Trailing silence: the VAD hangover (12 frames ≈ 2s) must see sustained quiet to fire speech-end, and the
  // WAV's own endpoint silence (≈0.5s) is shorter than that. Send ~2.5s of zero PCM so the turn endpoints.
  const silenceChunks = Math.ceil(2500 / (CHUNK / bytesPerMs));
  const zero = Buffer.alloc(CHUNK);
  for (let i = 0; i < silenceChunks; i++) {
    audioIn.send(encodePacket(zero, seq++, ts));
    ts += Math.floor(CHUNK / 4);
    await sleep(CHUNK / bytesPerMs);
  }

  // wait for the TTS to finish (or a timeout)
  const ttl = Date.now() + 60000;
  while (!ttsClosed && Date.now() < ttl) await sleep(250);

  const total = Buffer.concat(outPcm);
  writeFileSync(OUT, encodeWav(total, 48000, 2));
  log("voice-cli-done", { out: OUT, ttsPcmBytes: total.length, audioMs: Math.round(total.length / bytesPerMs) });
  process.exit(0);
}

main().catch((e) => die(e.message));
