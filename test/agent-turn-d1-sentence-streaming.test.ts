// wave-voice-program E1 finding D1 — SENTENCE-BOUNDARY STREAMING.
//
// The E1 measurement proved TTFA = STT + the ENTIRE LLM stream (first-token at ~800 ms bought nothing, because
// runTurn accumulated every delta before it called speak()). These tests pin the fix on both levels:
//   (1) the pure boundary policy (SentenceChunker) — where we split, and just as importantly where we DON'T;
//   (2) the turn loop — speak() is invoked BEFORE the LLM stream completes, history still commits the FULL
//       assistant turn atomically at stream end, and both failure modes (barge-in, mid-stream LLM error) commit
//       exactly what the listener heard and nothing more.
// Every dep is a fake — zero live network.
import { describe, it, expect, vi } from "vitest";
import {
  SentenceChunker,
  DEFAULT_MAX_SENTENCE_CHARS,
} from "../src/sentence-chunker.js";
import {
  TurnTakingCore,
  type AgentTurnDeps,
  type TurnTakingConfig,
  type SttResult,
  type LlmMessage,
  type ToolDefinition,
  type CompletionEvent,
} from "../src/agent-turn.js";
import type { AgentMediaDeps, IngestSocket } from "../src/agent-session.js";
import { SpeechSession, TTS_BYTES_PER_MS } from "../src/agent-turn-speech.js";
import { encodeIngestFrame } from "../src/agent-ingest-adapter.js";
import { decodePacket } from "../src/encoders/container-adapter.js";

// ═══════════════════════════ (1) the pure boundary policy ═══════════════════════════
describe("SentenceChunker — where we split", () => {
  /** Feed a whole string one character at a time — the worst case a real token stream can produce. */
  function perChar(text: string, chunker = new SentenceChunker()): { out: string[]; tail: string } {
    const out: string[] = [];
    for (const ch of text) out.push(...chunker.push(ch));
    return { out, tail: chunker.flush() };
  }

  it("emits a sentence as soon as the terminator + lookahead arrive, not at stream end", () => {
    const c = new SentenceChunker();
    expect(c.push("The capital of France is Paris")).toEqual([]);
    expect(c.push(".")).toEqual([]); // terminator alone is NOT enough — "3.14" would split here
    expect(c.push(" It")).toEqual(["The capital of France is Paris."]); // the space proves the boundary
    expect(c.flush()).toBe("It");
  });

  it("splits a multi-sentence reply in order and loses nothing", () => {
    const { out, tail } = perChar("Paris is the capital. It has about two million people. Anything else?");
    expect(out).toEqual([
      "Paris is the capital.",
      "It has about two million people.",
    ]);
    expect(tail).toBe("Anything else?"); // the final sentence has no lookahead → the caller flushes it
    expect([...out, tail].join(" ")).toBe("Paris is the capital. It has about two million people. Anything else?");
  });

  it("does NOT split inside decimals, versions or domains", () => {
    expect(perChar("The rate is 3.14 percent today and stable.").out).toEqual([]); // no boundary before flush
    expect(perChar("Go to wave.online for details and pricing.").out).toEqual([]);
    expect(perChar("We shipped v1.2 of the worker this morning.").out).toEqual([]);
  });

  it("does NOT split after a known abbreviation or an initial", () => {
    expect(perChar("Dr. Smith runs the clinic downtown near you.").out).toEqual([]);
    expect(perChar("Use a fast model, e.g. sonnet, for voice replies.").out).toEqual([]);
    expect(perChar("J. Fineman founded the company back then.").out).toEqual([]);
  });

  it("treats a terminator RUN and trailing closers as ONE boundary", () => {
    expect(perChar('He said "we are shipping today." Then he left.').out).toEqual([
      'He said "we are shipping today."', // the closing quote stays with its sentence
    ]);
    expect(perChar("Wait, really... I had no idea about that.").out).toEqual(["Wait, really..."]);
    expect(perChar("Are you serious?! I cannot believe that.").out).toEqual(["Are you serious?!"]);
  });

  it("holds a too-short sentence and merges it into the next (no choppy one-word TTS calls)", () => {
    const { out, tail } = perChar("Hi. How are you doing today my friend?");
    expect(out).toEqual([]); // "Hi." is under minChars → held
    expect(tail).toBe("Hi. How are you doing today my friend?");
  });

  it("breaks a hard newline (lists/paragraphs) without needing a terminator", () => {
    const { out } = perChar("Here are the options\nThe first one is cheaper than the rest.");
    expect(out).toEqual(["Here are the options"]);
  });

  it("force-flushes an unpunctuated monologue at a word boundary so audio never stalls", () => {
    const words = `${"word ".repeat(120)}`; // ≫ maxChars, zero punctuation
    const { out } = perChar(words);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.length).toBeLessThanOrEqual(DEFAULT_MAX_SENTENCE_CHARS);
    expect(out[0]!.endsWith("word")).toBe(true); // cut at a space — never mid-word
  });

  it("is empty after a stream that ended exactly on a boundary", () => {
    const c = new SentenceChunker();
    c.push("This is a complete sentence. ");
    expect(c.isEmpty).toBe(true);
    expect(c.flush()).toBe("");
  });
});

// ═══════════════════════════ (2) the turn loop ═══════════════════════════
const CFG: TurnTakingConfig = {
  roomId: "room-d1",
  org: "org-d1",
  agentId: "a-d1",
  participantSessionId: "sess_D1abcdef123456",
  participantTrackName: "mic",
  systemPrompt: "You are a WAVE voice agent.",
};
const VAD_FAST = { onsetFrames: 1, hangoverFrames: 1, rmsThreshold: 500 } as const;
const LOUD = [0x10, 0x27, 0x10, 0x27];
const END = [0, 0];

function egressFrame(pcm: number[], seq = 1): Uint8Array {
  return encodeIngestFrame(new Uint8Array(pcm), { sequenceNumber: seq, timestamp: seq * 960 }, "packet");
}

/**
 * A turn rig with an ORDERED event trace. The trace is the whole point: it proves speak() ran BEFORE the LLM
 * stream finished, which a byte count alone can never show.
 */
function rig(opts: {
  deltas: string[];
  /** Throw this after yielding `throwAfter` deltas (mid-stream LLM failure — the #344 fail-closed path). */
  throwAfter?: number;
  /** HOLD the Nth (1-based) synthesize call open, so the test can barge in while the turn is mid-utterance. */
  gateTtsCall?: number;
}) {
  const trace: string[] = [];
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const sent: Uint8Array[] = [];
  const spoken: string[] = [];
  let t = 1000;
  const sock: IngestSocket = { send: (d) => sent.push(new Uint8Array(d as ArrayBuffer)), close: () => {} };
  let core: TurnTakingCore;

  const complete = vi.fn(async function* (_m: LlmMessage[], _t: ToolDefinition[]): AsyncIterable<CompletionEvent> {
    trace.push("llm:start");
    for (let i = 0; i < opts.deltas.length; i++) {
      if (opts.throwAfter !== undefined && i === opts.throwAfter) {
        trace.push("llm:throw");
        throw new Error("gateway LLM returned 502 (llm_unreachable)"); // the #344 typed failure, mid-stream
      }
      trace.push(`llm:delta${i}`);
      yield { type: "text", text: opts.deltas[i]! } as const;
    }
    trace.push("llm:end");
  });

  let releaseTts!: () => void;
  const ttsGate = new Promise<void>((r) => (releaseTts = r));
  let gateReached!: () => void;
  const atGate = new Promise<void>((r) => (gateReached = r));
  const synthesize = vi.fn(async function* (text: string) {
    trace.push(`tts:${text}`);
    spoken.push(text);
    if (opts.gateTtsCall !== undefined && spoken.length === opts.gateTtsCall) {
      gateReached();
      await ttsGate; // hold the turn mid-utterance so the test can barge in over the agent
    }
    yield new Uint8Array([1, 2, 3, 4]);
  });

  const deps: AgentTurnDeps & AgentMediaDeps = {
    createEgress: vi.fn(async (tracks) => ({ adapterId: "eg", raw: { tracks } })),
    createIngest: vi.fn(async (tracks) => ({ adapterId: "in", raw: { tracks } })),
    ingestSocket: () => sock,
    now: () => t++,
    log: (msg, fields) => {
      trace.push(`log:${msg}`);
      logs.push({ msg, fields });
    },
    transcribe: vi.fn(async (): Promise<SttResult> => ({ isFinal: true, transcript: "what is the capital" })),
    complete,
    callTool: vi.fn(async () => "unused"),
    synthesize,
    emitMeter: vi.fn(async () => {}),
  };
  // No `tools` → the agent is text-only, which is exactly when D1 sentence-streaming is enabled (a tool_use can
  // arrive after text in the same stream, and the tool-turn history shape cannot carry a spoken preamble).
  core = new TurnTakingCore(deps, CFG, { vad: VAD_FAST, ttsLeadMs: 0 });
  return { core, trace, logs, sent, spoken, complete, synthesize, deps, releaseTts, atGate };
}

async function drive(core: TurnTakingCore): Promise<void> {
  await core.onFrame(egressFrame(LOUD, 1));
  await core.onFrame(egressFrame(END, 2));
}

const REPLY = ["The capital of France is Paris", ". ", "It is home to about two million people", ". ", "Anything else?"];

describe("D1 — the turn loop speaks sentences DURING the LLM stream", () => {
  it("calls speak() BEFORE the stream completes (the whole latency fix)", async () => {
    const r = rig({ deltas: REPLY });
    await drive(r.core);
    const firstTts = r.trace.findIndex((e) => e.startsWith("tts:"));
    const llmEnd = r.trace.indexOf("llm:end");
    expect(firstTts).toBeGreaterThan(-1);
    expect(llmEnd).toBeGreaterThan(-1);
    // THE assertion: audio synthesis starts before the LLM has finished streaming. Pre-D1 this was inverted.
    expect(firstTts).toBeLessThan(llmEnd);
    // And it is a real sentence, not a fragment.
    expect(r.spoken[0]).toBe("The capital of France is Paris.");
  });

  it("speaks every sentence exactly once, in order, and the flushed tail last", async () => {
    const r = rig({ deltas: REPLY });
    await drive(r.core);
    expect(r.spoken).toEqual([
      "The capital of France is Paris.",
      "It is home to about two million people.",
      "Anything else?", // the trailing partial — spoken AFTER the atomic history commit
    ]);
    expect(r.sent.length).toBe(3); // one PCM chunk per sentence, all on the wire
    expect(decodePacket(r.sent[0]!).payload).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("keeps the RTP media clock MONOTONIC across sentences (#34 barge-in tail stays fixed)", async () => {
    const r = rig({ deltas: REPLY });
    await drive(r.core);
    const packets = r.sent.map((b) => decodePacket(b));
    const seqs = packets.map((p) => p.sequenceNumber);
    const tss = packets.map((p) => p.timestamp);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(tss).toEqual([...tss].sort((a, b) => a - b));
    expect(new Set(tss).size).toBe(tss.length); // never restarts at 0 on a new sentence
  });

  it("commits the FULL assistant turn atomically at stream end — exactly as before D1", async () => {
    const r = rig({ deltas: REPLY });
    await drive(r.core);
    const history = r.core.history();
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    // ONE assistant message carrying the WHOLE reply (not one message per spoken sentence).
    expect(history[2]!.content).toBe(REPLY.join("").trim());
    expect(r.logs.some((l) => l.msg === "agent-turn-partial-spoken")).toBe(false); // clean turn ⇒ no partial marker
  });

  it("reports ttfaMs in the turn meter (the D1 receipt)", async () => {
    const r = rig({ deltas: REPLY });
    await drive(r.core);
    const meter = r.logs.find((l) => l.msg === "agent-turn-meter")!;
    expect(meter.fields.ttfaMs).toBeTypeOf("number");
    expect(meter.fields.ttfaMs as number).toBeGreaterThanOrEqual(0);
    // The fake clock ticks once per now() call, so ttfaMs < turnWallMs proves first audio preceded turn end.
    expect(meter.fields.ttfaMs as number).toBeLessThan(meter.fields.turnWallMs as number);
  });
});

describe("D1 — failure modes commit exactly what the listener heard", () => {
  it("barge-in mid-utterance: stops speaking and commits ONLY the spoken prefix", async () => {
    // The barge-in lands while sentence 2 is synthesizing: sentence 1 is fully on the wire, sentence 2 never
    // publishes a byte (the abort check runs before the first send).
    const r = rig({ deltas: REPLY, gateTtsCall: 2 });
    await r.core.onFrame(egressFrame(LOUD, 1)); // speech onset
    const turnP = r.core.onFrame(egressFrame(END, 2)); // speech-end → the turn runs; parks at the TTS gate
    await r.atGate;
    // A REAL barge-in (#27): the user must go SILENT (the utterance that started this turn ends) and then speak
    // AGAIN over the talking agent — trailing audio of the same utterance can never self-interrupt.
    await r.core.onFrame(egressFrame(END, 3));
    await r.core.onFrame(egressFrame(LOUD, 4)); // fresh onset over the agent → barge-in → abort
    r.releaseTts();
    await turnP;

    expect(r.spoken).toHaveLength(2); // TTS was asked for 2 sentences...
    expect(r.sent).toHaveLength(1); // ...but only 1 reached the wire, and nothing after the barge-in
    expect(r.logs.some((l) => l.msg === "agent-turn-interrupt")).toBe(true);
    const history = r.core.history();
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(history[2]!.content).toBe("The capital of France is Paris."); // NOT the unspoken remainder
    const partial = r.logs.find((l) => l.msg === "agent-turn-partial-spoken")!;
    expect(partial.fields.reason).toBe("barge-in");
    expect(r.logs.some((l) => l.msg === "agent-turn-meter")).toBe(false); // an aborted turn is not a metered turn
  });

  it("mid-stream LLM error AFTER audio went out: turn marked FAILED, spoken audio acknowledged in history", async () => {
    // Two full sentences stream, then the gateway dies (the #344 fail-closed LLM_UPSTREAM shape).
    const r = rig({ deltas: REPLY, throwAfter: 4 });
    await drive(r.core);
    expect(r.spoken).toEqual([
      "The capital of France is Paris.",
      "It is home to about two million people.",
    ]);
    // FAILED: the turn is logged as an error and never metered as a completed turn...
    const err = r.logs.find((l) => l.msg === "agent-turn-error")!;
    expect(err.fields.message).toContain("502");
    expect(r.logs.some((l) => l.msg === "agent-turn-meter")).toBe(false);
    // ...but the audio the listener already heard is acknowledged, not erased: history holds exactly that prefix,
    // so the next turn cannot repeat or contradict what was said.
    const history = r.core.history();
    expect(history[2]!.content).toBe("The capital of France is Paris. It is home to about two million people.");
    expect(r.logs.find((l) => l.msg === "agent-turn-partial-spoken")!.fields.reason).toBe("llm-error");
  });

  it("mid-stream LLM error BEFORE any audio: nothing spoken, nothing committed (no dangling user turn)", async () => {
    const r = rig({ deltas: REPLY, throwAfter: 0 });
    await drive(r.core);
    expect(r.spoken).toEqual([]);
    expect(r.core.history().map((m) => m.role)).toEqual(["system"]); // the user message is NOT left dangling
    expect(r.logs.some((l) => l.msg === "agent-turn-partial-spoken")).toBe(false);
    expect(r.logs.some((l) => l.msg === "agent-turn-error")).toBe(true);
  });

  it("an empty LLM reply still abandons cleanly (no commit, no TTS)", async () => {
    const r = rig({ deltas: ["", "   "] });
    await drive(r.core);
    expect(r.spoken).toEqual([]);
    expect(r.core.history().map((m) => m.role)).toEqual(["system"]);
    expect(r.logs.some((l) => l.msg === "agent-turn-empty-llm")).toBe(true);
  });
});

describe("D1 — pacing across inter-sentence stalls (the #34 lead bound survives per-sentence speak())", () => {
  it("re-anchors the pacing window after a stall so the next sentence is throttled to the lead, not burst", async () => {
    const TTS_LEAD_MS = 50;
    const CHUNK_MS = 50;
    const chunk = () => new Uint8Array(CHUNK_MS * TTS_BYTES_PER_MS); // 50 ms of PCM, well under MAX_PCM_MESSAGE_BYTES
    let t = 0;
    const delays: number[] = [];
    const sends: { t: number; sentMsAfter: number }[] = [];
    let sentMs = 0;
    const sock: IngestSocket = {
      send: (d) => {
        sentMs += (d as Uint8Array).length > 0 ? CHUNK_MS : 0;
        sends.push({ t, sentMsAfter: sentMs });
      },
      close: () => {},
    };
    const session = new SpeechSession(
      {
        synthesize: async function* () {
          for (let i = 0; i < 4; i++) yield chunk(); // 4 × 50 ms = a 200 ms sentence
        },
        ingestSocket: () => sock,
        now: () => t,
        delay: async (ms) => {
          delays.push(ms);
          t += ms; // a fake sleep ADVANCES the fake clock — real pacing semantics, zero wall time
        },
        log: () => {},
      },
      { ttsLeadMs: TTS_LEAD_MS, framing: "raw", isAborted: () => false, nextSeq: () => 1, idFields: () => ({}) },
    );

    await session.speak("Sentence one lands immediately after STT.");
    // The inter-sentence stall: the LLM takes 500 ms to produce sentence two while playout drains to empty.
    t += 500;
    const resumeT = t;
    const sendsBefore = sends.length;
    delays.length = 0;
    await session.speak("Sentence two must still be paced to the lead.");

    // The gate engaged during sentence 2 — without the underrun re-anchor the 500 ms deficit keeps it open and
    // all four chunks burst out at the same instant (delays stays empty).
    expect(delays.length).toBeGreaterThan(0);
    // Every frame of sentence 2 obeys the lead bound measured from the RESUMED playout: published-audio-ahead
    // never exceeds lead + one chunk, which is exactly the shallow-buffer guarantee #34 established per turn.
    const s2Sends = sends.slice(sendsBefore);
    const s2StartMs = s2Sends[0]!.sentMsAfter - CHUNK_MS;
    for (const s of s2Sends) {
      expect(s.sentMsAfter - s2StartMs - (s.t - resumeT)).toBeLessThanOrEqual(TTS_LEAD_MS + CHUNK_MS);
    }
  });
});
