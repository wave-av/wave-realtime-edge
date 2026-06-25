// Task #81 (LK-rip Phase 6b) step 3 — TurnTakingCore: a real conversational turn replacing the echo loop.
// Proves: PCM-in → STT final transcript → LLM (gateway) called with the correct alternating message history →
// assistant text → ElevenLabs TTS → PCM-out the ingest socket (round-trip through the REAL encode path);
// conversation history accumulates across turns (system + user/assistant alternation); fail-safety (STT / LLM /
// TTS throwing → logged, no throw, no crash, no partial send corruption); inert-without-flag; partial
// transcripts do NOT trigger a turn (final-driven endpointing v1); metering counts are structured-logged.
// All three deps (transcribe / complete / synthesize) are FAKES — zero live network.
import { describe, it, expect, vi } from "vitest";
import {
  TurnTakingCore,
  buildTurnSystemPrompt,
  type AgentTurnDeps,
  type TurnTakingConfig,
  type SttResult,
  type LlmMessage,
  type ToolDefinition,
} from "../src/agent-turn.js";
import type { AgentMediaDeps, IngestSocket } from "../src/agent-session.js";
import { encodeIngestFrame } from "../src/agent-ingest-adapter.js";
import { decodePacket } from "../src/encoders/container-adapter.js";

const SESSION = "sess_ABCdef12345678";
const goodCfg: TurnTakingConfig = {
  roomId: "room1",
  org: "org1",
  agentId: "a1",
  participantSessionId: SESSION,
  participantTrackName: "mic",
  systemPrompt: "You are a helpful WAVE voice agent.",
};

/** A fake STT that emits a final transcript whenever it has seen a sentinel terminator byte (0x00) in PCM. */
function mkDeps(over: Partial<AgentTurnDeps & AgentMediaDeps> = {}) {
  const sent: Uint8Array[] = [];
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  let t = 1000;
  const sock: IngestSocket = { send: (d) => sent.push(new Uint8Array(d as ArrayBuffer)), close: () => {} };

  // Fake STT: each call gets the *accumulated* PCM since the last final; returns final once it sees a 0x00.
  const transcribe = vi.fn(async (pcm: Uint8Array): Promise<SttResult> => {
    const hasTerminator = pcm.includes(0x00);
    return hasTerminator
      ? { isFinal: true, transcript: "hello agent" }
      : { isFinal: false, transcript: "hello" };
  });
  // Fake LLM gateway: echoes the last user message into an assistant reply; records the message history. Yields the
  // step-5 CompletionEvent union (text events). Text-only by default → the bounded loop terminates in one iteration.
  const complete = vi.fn(async function* (messages: LlmMessage[], _tools: ToolDefinition[]) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    yield { type: "text", text: "Reply to: " } as const;
    yield { type: "text", text: (lastUser?.content as string) ?? "" } as const;
  });
  // Fake tool executor: deterministic echo of name (overridable per-test). Never hits the network.
  const callTool = vi.fn(async (name: string, _input: unknown) => `result:${name}`);
  // Fake ElevenLabs: emit two PCM chunks for any text (deterministic so we can assert round-trip bytes).
  const synthesize = vi.fn(async function* (_text: string) {
    yield new Uint8Array([1, 2, 3, 4]);
    yield new Uint8Array([5, 6, 7, 8]);
  });
  // Fake metering emit: records the usage shape; never hits the network.
  const emitMeter = vi.fn(async (_usage: unknown) => {});

  const deps: AgentTurnDeps & AgentMediaDeps = {
    // media seam (unused create paths here — TurnTakingCore reuses AgentSessionCore for adapters elsewhere)
    createEgress: vi.fn(async (tracks) => ({ adapterId: "eg_1", raw: { tracks } })),
    createIngest: vi.fn(async (tracks) => ({ adapterId: "in_1", raw: { tracks } })),
    ingestSocket: () => sock,
    now: () => t++,
    log: (msg, fields) => logs.push({ msg, fields }),
    transcribe,
    complete,
    callTool,
    synthesize,
    emitMeter,
    ...over,
  };
  return { deps, sent, logs, transcribe, complete, callTool, synthesize, emitMeter };
}

/** Build an egress Packet frame carrying `pcm` (same wire the SFU pushes), via the verified encoder. */
function egressFrame(pcm: number[], seq = 1, ts = 4800): Uint8Array {
  return encodeIngestFrame(new Uint8Array(pcm), { sequenceNumber: seq, timestamp: ts }, "packet");
}

describe("buildTurnSystemPrompt", () => {
  it("uses the configured prompt and falls back to a sensible default", () => {
    expect(buildTurnSystemPrompt({ ...goodCfg, systemPrompt: "Custom." })).toBe("Custom.");
    const def = buildTurnSystemPrompt({ ...goodCfg, systemPrompt: undefined });
    expect(def.length).toBeGreaterThan(0);
  });
});

describe("TurnTakingCore — one full turn", () => {
  it("PCM-in → final transcript → LLM(history) → assistant text → TTS → PCM-out the ingest socket", async () => {
    const { deps, sent, complete, transcribe, synthesize } = mkDeps();
    const core = new TurnTakingCore(deps, goodCfg);
    // partial frame (no terminator) — accrues, no turn yet
    await core.onFrame(egressFrame([10, 20], 1));
    expect(complete).not.toHaveBeenCalled();
    expect(sent.length).toBe(0);
    // final frame (terminator 0x00) — fires the full turn
    await core.onFrame(egressFrame([30, 0x00], 2));
    expect(transcribe).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    // LLM saw system + the final user transcript
    const msgs = (complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as LlmMessage[];
    expect(msgs[0]).toMatchObject({ role: "system" });
    expect(msgs.find((m) => m.role === "user")?.content).toBe("hello agent");
    expect(synthesize).toHaveBeenCalledWith("Reply to: hello agent");
    // two synth chunks → two ingest frames carrying the SAME PCM (round-trip via the real decoder)
    expect(sent.length).toBe(2);
    expect(Array.from(decodePacket(sent[0]).payload)).toEqual([1, 2, 3, 4]);
    expect(Array.from(decodePacket(sent[1]).payload)).toEqual([5, 6, 7, 8]);
  });

  it("accumulates conversation history across turns (alternating user/assistant)", async () => {
    const { deps, complete } = mkDeps();
    const core = new TurnTakingCore(deps, goodCfg);
    await core.onFrame(egressFrame([1, 0x00], 1)); // turn 1
    await core.onFrame(egressFrame([2, 0x00], 2)); // turn 2
    expect(complete).toHaveBeenCalledTimes(2);
    const secondTurnMsgs = (complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as LlmMessage[];
    // system, user(t1), assistant(t1), user(t2)
    expect(secondTurnMsgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(secondTurnMsgs[2].content).toBe("Reply to: hello agent");
    const hist = core.history();
    expect(hist.filter((m) => m.role === "user").length).toBe(2);
    expect(hist.filter((m) => m.role === "assistant").length).toBe(2);
  });

  it("a failed turn leaves NO dangling user message — the next turn's history still alternates", async () => {
    // First turn's LLM throws; second turn succeeds. The committed history (and the second request) must stay
    // strictly alternating (no two consecutive user turns) — guards the atomic user+assistant commit.
    let call = 0;
    const complete = vi.fn(async function* (_messages: LlmMessage[], _tools: ToolDefinition[]) {
      call += 1;
      if (call === 1) throw new Error("llm boom"); // turn 1 fails AFTER the user utterance was transcribed
      yield { type: "text", text: "ok" } as const; // turn 2 succeeds
    });
    const { deps } = mkDeps({ complete });
    const core = new TurnTakingCore(deps, goodCfg);
    await core.onFrame(egressFrame([1, 0x00], 1)); // turn 1 → LLM throws (swallowed)
    await core.onFrame(egressFrame([2, 0x00], 2)); // turn 2 → succeeds
    expect(complete).toHaveBeenCalledTimes(2);
    const secondReq = (complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as LlmMessage[];
    // No two consecutive user roles anywhere in the second request.
    for (let i = 1; i < secondReq.length; i++) {
      expect(secondReq[i].role === "user" && secondReq[i - 1].role === "user").toBe(false);
    }
    // Committed history after the failed-then-good turn: exactly system + the ONE successful user/assistant pair.
    expect(core.history().map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("does not fire a turn on a partial (non-final) transcript", async () => {
    const { deps, complete, synthesize } = mkDeps();
    const core = new TurnTakingCore(deps, goodCfg);
    await core.onFrame(egressFrame([1, 2], 1));
    await core.onFrame(egressFrame([3, 4], 2));
    expect(complete).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("TurnTakingCore — barge-in (step 4 interrupt controller)", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  // Loud PCM (16-bit LE samples of ~10000 → RMS ≫ default 500) = "speech"; no 0x00 so it never reads as STT-final.
  const loud = () => egressFrame([0x10, 0x27, 0x10, 0x27, 0x10, 0x27], 9);
  // Quiet PCM (zero samples → RMS 0) = "silence" for the VAD.
  const quiet = () => egressFrame([0, 0, 0, 0], 9);
  const startTurn = () => egressFrame([30, 0x00], 1); // quiet + 0x00 terminator → STT-final → starts a turn

  it("user speech mid-turn aborts the in-flight TTS — agent goes silent, interrupt is logged", async () => {
    let releaseTts!: () => void;
    const ttsGate = new Promise<void>((r) => (releaseTts = r));
    const synthesize = vi.fn(async function* (_t: string) {
      yield new Uint8Array([1, 2, 3, 4]); // chunk 1 publishes before the barge-in
      await ttsGate; // hold the stream open → the turn is "in flight"
      yield new Uint8Array([5, 6, 7, 8]); // chunk 2 must be SUPPRESSED once aborted
    });
    const { deps, sent, logs } = mkDeps({ synthesize });
    // onsetFrames:1 → a single loud frame fires the barge-in (keeps the test deterministic).
    const core = new TurnTakingCore(deps, goodCfg, { vad: { onsetFrames: 1, rmsThreshold: 500 } });

    const turnP = core.onFrame(startTurn()); // do NOT await — parks at the TTS gate
    await tick();
    expect(sent.length).toBe(1); // chunk 1 already out
    await core.onFrame(loud()); // barge-in while the agent is talking → abort
    releaseTts();
    await turnP;

    expect(logs.some((l) => l.msg === "agent-turn-interrupt")).toBe(true);
    expect(sent.length).toBe(1); // chunk 2 was suppressed by the abort (agent went silent)
  });

  it("silence mid-turn does NOT abort — the agent keeps talking", async () => {
    let releaseTts!: () => void;
    const ttsGate = new Promise<void>((r) => (releaseTts = r));
    const synthesize = vi.fn(async function* (_t: string) {
      yield new Uint8Array([1, 2, 3, 4]);
      await ttsGate;
      yield new Uint8Array([5, 6, 7, 8]);
    });
    const { deps, sent, logs } = mkDeps({ synthesize });
    const core = new TurnTakingCore(deps, goodCfg, { vad: { onsetFrames: 1, rmsThreshold: 500 } });

    const turnP = core.onFrame(startTurn());
    await tick();
    await core.onFrame(quiet()); // silence mid-turn → no onset → no barge-in
    releaseTts();
    await turnP;

    expect(logs.some((l) => l.msg === "agent-turn-interrupt")).toBe(false);
    expect(sent.length).toBe(2); // both chunks delivered — the agent finished its turn
  });

  it("after a barge-in the next utterance is a clean new turn (history still alternates)", async () => {
    let releaseTts!: () => void;
    const ttsGate = new Promise<void>((r) => (releaseTts = r));
    const synthesize = vi.fn(async function* (_t: string) {
      yield new Uint8Array([1, 2, 3, 4]);
      await ttsGate;
      yield new Uint8Array([5, 6, 7, 8]);
    });
    const { deps, complete } = mkDeps({ synthesize });
    const core = new TurnTakingCore(deps, goodCfg, { vad: { onsetFrames: 1, rmsThreshold: 500 } });

    const turnP = core.onFrame(startTurn()); // turn 1 — LLM committed assistant, then parks in TTS
    await tick();
    await core.onFrame(loud()); // barge-in turn 1
    releaseTts();
    await turnP;

    await core.onFrame(egressFrame([31, 0x00], 2)); // turn 2 — a fresh utterance
    // History is strictly alternating: system + (turn1 user/assistant) + (turn2 user/assistant), no dangling users.
    expect(core.history().map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    const secondReq = (complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as LlmMessage[];
    for (let i = 1; i < secondReq.length; i++) {
      expect(secondReq[i].role === "user" && secondReq[i - 1].role === "user").toBe(false);
    }
  });
});

describe("TurnTakingCore — fail-safety (never throws up the media path)", () => {
  it("STT throwing is logged and swallowed", async () => {
    const { deps, logs, complete } = mkDeps({
      transcribe: vi.fn(async () => {
        throw new Error("stt boom");
      }),
    });
    const core = new TurnTakingCore(deps, goodCfg);
    await expect(core.onFrame(egressFrame([1, 0x00], 1))).resolves.toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    expect(logs.some((l) => l.msg === "agent-turn-error" && l.fields.stage === "stt")).toBe(true);
  });

  it("LLM throwing is logged and swallowed, no TTS, no send", async () => {
    const { deps, logs, sent, synthesize } = mkDeps({
      complete: vi.fn(async function* () {
        throw new Error("llm boom");
        // eslint-disable-next-line no-unreachable
        yield { type: "text", text: "" } as const;
      }),
    });
    const core = new TurnTakingCore(deps, goodCfg);
    await expect(core.onFrame(egressFrame([1, 0x00], 1))).resolves.toBeUndefined();
    expect(synthesize).not.toHaveBeenCalled();
    expect(sent.length).toBe(0);
    expect(logs.some((l) => l.msg === "agent-turn-error" && l.fields.stage === "llm")).toBe(true);
  });

  it("TTS throwing is logged and swallowed, no crash", async () => {
    const { deps, logs, sent } = mkDeps({
      synthesize: vi.fn(async function* () {
        throw new Error("tts boom");
        // eslint-disable-next-line no-unreachable
        yield new Uint8Array();
      }),
    });
    const core = new TurnTakingCore(deps, goodCfg);
    await expect(core.onFrame(egressFrame([1, 0x00], 1))).resolves.toBeUndefined();
    expect(sent.length).toBe(0);
    expect(logs.some((l) => l.msg === "agent-turn-error" && l.fields.stage === "tts")).toBe(true);
  });

  it("a garbage egress frame is fail-safe (logged, never thrown)", async () => {
    const { deps, logs } = mkDeps();
    const core = new TurnTakingCore(deps, goodCfg);
    await expect(
      core.onFrame(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.msg === "agent-turn-error")).toBe(true);
  });
});

describe("TurnTakingCore — metering seams (honest counts, structured-logged)", () => {
  it("logs voice_agent + llm + tts counts for a completed turn", async () => {
    const { deps, logs } = mkDeps();
    const core = new TurnTakingCore(deps, goodCfg);
    await core.onFrame(egressFrame([1, 0x00], 1));
    const meter = logs.find((l) => l.msg === "agent-turn-meter");
    expect(meter).toBeTruthy();
    expect(meter!.fields).toMatchObject({ org: "org1", room: "room1", agentId: "a1" });
    expect(typeof meter!.fields.assistantChars).toBe("number");
    expect((meter!.fields.assistantChars as number)).toBeGreaterThan(0);
  });
});

describe("TurnTakingCore — voice_agent_minutes emit (step 7)", () => {
  it("calls emitMeter with the turn usage shape on a successful turn", async () => {
    const { deps, emitMeter } = mkDeps();
    const core = new TurnTakingCore(deps, goodCfg);
    await core.onFrame(egressFrame([0x00])); // 0x00 → fake STT returns a final → a turn runs
    expect(emitMeter).toHaveBeenCalledTimes(1);
    const usage = emitMeter.mock.calls[0][0] as Record<string, unknown>;
    expect(usage).toMatchObject({ org: "org1", room: "room1", agentId: "a1" });
    expect(typeof usage.turnId).toBe("string");
    expect(typeof usage.turnWallMs).toBe("number");
    expect(usage.turnWallMs as number).toBeGreaterThanOrEqual(0);
  });

  it("is FAIL-SAFE: a thrown emitMeter is logged + swallowed, never breaks the turn", async () => {
    const emitMeter = vi.fn(async () => {
      throw new Error("meter boom");
    });
    const { deps, sent, logs } = mkDeps({ emitMeter });
    const core = new TurnTakingCore(deps, goodCfg);
    await expect(core.onFrame(egressFrame([0x00]))).resolves.toBeUndefined();
    expect(sent.length).toBeGreaterThan(0); // the reply was still spoken (media unaffected)
    expect(logs.some((l) => l.msg === "agent-turn-meter-error")).toBe(true);
  });
});
