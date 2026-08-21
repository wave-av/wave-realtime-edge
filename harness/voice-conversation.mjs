#!/usr/bin/env node
/**
 * voice-conversation.mjs — a SCRIPTED conversation driver for the headless voice agent.
 *
 * TTS each caller line (ElevenLabs), stream it to the agent over the audio-in WS, and capture the
 * agent's TTS reply over the (persistent) TTS WS — so a full multi-turn conversation can be exercised
 * without a human speaking, and without a browser. Each reply is written to <outDir>/turn-<n>.wav.
 *
 * Usage: node harness/voice-conversation.mjs --script "Hello, who are you?|What is your name?" --room X [--out /tmp/conv]
 * Env:   WAVE_INTERNAL_SECRET (bind seal) · ELEVENLABS_API_KEY · ELEVENLABS_VOICE_ID ·
 *        EDGE_BASE (default https://rt.wave.online) · HARNESS_ORG
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const EDGE = (process.env.EDGE_BASE ?? "https://rt.wave.online").replace(/\/+$/, "");
const SEAL = process.env.WAVE_INTERNAL_SECRET ?? "";
const ORG = process.env.HARNESS_ORG ?? "harness";
const EL_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const ROOM = args.room ?? "";
const LINES = (args.script ?? "").split("|").map((s) => s.trim()).filter(Boolean);
const OUTDIR = args.out ?? "/tmp/conv";

const log = (msg, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
const die = (m) => { log("CONVO-FATAL", { error: m }); process.exit(1); };
if (!SEAL) die("WAVE_INTERNAL_SECRET missing");
if (!EL_KEY) die("ELEVENLABS_API_KEY missing");
if (!EL_VOICE) die("ELEVENLABS_VOICE_ID missing");
if (!ROOM) die("--room is required");
if (LINES.length === 0) die("--script is required (pipe-separated caller lines)");

// ── proto3 Packet framing (mirrors the edge) ──
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
    else if (wire === 2) { let len = 0, s = 0; while (i < b.length) { const byte = b[i++]; len |= (byte & 0x7f) << s; if ((byte & 0x80) === 0) break; s += 7; } if ((tag >> 3) === 5) return b.subarray(i, i + len); i += len; }
    else break;
  }
  return Buffer.alloc(0);
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
function upmixMonoToStereo(mono) {
  const out = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i += 2) { out[i * 2] = mono[i]; out[i * 2 + 1] = mono[i + 1]; out[i * 2 + 2] = mono[i]; out[i * 2 + 3] = mono[i + 1]; }
  return out;
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WS connect failed"));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 32000;
const BYTES_PER_MS = 48000 * 2 * 2 / 1000;

async function tts(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=pcm_48000`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": EL_KEY, accept: "audio/pcm" },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", optimize_streaming_latency: 3 }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function bind() {
  const participantSessionId = `conv_${randomUUID()}`;
  const res = await fetch(`${EDGE}/v1/realtime/agents/bind`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wave-internal": SEAL, "x-wave-org": ORG },
    body: JSON.stringify({ config: { roomId: ROOM, agentId: "voice-agent", participantSessionId, participantTrackName: "mic", headless: true } }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200 || !json.ok || !json.audioInEndpoint || !json.ttsEndpoint) die(`bind failed ${res.status}`);
  return json;
}

/** Collect the agent's TTS reply from the persistent TTS WS: accumulate PCM frames until an idle gap.
 *  The idle gap must exceed the LLM + TTS latency (~3-6s for the first turn), so it is generous. */
function waitForReply(ttsWs, idleMs = 8000) {
  return new Promise((resolve) => {
    const chunks = [];
    let idle;
    const done = () => resolve(Buffer.concat(chunks));
    ttsWs.onmessage = (ev) => {
      const p = decodePacket(Buffer.from(ev.data));
      if (p.length > 0) { chunks.push(p); clearTimeout(idle); idle = setTimeout(done, idleMs); }
    };
    idle = setTimeout(done, idleMs);
  });
}

async function stream(audioIn, pcm, seqState) {
  const started = Date.now();
  for (let off = 0; off < pcm.length; off += CHUNK) {
    const chunk = pcm.subarray(off, off + CHUNK);
    audioIn.send(encodePacket(chunk, seqState.seq++, seqState.ts));
    seqState.ts += Math.floor(chunk.length / 4);
    const target = (off + chunk.length) / BYTES_PER_MS;
    const elapsed = Date.now() - started;
    if (target > elapsed) await sleep(target - elapsed);
  }
  const zero = Buffer.alloc(CHUNK);
  for (let i = 0; i < 15; i++) { audioIn.send(encodePacket(zero, seqState.seq++, seqState.ts)); seqState.ts += Math.floor(CHUNK / 4); await sleep(CHUNK / BYTES_PER_MS); }
}

async function main() {
  const b = await bind();
  const audioIn = await connect(b.audioInEndpoint);
  const ttsWs = await connect(b.ttsEndpoint);
  const seqState = { seq: 0, ts: 0 };
  log("convo-start", { turns: LINES.length, room: ROOM });
  for (let i = 0; i < LINES.length; i++) {
    const line = LINES[i];
    log("convo-turn-start", { i, caller: line });
    const callerPcm = upmixMonoToStereo(await tts(line));
    await stream(audioIn, callerPcm, seqState);
    const reply = await waitForReply(ttsWs);
    const outPath = `${OUTDIR}/turn-${i}.wav`;
    writeFileSync(outPath, encodeWav(reply, 48000, 2));
    log("convo-turn-end", { i, caller: line, replyBytes: reply.length, replyMs: Math.round(reply.length / BYTES_PER_MS), out: outPath });
    await sleep(500);
  }
  log("convo-done", { turns: LINES.length, outDir: OUTDIR });
  process.exit(0);
}

mkdirSync(OUTDIR, { recursive: true });
main().catch((e) => die(e.message));
