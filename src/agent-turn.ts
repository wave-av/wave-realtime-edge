/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b), build-order step 3 — TURN-TAKING v1.
 *
 * Replaces the step-2 echo loop as the ARMED behavior with a real conversational turn, while keeping the
 * skeleton's whole philosophy: an injectable-deps seam (every external call is fakeable → zero live network in
 * unit tests), fail-safe media ops (any STT/LLM/TTS error is LOGGED, never thrown up the media path, never
 * crashes the DO), typed `AgentSessionError`, secrets referenced-never-valued, and fully INERT without the flag.
 *
 * ── THE TURN PIPELINE (all via injected deps) ───────────────────────────────────────────────────────────────
 *   PCM in (decodePacket — the PROVEN egress decoder)
 *        │  accumulate participant PCM
 *        ▼
 *   STT  (injected `transcribe`): accumulated PCM → { partial | FINAL } transcript. v1 endpointing is
 *        final-transcript-driven (the simple, correct v1). A partial does NOT fire a turn. The VAD / barge-in
 *        interrupt controller is STEP 4 — NOT built here, but NOT architected out: `onUserSpeech()` is the
 *        documented seam a step-4 controller will call to abort an in-flight turn.
 *        ▼  (final transcript = end of user turn)
 *   LLM  (injected `complete`) = Claude Opus/Sonnet via the WAVE gateway, ALWAYS (design §L1 LOCKED — never a
 *        direct vendor call). The core holds the conversation history (system + alternating user/assistant) and
 *        STREAMS the assistant text out of `complete`.
 *        ▼  assistant text (streamed)
 *   TTS  (injected `synthesize`) = ElevenLabs streaming, output pcm_48000 (zero transcode — matches ingest).
 *        Each streamed PCM chunk → `chunkPcm` → `encodeIngestFrame` → the ingest socket — the EXACT send path
 *        `echoFrame` uses. The agent track is now the synthesized reply, not the looped-back human.
 *
 * ── METERING (honest seams, step 7) ─────────────────────────────────────────────────────────────────────────
 *  `voice_agent_minutes` + LLM tokens + ElevenLabs chars are emitted to the gateway in STEP 7. Here we only
 *  STRUCTURED-LOG the counts we actually have (assistant chars, pcm bytes out, turn wall-ms). No fake meter
 *  emit (config-no-silent-noop / proven-live-or-not-done).
 *
 * ── INERT WITHOUT THE FLAG ──────────────────────────────────────────────────────────────────────────────────
 *  Nothing here runs unless `voiceAgentEnabled(env)` (VOICE_AGENT_PROVIDER==="wave"); the DO arms this core
 *  only behind that gate. `buildTurnDeps()` wires the LIVE deps from env (creds referenced, never logged).
 */
import {
  AgentSessionError,
  type AgentMediaDeps,
  type IngestSocket,
  type AgentSessionEnv,
} from "./agent-session.js";
import { decodePacket } from "./encoders/container-adapter.js";
import { type IngestFraming } from "./agent-ingest-adapter.js";
import { SpeechSession, streamSpeakSentences, type StreamSpeakAcc } from "./agent-turn-speech.js";
import { LatencyCollector, type TurnHopMarks } from "./turn-latency.js";
import { SentenceChunker } from "./sentence-chunker.js";
import { meterFinishedTurn, meterAbandonedTurn, meterSessionClose } from "./agent-turn-meter.js";
import { TurnCogsLedger } from "./voice-cogs-ledger.js";
import type { VoiceCogsRates, VoiceCogsRatesEnv } from "./voice-cogs.js";
import { Vad, vadConfigFromEnv, type VadConfig, type VadEnv } from "./agent-vad.js";
import {
  ToolAllowlist,
  toolAllowlistFromEnv,
  redactToolInput,
  assistantToolUseMessage,
  userToolResultMessage,
  type ToolDefinition,
  type ToolUse,
  type ToolResult,
  type CompletionEvent,
} from "./agent-tools.js";
import {
  emitVoiceTurnUsage,
  type VoiceMeterEnv,
  type VoiceTurnUsage,
} from "./voice-meter.js";
import {
  streamGatewayLlm,
  callGatewayTool,
  streamElevenLabs,
  upmixMonoToStereo16LE,
  transcribeViaProvider,
  buildTurnSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  normalizeGatewayEnv,
  type FetchLike,
} from "./agent-turn-providers.js";
import { streamingTranscribe } from "./agent-stt-streaming.js";

// ── Public contracts (the injectable-deps seam) ──────────────────────────────────────────────────────────────

import { runAgentTurn } from "./agent-turn-run.js";
import { DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_TTS_LEAD_MS, ttsLeadMsFromEnv, MAX_UTTERANCE_BYTES } from "./turn-config.js";
import type { SttResult, LlmMessage, AgentTurnDeps, TurnTakingConfig } from "./agent-turn-types.js";
export type {
  SttResult, LlmMessage, AgentTurnDeps, TurnTakingConfig,
} from "./agent-turn-types.js";
export type { ToolDefinition, ToolUse, ToolResult, CompletionEvent } from "./agent-tools.js";
export { ToolAllowlist } from "./agent-tools.js";
export { DEFAULT_VOICE_LLM_MODEL, ELEVENLABS_OUTPUT_FORMAT } from "./agent-turn-providers.js";
export type { AgentTurnEnv } from "./agent-turn-env.js";
export { buildTurnDeps } from "./agent-turn-env.js";
export { DEFAULT_SYSTEM_PROMPT, buildTurnSystemPrompt, normalizeGatewayEnv } from "./agent-turn-providers.js";
export { toolAllowlistFromEnv } from "./agent-tools.js";
export { DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_TTS_LEAD_MS, ttsLeadMsFromEnv, MAX_UTTERANCE_BYTES } from "./turn-config.js";

/**
 * Stop words that mute the agent (voice-control-deck E1.P1): the transcript matching one of these mutes
 * locally — no LLM turn, no TTS. Kept narrow (a real "stop" intent, not a backchannel like "uh-huh").
 */
const STOP_WORDS = new Set(["mute", "stop", "stop listening", "shut up", "turn off the mic", "be quiet"]);

/** Concatenate PCM chunks into one buffer (the utterance drain path). */
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class TurnTakingCore {
  private readonly deps: AgentTurnDeps & AgentMediaDeps;
  private readonly config: TurnTakingConfig;
  private readonly framing: IngestFraming;
  private readonly messages: LlmMessage[];
  /** PCM accumulated since the last FINAL transcript (the current user utterance). Bounded by MAX_UTTERANCE_BYTES. */
  private utterance: Uint8Array[] = [];
  /** Running byte total of `utterance` (avoids re-summing on every frame; drives bounded eviction). */
  private utteranceBytes = 0;
  private outSeq = 0;
  private readonly tsTicksRef = { value: 0 }; // session-wide RTP ts, shared into every SpeechSession (monotonic across turns)
  /** Guards against re-entrant turns (a turn is in flight while we await STT/LLM/TTS). */
  private turnInFlight = false;
  /** Set when a stop word mutes the agent (voice-control-deck E1) — the DO reads it and drops the egress audio. */
  muteRequested = false;
  /** Echo-mute window end (ms) — frames are dropped until this wall-clock (the "agent hears itself" backstop). */
  private echoMuteUntil = 0;
  /** Echo-mute grace after a turn (ms) — the reverberation tail before the next STT. Env AGENT_ECHO_MUTE_MS. */
  private echoMuteMs: number; // settable via TurnRunContext.state (the loop mutes echo during TTS)
  /** Set by the step-4 interrupt controller (onUserSpeech / VAD barge-in) to cancel an in-flight turn. */
  private aborted = false;
  /** Step-4 VAD: detects user speech ONSET on every frame → drives true barge-in while the agent talks. */
  private readonly vad: Vad;
  /** Frame counter (since the in-flight turn started) used to instrument barge-in detection→abort latency. */
  private framesThisTurn = 0;
  /** Monotonic turn counter (since core construction) → a stable per-turn id for idempotent metering. */
  private turnSeq = 0;
  /** Step-5 agent-least-privilege: the EXPLICIT tool definitions this agent may run (empty = text-only). */
  private readonly tools: ToolAllowlist;
  /** Step-5 hard cap on tool-call iterations within ONE turn — prevents an infinite (model→tool→model→…) loop. */
  private readonly maxToolIterations: number;
  /** Step-4 barge-in: TTS send-ahead lead (ms). `speak()` paces to this so playout is interruptible (see speak). */
  private readonly ttsLeadMs: number;
  /** D1: this turn already spliced its history commit (full OR spoken-prefix). Guarantees at-most-once. */
  private committed = false;
  /** E0-P2 — the session's COGS ledger (DO wall-clock + STT submitted audio). Lives in its own module. */
  private readonly cogs: TurnCogsLedger;
  /** E1 Task 7 measurement harness: per-turn hop marks (speech-end → STT → LLM → TTS). Additive — the
   *  core's flow is unchanged; the marks only timestamp the hop boundaries and record a sample. */
  private readonly latency = new LatencyCollector();
  private currentMarks?: TurnHopMarks;
  /** E0-P2 — vendor rates, if provisioned. Absent ⇒ the COGS receipt reports `unpriced` rather than a guess. */
  private readonly cogsRates?: VoiceCogsRates;

  constructor(
    deps: AgentTurnDeps & AgentMediaDeps,
    config: TurnTakingConfig,
    opts?: {
      framing?: IngestFraming;
      vad?: Partial<VadConfig>;
      /** Step-5: the agent-least-privilege tool allowlist. Omitted/empty → the agent runs text-only. */
      tools?: ToolAllowlist;
      /** Step-5: hard max-iterations cap for the agentic tool loop (default DEFAULT_MAX_TOOL_ITERATIONS). */
      maxToolIterations?: number;
      /** Step-4: TTS send-ahead lead (ms) for real-time pacing → interruptible playout (default DEFAULT_TTS_LEAD_MS). */
      ttsLeadMs?: number;
      /** E0-P2: vendor COGS rates. Omitted ⇒ quantities are measured and reported UNPRICED (never estimated). */
      cogsRates?: VoiceCogsRates;
      /** Echo-mute grace after a turn (ms) — the reverberation tail before the next STT (default 400). */
      echoMuteMs?: number;
    },
  ) {
    this.deps = deps;
    this.config = config;
    this.framing = opts?.framing ?? "packet";
    this.messages = [{ role: "system", content: buildTurnSystemPrompt(config) }];
    this.vad = new Vad(opts?.vad);
    this.cogs = new TurnCogsLedger(() => this.deps.now());
    this.cogsRates = opts?.cogsRates;
    this.ttsLeadMs = typeof opts?.ttsLeadMs === "number" && opts.ttsLeadMs >= 0 ? Math.floor(opts.ttsLeadMs) : DEFAULT_TTS_LEAD_MS;
    this.echoMuteMs = typeof opts?.echoMuteMs === "number" && opts.echoMuteMs >= 0 ? Math.floor(opts.echoMuteMs) : 0;
    this.tools = opts?.tools ?? new ToolAllowlist([]);
    this.maxToolIterations =
      typeof opts?.maxToolIterations === "number" && opts.maxToolIterations >= 1
        ? Math.floor(opts.maxToolIterations)
        : DEFAULT_MAX_TOOL_ITERATIONS;
  }

  /** A copy of the conversation history (system + alternating user/assistant). For tests + DO snapshotting. */
  history(): readonly LlmMessage[] {
    return this.messages.slice();
  }

  /**
   * Feed ONE raw egress WS binary frame (one Packet): decode → accumulate PCM → STT → (on FINAL) run the turn.
   * Fail-safe: ANY error at any stage is logged and swallowed (never breaks the live media the SFU pushes).
   * Final-transcript-driven endpointing (v1). A partial transcript only accumulates; no turn fires.
   */
  async onFrame(frame: Uint8Array): Promise<void> {
    let stage = "decode";
    try {
      const pkt = decodePacket(frame);
      if (pkt.payload.length === 0) return; // keep-alive / empty
      // ECHO MUTE (the "agent hears itself" fix): for a short grace window after each turn we DROP the egress audio
      // so the agent's own TTS (picked up by a mic that hears the speaker) is never transcribed as the next utterance.
      // This is the code-level echo mitigation — real deployments add WebRTC echo cancellation on the client; this
      // window is the edge-side backstop for a raw mic+speaker rig. It also eats a fast barge-in inside the window,
      // which is the documented tradeoff (env-tunable; 0 disables).
      if (this.deps.now() < this.echoMuteUntil) return;
      // VAD runs on EVERY decoded frame (design §L2.1) — it's the barge-in trigger AND the silence sensor.
      stage = "vad";
      const vadEvent = this.vad.feed(pkt.payload);
      this.pushUtterance(pkt.payload);
      if (this.turnInFlight) {
        // Agent is speaking. A sustained speech ONSET = the user barged in → abort the in-flight turn NOW so the
        // agent goes silent immediately. The interrupting PCM is already accumulating (pushed above) → it becomes
        // the next utterance. This is the real barge-in wiring (onUserSpeech was only an external seam in step 3).
        this.framesThisTurn += 1;
        if (vadEvent === "speech-start") this.bargeIn();
        return; // while a turn is in flight we never start STT — accumulate + (maybe) interrupt
      }
      // SILENCE-GATED ENDPOINTING (design §L2.2): run STT + fire a turn ONLY when the VAD declares the user has
      // FINISHED speaking (speech-end = a real silence hangover). The prior version polled STT on EVERY decoded
      // frame, each re-transcribing the whole growing buffer — at ~50 frames/s that serialized the DO into
      // `loadShed` (a ~700ms batch STT POST per frame) AND fired turns on fragmented buffers (often empty → no
      // turn). Now we accumulate while the user talks and run exactly ONE batch STT per utterance, after silence.
      // Frames keep advancing the VAD above; nothing else happens until the hangover trips speech-end.
      if (vadEvent !== "speech-end") return; // still speaking, or steady silence → accumulate only
      this.currentMarks = { turnId: `t${this.turnSeq}`, speechEndMs: this.deps.now() }; // E1 harness: hop 0
      this.deps.log("agent-vad-endpoint", { ...this.idFields(), rms: Math.round(this.vad.lastFrameRms) });
      stage = "stt";
      const pcm = concat(this.utterance);
      this.cogs.recordStt(pcm.length); // E0-P2: what the STT vendor bills is the buffer we POST, padding included
      this.resetUtterance(); // the utterance ended at speech-end — consume it regardless of the STT outcome
      const stt = await this.deps.transcribe(pcm);
      if (this.currentMarks) this.currentMarks.sttFinalMs = this.deps.now(); // E1 harness: hop 1 (the named risk)
      if (!stt.isFinal) return; // a future STREAMING STT may emit partials behind this same seam; v1 batch ⇒ final
      const userText = stt.transcript.trim();
      this.deps.log("agent-stt-result", { len: userText.length, transcript: userText.slice(0, 80), pcmBytes: pcm.length, rms: Math.round(this.vad.lastFrameRms) });
      if (userText.length === 0) return; // silence / nothing recognized → no turn
      // Stop words (voice-control-deck E1.P1): "mute"/"stop"/"shut up" mute the agent locally — no LLM turn,
      // no TTS, no meter. The DO reads `muteRequested` and drops the egress audio until unmute.
      if (STOP_WORDS.has(userText.toLowerCase())) {
        this.muteRequested = true;
        this.deps.log("agent-mute-intent", { transcript: userText });
        return;
      }
      await this.runTurn(userText);
    } catch (e) {
      this.deps.log("agent-turn-error", { stage, message: (e as Error)?.message ?? "unknown" });
    }
  }

  /**
   * Run ONE turn for a final user transcript — the BOUNDED AGENTIC TOOL LOOP (step 5):
   *   complete(history, tools) → if the model emitted tool_use blocks: execute each (allowlist-gated), append the
   *   assistant(tool_use) + user(tool_result) pair to the working history (strict Anthropic shapes), re-call.
   *   Repeat until the model returns TEXT with no tool_use OR a HARD max-iterations cap (anti-runaway). Then the
   *   final assistant TEXT → ElevenLabs TTS → publish PCM out (the step-3/4 path, unchanged).
   *
   * History correctness + atomicity: the user message and every assistant/tool pair accumulate in a LOCAL working
   * list; `this.messages` is committed ATOMICALLY (one splice) ONLY on a successful, non-aborted final reply — so an
   * aborted / empty / failed turn leaves NO dangling user (or half-applied tool) messages and the strict
   * user/assistant alternation Claude requires is preserved across tool turns. `aborted` (barge-in) is honored at
   * EVERY await — the LLM stream, between iterations, DURING tool execution, and the TTS publish.
   */
  private async runTurn(userText: string): Promise<void> {
    // The turn LOOP lives in agent-turn-run.ts (token-budget decompose, 2026-08-30): the loop is the
    // use case, the class is the session state machine, and TurnRunContext is the honest contract
    // between them — every field a thing the loop needs from the session, named, instead of
    // seventeen this.* captures. Moved verbatim; this delegation owns the mutable state mapping.
    const outer = this;
    await runAgentTurn(
      {
        deps: this.deps,
        config: this.config,
        messages: this.messages,
        tools: this.tools,
        vad: this.vad,
        latency: this.latency,
        cogs: this.cogs,
        cogsRates: this.cogsRates,
        state: {
          get turnInFlight() { return outer.turnInFlight; }, set turnInFlight(v) { outer.turnInFlight = v; },
          get aborted() { return outer.aborted; }, set aborted(v) { outer.aborted = v; },
          get committed() { return outer.committed; }, set committed(v) { outer.committed = v; },
          get framesThisTurn() { return outer.framesThisTurn; }, set framesThisTurn(v) { outer.framesThisTurn = v; },
          get turnSeq() { return outer.turnSeq; }, set turnSeq(v) { outer.turnSeq = v; },
          get echoMuteMs() { return outer.echoMuteMs; }, set echoMuteMs(v) { outer.echoMuteMs = v; },
          get echoMuteUntil() { return outer.echoMuteUntil; }, set echoMuteUntil(v) { outer.echoMuteUntil = v; },
        },
        maxToolIterations: this.maxToolIterations,
        currentMarks: this.currentMarks,
        idFields: () => this.idFields(),
        openSpeech: () => this.openSpeech(),
        commitSpoken: (w, s, r) => this.commitSpoken(w, s, r),
        logMeter: (u, a, t, i, s, sp) => this.logMeter(u, a, t, i, s, sp),
        resetUtterance: () => this.resetUtterance(),
        executeTools: (uses) => this.executeTools(uses),
      },
      userText,
    );
  }

  /** E1 Task 7: the accumulated per-hop latency distribution (p50/p95 over the recorded turns). */
  distribution(): { hop: "stt" | "llm" | "tts" | "total"; p50: number; p95: number; n: number }[] {
    return this.latency.distribution();
  }

  /**
   * Execute the model-requested tool_use blocks (agent-least-privilege). For EACH: refuse (an is_error tool_result,
   * logged, NEVER executed) any name not on the allowlist; otherwise call `callTool` and return its result. A
   * thrown executor is fail-safe — it becomes an is_error tool_result (the model can react / the loop ends), it is
   * NOT thrown up the media path. Audit: each tool is structured-logged by NAME + a REDACTED input size summary —
   * the raw input (possible PII/secrets) is never logged verbatim. Honors barge-in between tools.
   */
  private async executeTools(toolUses: ToolUse[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const t of toolUses) {
      if (this.aborted) break;
      const audit = redactToolInput(t.input);
      if (!this.tools.isAllowed(t.name)) {
        // REFUSE — a model-requested tool not on the explicit allowlist is never executed (least-privilege).
        this.deps.log("agent-tool-refused", { ...this.idFields(), tool: t.name, ...audit });
        results.push({ tool_use_id: t.id, content: `tool not permitted: ${t.name}`, is_error: true });
        continue;
      }
      try {
        const out = await this.deps.callTool(t.name, t.input);
        this.deps.log("agent-tool-call", { ...this.idFields(), tool: t.name, ok: true, ...audit });
        results.push({ tool_use_id: t.id, content: out, is_error: false });
      } catch (e) {
        // Fail-safe: an executor throw is captured as an error tool_result (logged), never thrown up the media path.
        this.deps.log("agent-tool-error", {
          ...this.idFields(),
          tool: t.name,
          ...audit,
          message: (e as Error)?.message ?? "unknown",
        });
        results.push({ tool_use_id: t.id, content: `tool error: ${t.name}`, is_error: true });
      }
    }
    return results;
  }

  /**
   * Open the per-turn SPEECH session (TTS → paced ingest publish). One session per turn; `speak()` on it may be
   * called once per sentence (D1) and the media clock + pacing window continue across those calls. The publish
   * loop itself lives in agent-turn-speech.ts (file-size-two-tier-gate: policy here, wire mechanics there).
   */
  private openSpeech(): SpeechSession {
    return new SpeechSession(this.deps, {
      ttsLeadMs: this.ttsLeadMs,
      framing: this.framing,
      isAborted: () => this.aborted,
      nextSeq: () => this.outSeq++,
      idFields: () => this.idFields(),
      flowTap: this.deps.flowTap,
      tsTicks: this.tsTicksRef,
    });
  }

  /** Account for a finished turn (counts + E0-P2 COGS + the billable emit). Body: agent-turn-meter.ts. */
  private async logMeter(
    userText: string,
    assistant: string,
    toolsUsed: number,
    turnId: string,
    startMs: number,
    speech: SpeechSession,
  ): Promise<void> {
    const { org, roomId: room, agentId } = this.config;
    const who = { org, room, agentId, ledger: this.cogs, rates: this.cogsRates };
    await meterFinishedTurn(this.deps, this.idFields(), who, { userText, assistant, toolsUsed, turnId, startMs, speech });
  }

  /**
   * E0-P2 — session-end receipt: flush the FINAL idle DO slice (last closed turn → teardown, plus any STT that
   * never became a turn) as one `agent-session-cogs` line. Idempotent and log-only (agent-turn-meter.ts), so it
   * is safe to call from any teardown path, any number of times.
   */
  closeSession(): void {
    meterSessionClose(this.deps, this.idFields(), { ledger: this.cogs });
  }

  /**
   * HONEST PARTIAL COMMIT (D1). When a turn dies mid-utterance — a barge-in, or a fail-closed mid-stream LLM
   * error (#344) — audio already published cannot be unheard. Committing exactly the SPOKEN prefix keeps history
   * equal to what the listener actually heard, so the next turn doesn't repeat or contradict itself; committing
   * the model's UNSPOKEN remainder would be a lie in the other direction. One splice, at most once per turn, and
   * only when something was really spoken (otherwise the turn leaves NO dangling user message, exactly as today).
   */
  private commitSpoken(working: LlmMessage[], spoken: string, reason: string): void {
    const text = spoken.trim();
    if (this.committed || text.length === 0) return;
    this.committed = true;
    working.push({ role: "assistant", content: text });
    this.messages.push(...working.slice(this.messages.length));
    this.deps.log("agent-turn-partial-spoken", { ...this.idFields(), reason, spokenChars: text.length });
  }

  /**
   * EXTERNAL barge-in seam: an out-of-band controller (e.g. a streaming-STT partial, a UI "stop", or a future
   * semantic endpointer) can also force an interrupt. Same effect as the VAD-driven `bargeIn()`. Kept so the
   * abort path has ONE owner regardless of the trigger source (design §L2.1: abort TTS + cancel LLM).
   */
  onUserSpeech(): void {
    this.bargeIn();
  }

  /**
   * Fire a barge-in: abort the in-flight turn so the LLM stream + TTS publish loops break on their next `aborted`
   * check and the agent goes silent. No-op when no turn is in flight (nothing to interrupt). Latency-instrumented:
   * we LOG the frame count from turn-start → this abort so a LIVE run can later prove the <300ms target — we make
   * NO latency claim here (no live run yet; proven-live-or-not-done). Idempotent within a turn (only the first
   * onset logs/sets; the TTS/LLM loops already broke on the flag).
   */
  private bargeIn(): void {
    if (!this.turnInFlight || this.aborted) return;
    this.aborted = true;
    this.deps.log("agent-turn-interrupt", {
      ...this.idFields(),
      // frames observed between turn-start and the detected onset — the wall-ms is the LIVE-run measurement.
      framesToAbort: this.framesThisTurn,
      onsetRms: Math.round(this.vad.lastFrameRms),
      // TODO(#81 step 4 LIVE-spike): on the Jake-named edge deploy, derive wall-ms from frame source timestamps
      //                              (FrameTiming) to PROVE detected-onset→silence < ~300ms end-to-end.
    });
  }

  /**
   * Append one PCM frame to the accumulated utterance, BOUNDED. Without this cap the buffer grows for the whole
   * session whenever audio never endpoints (continuous talker / partial-only STT / long in-flight turn) until the
   * DO isolate hits its 128 MB limit and resets mid-turn — the agent never gets to speak. Over MAX_UTTERANCE_BYTES
   * we drop OLDEST frames (always keep ≥1) so STT + barge-in still see the most recent ~15 s of context.
   */
  private pushUtterance(payload: Uint8Array): void {
    this.utterance.push(payload);
    this.utteranceBytes += payload.length;
    while (this.utteranceBytes > MAX_UTTERANCE_BYTES && this.utterance.length > 1) {
      const dropped = this.utterance.shift()!;
      this.utteranceBytes -= dropped.length;
    }
  }

  /** Clear the accumulated utterance + its byte counter (after a FINAL transcript consumes it). */
  private resetUtterance(): void {
    this.utterance = [];
    this.utteranceBytes = 0;
  }

  private idFields(): Record<string, unknown> {
    return { org: this.config.org, room: this.config.roomId, agentId: this.config.agentId };
  }
}

/** Concatenate PCM chunks into one buffer (the accumulated utterance handed to STT). */