// wave-voice-program E1 — FIRST MEASUREMENT of the (previously dark) voice-agent turn loop.
//
// Two harnesses share ONE measurement rig:
//   (A) ALWAYS-ON, zero-network: drives a full turn (PCM in → VAD endpoint → STT → LLM → TTS → PCM out the
//       ingest socket) through TurnTakingCore with ZERO-latency fakes on a REAL wall clock. What remains is the
//       ORCHESTRATION OVERHEAD the loop itself adds — the number that must stay small enough for the provider
//       legs to fit under the sub-second bar. Asserted against a generous ceiling so it fails LOUD on a
//       regression (e.g. a re-introduced per-frame STT poll) without being flaky in CI.
//   (B) LIVE (opt-in: E1_LIVE=1 + doppler-provided creds): the SAME rig with the REAL deps from
//       `buildTurnDeps` — real WAVE-gateway STT, real WAVE-gateway LLM, real ElevenLabs TTS — over a real
//       utterance. Prints the per-leg table. Skipped (never fails) without E1_LIVE.
//
// The measured user-perceived metric is END-OF-USER-SPEECH → FIRST AGENT AUDIO BYTE ON THE WIRE ("time to first
// audio", TTFA): the frame that trips VAD speech-end starts the clock; the first `sock.send` stops it. TTS
// real-time pacing (ttsLeadMs) deliberately stretches the TAIL of the send and is NOT part of TTFA.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  TurnTakingCore,
  buildTurnDeps,
  type AgentTurnDeps,
  type AgentTurnEnv,
  type TurnTakingConfig,
  type SttResult,
  type LlmMessage,
  type ToolDefinition,
  type CompletionEvent,
} from "../src/agent-turn.js";
import { streamElevenLabs } from "../src/agent-turn-providers.js";
import type { AgentMediaDeps, IngestSocket } from "../src/agent-session.js";
import { encodeIngestFrame } from "../src/agent-ingest-adapter.js";
import { DEFAULT_VAD_CONFIG } from "../src/agent-vad.js";

const CFG: TurnTakingConfig = {
  roomId: "e1-measure",
  org: "org_wave",
  agentId: "e1",
  participantSessionId: "sess_E1measure0001",
  participantTrackName: "mic",
  systemPrompt: "You are a WAVE voice agent. Answer in ONE short spoken sentence.",
};

/** 20 ms of 48 kHz / 16-bit / stereo PCM = 3840 bytes — the frame cadence the SFU pushes. */
const FRAME_MS = 20;
const FRAME_BYTES = (48_000 * 2 * 2 * FRAME_MS) / 1000;

/** One egress-wire frame (proto3 Packet) carrying `pcm` — the exact wire the SFU pushes at us. */
function frame(pcm: Uint8Array, seq: number): Uint8Array {
  return encodeIngestFrame(pcm, { sequenceNumber: seq, timestamp: seq * 960 }, "packet");
}

/** A loud 200 Hz tone frame (RMS ≫ the VAD threshold) — stands in for user speech in the offline harness. */
function tone(bytes = FRAME_BYTES): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i + 3 < bytes; i += 4) {
    const s = Math.round(8000 * Math.sin((2 * Math.PI * 200 * (i / 4)) / 48_000));
    view.setInt16(i, s, true);
    view.setInt16(i + 2, s, true);
  }
  return out;
}
const SILENCE = new Uint8Array(FRAME_BYTES);

/** The instrumented rig: wraps any deps set with per-leg wall-clock probes + a first-send probe. */
function rig(base: AgentTurnDeps) {
  const marks = {
    endOfSpeechMs: 0,
    sttStartMs: 0,
    sttEndMs: 0,
    llmStartMs: 0,
    llmFirstTokenMs: 0,
    llmEndMs: 0,
    ttsStartMs: 0,
    ttsFirstByteMs: 0,
    ttsEndMs: 0,
    firstSendMs: 0,
    lastSendMs: 0,
    bytesOut: 0,
    transcript: "",
    assistant: "",
  };
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  // We measure the FIRST turn that actually publishes audio. Real speech contains internal pauses, so the VAD can
  // endpoint (and run a no-transcript STT) more than once before the turn fires — freeze every mark at the first
  // send so a later endpoint can't overwrite the measured turn's legs.
  const frozen = () => marks.firstSendMs !== 0;
  const sock: IngestSocket = {
    send: (d) => {
      const now = Date.now();
      if (marks.firstSendMs === 0) marks.firstSendMs = now;
      marks.lastSendMs = now;
      marks.bytesOut += (d as ArrayBuffer).byteLength ?? 0;
    },
    close: () => {},
  };
  const deps: AgentTurnDeps & AgentMediaDeps = {
    createEgress: async (tracks) => ({ adapterId: "eg", raw: { tracks } }),
    createIngest: async (tracks) => ({ adapterId: "in", raw: { tracks } }),
    ingestSocket: () => sock,
    now: () => Date.now(),
    log: (msg, fields) => {
      // "agent-vad-endpoint" IS the end of user speech — the instant the VAD hangover declares the user stopped.
      // Reading it from the core's own log (rather than from the driver) keeps the mark honest for real speech.
      if (msg === "agent-vad-endpoint" && !frozen()) marks.endOfSpeechMs = Date.now();
      logs.push({ msg, fields });
    },
    async transcribe(pcm: Uint8Array): Promise<SttResult> {
      const t0 = Date.now();
      const r = await base.transcribe(pcm);
      if (!frozen()) {
        marks.sttStartMs = t0;
        marks.sttEndMs = Date.now();
        marks.transcript = r.transcript;
      }
      return r;
    },
    async *complete(messages: LlmMessage[], tools: ToolDefinition[]): AsyncIterable<CompletionEvent> {
      if (!frozen()) marks.llmStartMs = Date.now();
      for await (const evt of base.complete(messages, tools)) {
        if (evt.type === "text") {
          if (marks.llmFirstTokenMs === 0) marks.llmFirstTokenMs = Date.now();
          marks.assistant += evt.text;
        }
        yield evt;
      }
      if (!frozen()) marks.llmEndMs = Date.now();
    },
    callTool: (n, i) => base.callTool(n, i),
    async *synthesize(text: string): AsyncIterable<Uint8Array> {
      if (!frozen()) marks.ttsStartMs = Date.now();
      for await (const chunk of base.synthesize(text)) {
        if (marks.ttsFirstByteMs === 0 && chunk.length > 0) marks.ttsFirstByteMs = Date.now();
        yield chunk;
      }
      marks.ttsEndMs = Date.now();
    },
    emitMeter: (u) => base.emitMeter(u),
  };
  return { deps, marks, logs };
}

/** Feed an utterance (loud frames) then enough silence to trip the VAD hangover → runs ONE full turn. */
async function driveTurn(
  core: TurnTakingCore,
  speech: Uint8Array[],
  hangoverFrames = DEFAULT_VAD_CONFIG.hangoverFrames,
): Promise<void> {
  let seq = 0;
  for (const pcm of speech) await core.onFrame(frame(pcm, seq++));
  // Trailing silence trips the VAD hangover → speech-end → STT → LLM → TTS → send, all awaited inside onFrame.
  for (let i = 0; i < hangoverFrames; i++) await core.onFrame(frame(SILENCE, seq++));
}

function table(marks: ReturnType<typeof rig>["marks"], label: string): string {
  const d = (a: number, b: number) => (a && b ? `${b - a} ms` : "n/a");
  const rows: [string, string][] = [
    ["VAD endpoint hangover (fixed cost)", `${DEFAULT_VAD_CONFIG.hangoverFrames * FRAME_MS} ms`],
    ["STT (whole call)", d(marks.sttStartMs, marks.sttEndMs)],
    ["LLM first token", d(marks.llmStartMs, marks.llmFirstTokenMs)],
    ["LLM stream complete", d(marks.llmStartMs, marks.llmEndMs)],
    ["TTS first byte", d(marks.ttsStartMs, marks.ttsFirstByteMs)],
    ["TTFA (end-of-speech → first agent byte on wire)", d(marks.endOfSpeechMs, marks.firstSendMs)],
    ["Turn wall (end-of-speech → last byte sent)", d(marks.endOfSpeechMs, marks.lastSendMs)],
    ["PCM bytes published", `${marks.bytesOut}`],
  ];
  return `\n── ${label} ──\n${rows.map(([k, v]) => `  ${k.padEnd(48)} ${v}`).join("\n")}\n`;
}

/** The live-run utterance. Short + unambiguous so a real STT transcript is trivially verifiable by eye. */
const E1_UTTERANCE = "What is the capital of France?";

/**
 * Synthesize REAL speech locally (macOS `say`) and transcode to the exact 48 kHz / 16-bit / STEREO LE PCM the
 * SFU pushes (`afconvert`), returning the raw `data` chunk. Local + free → the live harness needs no vendor on
 * the INPUT side, so the STT leg it measures is the only thing under test there.
 */
function localSpeechPcm(text: string): Uint8Array {
  const aiff = `${tmpdir()}/e1-utt.aiff`;
  const wav = `${tmpdir()}/e1-utt.wav`;
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@48000", "-c", "2", aiff, wav]);
  const buf = readFileSync(wav);
  // Walk the RIFF chunks to the `data` payload (afconvert emits a FLLR padding chunk before it).
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return new Uint8Array(buf.subarray(off + 8, off + 8 + size));
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk in the generated WAV");
}

/** One cheap pre-flight against the REAL ElevenLabs streaming endpoint: can this account actually serve TTS? */
async function probeElevenLabs(env: AgentTurnEnv): Promise<{ ok: boolean; reason: string }> {
  try {
    for await (const chunk of streamElevenLabs(fetch as never, env, "ok")) {
      if (chunk.length > 0) return { ok: true, reason: "" };
    }
    return { ok: false, reason: "empty TTS stream" };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? "unknown" };
  }
}

// ── (A) ALWAYS-ON: orchestration overhead with zero-latency fakes ────────────────────────────────────────────
describe("E1 — turn-loop orchestration overhead (zero-latency providers, real wall clock)", () => {
  it("drives a full turn and the loop's OWN cost stays far under the sub-second bar", async () => {
    // ~400 ms of synthesized reply audio so the measurement covers a realistic publish volume.
    const replyPcm = new Uint8Array(FRAME_BYTES * 20);
    const fakes: AgentTurnDeps = {
      transcribe: async () => ({ isFinal: true, transcript: "what is the capital of france" }),
      // eslint-disable-next-line require-yield
      async *complete() {
        yield { type: "text", text: "The capital of France is Paris." } as CompletionEvent;
      },
      callTool: async () => "",
      async *synthesize() {
        yield replyPcm;
      },
      emitMeter: async () => {},
    };
    const { deps, marks, logs } = rig(fakes);
    // ttsLeadMs:0 — pacing deliberately stretches the TAIL to the playout clock; it is not orchestration cost.
    const core = new TurnTakingCore(deps, CFG, { ttsLeadMs: 0 });
    await driveTurn(core, [tone(), tone(), tone(), tone(), tone()]);

    // eslint-disable-next-line no-console
    console.log(table(marks, "E1 (A) orchestration overhead — ALL LEGS MOCKED (zero network)"));

    expect(marks.firstSendMs).toBeGreaterThan(0); // the loop actually TURNED and published audio
    expect(marks.bytesOut).toBeGreaterThan(0);
    expect(marks.transcript).toBe("what is the capital of france");
    expect(logs.map((l) => l.msg)).toContain("agent-turn-meter");
    // The loop's own cost (VAD + decode + STT/LLM/TTS plumbing + PCM chunk/encode/send) — generous CI ceiling.
    expect(marks.firstSendMs - marks.endOfSpeechMs).toBeLessThan(100);
  });

  // ── D1 fix, measured on this rig ──────────────────────────────────────────────────────────────────────────
  // The E1 arithmetic showed TTFA == STT + LLM-stream-COMPLETE: runTurn buffered every delta before speaking, so
  // a fast first token bought nothing. With sentence-boundary streaming, TTFA is STT + the FIRST SENTENCE.
  // This test uses a PACED LLM fake (a real per-delta delay, like a real token stream) so the difference is a
  // measured wall-clock number, not an assertion about code shape.
  it("D1: first audio goes out DURING the LLM stream — measured TTFA win vs stream-complete", async () => {
    const DELTA_MS = 40; // per-delta think time; 12 deltas ⇒ a ~480 ms stream
    const REPLY_DELTAS = [
      "The capital", " of France", " is Paris", ". ", // ← sentence 1 completes here, at delta 4 of 12
      "It has", " about two", " million", " people", " living", " there", ". ",
      "Anything else?",
    ];
    // The rig FREEZES its marks at first-send (that is what makes TTFA honest), and with D1 the first send now
    // happens mid-stream — so stream-completion is timed here, in the fake itself.
    let llmEndWall = 0;
    const fakes: AgentTurnDeps = {
      transcribe: async () => ({ isFinal: true, transcript: "what is the capital of france" }),
      async *complete() {
        for (const text of REPLY_DELTAS) {
          await new Promise((r) => setTimeout(r, DELTA_MS));
          yield { type: "text", text } as CompletionEvent;
        }
        llmEndWall = Date.now();
      },
      callTool: async () => "",
      async *synthesize() {
        yield new Uint8Array(FRAME_BYTES);
      },
      emitMeter: async () => {},
    };
    const { deps, marks } = rig(fakes);
    const core = new TurnTakingCore(deps, CFG, { ttsLeadMs: 0 });
    await driveTurn(core, [tone(), tone(), tone(), tone(), tone()]);

    const ttfa = marks.firstSendMs - marks.endOfSpeechMs;
    const legacyTtfa = llmEndWall - marks.endOfSpeechMs; // what TTFA WAS: the whole stream had to land first
    // eslint-disable-next-line no-console
    console.log(
      `\n── D1 sentence-streaming, measured on the paced-LLM rig ──\n` +
        `  TTFA now (first sentence)          ${ttfa} ms\n` +
        `  TTFA before (stream complete)      ${legacyTtfa} ms\n` +
        `  win                                ${legacyTtfa - ttfa} ms\n`,
    );

    // THE structural assertion: audio was on the wire BEFORE the LLM stream finished. Pre-D1 this was impossible.
    expect(marks.firstSendMs).toBeGreaterThan(0);
    expect(marks.firstSendMs).toBeLessThan(llmEndWall);
    // And the win is real: sentence 1 completes at delta 4 of 12, so TTFA should beat stream-complete by
    // ~8 deltas. Asserted with slack (CI timer jitter) but tight enough to FAIL if buffering is reintroduced.
    expect(legacyTtfa - ttfa).toBeGreaterThan(4 * DELTA_MS);
  });

  it("the per-utterance STT call fires EXACTLY once (no per-frame STT poll regression)", async () => {
    let sttCalls = 0;
    const fakes: AgentTurnDeps = {
      transcribe: async () => {
        sttCalls++;
        return { isFinal: true, transcript: "hello" };
      },
      async *complete() {
        yield { type: "text", text: "Hi." } as CompletionEvent;
      },
      callTool: async () => "",
      async *synthesize() {
        yield new Uint8Array(FRAME_BYTES);
      },
      emitMeter: async () => {},
    };
    const { deps, marks } = rig(fakes);
    const core = new TurnTakingCore(deps, CFG, { ttsLeadMs: 0 });
    await driveTurn(core, [tone(), tone(), tone(), tone(), tone(), tone(), tone(), tone()]);
    expect(sttCalls).toBe(1);
  });
});

// ── (B) LIVE: the same rig on the REAL providers (opt-in) ────────────────────────────────────────────────────
const LIVE = process.env.E1_LIVE === "1";
describe.skipIf(!LIVE)("E1 — LIVE turn against real providers (E1_LIVE=1 + doppler creds)", () => {
  it(
    "runs one real turn end-to-end and reports the per-leg latency table",
    { timeout: 120_000 },
    async () => {
      const env: AgentTurnEnv = {
        VOICE_AGENT_PROVIDER: "wave",
        WAVE_GATEWAY_BASE: process.env.WAVE_GATEWAY_URL,
        WAVE_GATEWAY_TOKEN: process.env.WAVE_SERVICE_TOKEN,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
        VOICE_AGENT_LLM_MODEL: process.env.VOICE_AGENT_LLM_MODEL,
      } as AgentTurnEnv;
      expect(env.WAVE_GATEWAY_BASE, "WAVE_GATEWAY_URL must be provided (doppler run)").toBeTruthy();
      expect(env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY must be provided (doppler run)").toBeTruthy();

      // The "user" utterance: REAL speech, synthesized LOCALLY (macOS `say` + `afconvert`) to exactly the
      // 48 kHz / 16-bit / stereo PCM the SFU pushes, then cut into 20 ms frames — so the VAD, the STT spoke and
      // the whole loop see genuine speech audio with no vendor dependency on the INPUT side.
      const utter = localSpeechPcm(E1_UTTERANCE);
      const speech: Uint8Array[] = [];
      for (let i = 0; i + FRAME_BYTES <= utter.length; i += FRAME_BYTES) {
        speech.push(utter.subarray(i, i + FRAME_BYTES));
      }
      expect(speech.length, "the synthesized user utterance produced frames").toBeGreaterThan(10);

      const media: AgentMediaDeps = {
        createEgress: async (t) => ({ adapterId: "eg", raw: { tracks: t } }),
        createIngest: async (t) => ({ adapterId: "in", raw: { tracks: t } }),
        ingestSocket: () => null,
        now: () => Date.now(),
        log: () => {},
      };
      const live = buildTurnDeps(env, media, fetch as never, CFG.org);
      // TTS PRE-FLIGHT: probe the real ElevenLabs streaming endpoint ONCE. If the account cannot serve (e.g. the
      // 401 payment_issue observed on 2026-08-05 — a BILLING blocker, not a code defect), fall back to a
      // zero-latency PCM fake for the TTS leg ONLY, and say so loudly in the table. STT + LLM stay real.
      const ttsProbe = await probeElevenLabs(env);
      const depsSet: AgentTurnDeps = ttsProbe.ok
        ? live
        : {
            ...live,
            async *synthesize() {
              yield new Uint8Array(FRAME_BYTES * 20); // ~400 ms of silence — publishes, measures nothing real
            },
          };
      const samples = Number(process.env.E1_SAMPLES ?? 3);
      for (let n = 0; n < samples; n++) {
        const { deps, marks, logs } = rig(depsSet);
        // A per-sample NONCE in the persona defeats any gateway response cache — without it sample 2+ returns in
        // ~90 ms (observed) and the "LLM latency" measured is the cache's, not the model's.
        const core = new TurnTakingCore(deps, { ...CFG, systemPrompt: `${CFG.systemPrompt} (run ${Date.now()}-${n})` }, { ttsLeadMs: 0 });
        await driveTurn(core, speech);

        // eslint-disable-next-line no-console
        console.log(
          table(
            marks,
            `E1 (B) LIVE sample ${n + 1}/${samples} — STT: REAL · LLM: REAL · TTS: ${ttsProbe.ok ? "REAL" : `MOCKED (${ttsProbe.reason})`}`,
          ) +
            `  spoken in (local say):      ${JSON.stringify(E1_UTTERANCE)}\n` +
            `  user transcript (real STT): ${JSON.stringify(marks.transcript)}\n` +
            `  agent reply    (real LLM):  ${JSON.stringify(marks.assistant)}\n` +
            `  errors: ${JSON.stringify(logs.filter((l) => l.msg.includes("error")))}\n`,
        );

        expect(logs.filter((l) => l.msg.includes("error"))).toEqual([]);
        expect(marks.transcript.length, "real STT returned a transcript").toBeGreaterThan(0);
        expect(marks.assistant.length, "real LLM returned assistant text").toBeGreaterThan(0);
        expect(marks.bytesOut, "TTS audio was published to the ingest socket").toBeGreaterThan(0);
      }
    },
  );
});
