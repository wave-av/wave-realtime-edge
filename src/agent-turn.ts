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
import { chunkPcm, encodeIngestFrame, type IngestFraming } from "./agent-ingest-adapter.js";
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
import { pcmToWav, WAV_MIME } from "./pcm-wav.js";

// ── Public contracts (the injectable-deps seam) ──────────────────────────────────────────────────────────────

/** One STT result for the accumulated PCM. `isFinal` = end-of-user-turn (the v1 endpointing signal). */
export interface SttResult {
  isFinal: boolean;
  /** The (partial or final) transcript text. Empty string = silence/no speech. */
  transcript: string;
}

/**
 * One LLM chat message — the gateway/Claude message shape (system + alternating user/assistant). `content` is a
 * plain string for the common case, OR an Anthropic content-block array for the tool turns (an assistant message
 * carrying `tool_use` blocks, and the matching `user` message carrying `tool_result` blocks). The strict
 * user/assistant alternation Claude requires is preserved across tool turns by the bounded loop in runTurn.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

/**
 * The turn-taking deps seam — extends the media seam with the three step-3 externals. ALL fakeable: the live DO
 * wires them to real STT / WAVE-gateway / ElevenLabs in `buildTurnDeps()`; unit tests pass fakes (no network).
 */
export interface AgentTurnDeps {
  /**
   * STT: feed the PCM accumulated since the last final; resolve a partial or FINAL transcript. Streaming impls
   * may ignore the buffer and read their own socket — the buffer is the simple, provider-agnostic v1 contract.
   * Fail-safe: a throw is caught by the core (logged stage="stt", turn aborted).
   */
  transcribe(pcm: Uint8Array): Promise<SttResult>;
  /**
   * LLM via the WAVE gateway (Claude Opus/Sonnet, ALWAYS). Streams a DISCRIMINATED UNION of events given the full
   * message history (system + alternating user/assistant) AND the allowlisted tool definitions to offer the model:
   *   • { type:"text", text }                — an assistant text delta (streamed to TTS, exactly as step 3/4).
   *   • { type:"tool_use", id, name, input } — a COMPLETED tool_use block (Anthropic), to be executed mid-turn.
   * An async generator so text streams to TTS incrementally and is cancellable on barge-in (step 4). The `tools`
   * arg is the agent-least-privilege allowlist (step 5) — only these are ever advertised to the model. Fail-safe:
   * a throw is caught by the core (logged stage="llm").
   */
  complete(messages: LlmMessage[], tools: ToolDefinition[]): AsyncIterable<CompletionEvent>;
  /**
   * Execute ONE allowlisted tool via the WAVE gateway / MCP (step 5). The core only ever calls this AFTER its
   * allowlist check passes (agent-least-privilege). Returns the stringified tool result. Fail-safe: a throw is
   * caught by the core (logged stage="tool", turned into an is_error tool_result; the turn is abandoned cleanly).
   * Secrets/PII in `input` are NEVER logged verbatim (the core logs name + a redacted size summary only).
   */
  callTool(name: string, input: unknown): Promise<string>;
  /**
   * TTS = ElevenLabs streaming → pcm_48000 chunks (16-bit LE, 48 kHz — matches the ingest path, zero transcode).
   * An async generator so audio streams out as it's synthesized. Fail-safe: a throw is caught (logged stage="tts").
   */
  synthesize(text: string): AsyncIterable<Uint8Array>;
  /**
   * Step-7 METERING: emit one completed turn's `voice_agent_minutes` usage to the gateway. Fire-and-forget +
   * FAIL-OPEN — a metering error NEVER breaks the turn or drops media (the live impl swallows + logs). The core
   * awaits it inside a try/catch so even a thrown emit can't propagate up the media path. Live impl in
   * `buildTurnDeps` mirrors src/metering.ts (POST /v1/internal/usage, service token); tests pass a fake.
   */
  emitMeter(usage: VoiceTurnUsage): Promise<void>;
}

/** Config to run a turn-taking session for one room/participant (superset of the bind config + the persona). */
export interface TurnTakingConfig {
  roomId: string;
  org: string;
  agentId: string;
  participantSessionId: string;
  participantTrackName: string;
  /** The agent persona / system prompt. Falls back to a sensible default when unset. */
  systemPrompt?: string;
}

/** The default agent persona when none is configured (honest, generic — a real persona is set per-agent). */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, concise WAVE voice agent. Reply in short, natural spoken sentences.";

/** Step-5 hard default cap on tool-call iterations within ONE turn (anti-runaway). Overridable per-core. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 5;

/** The configured persona, or the default. Pure → unit-testable. */
export function buildTurnSystemPrompt(config: Pick<TurnTakingConfig, "systemPrompt">): string {
  const p = (config.systemPrompt ?? "").trim();
  return p.length > 0 ? p : DEFAULT_SYSTEM_PROMPT;
}

/**
 * TurnTakingCore — the pure, testable turn state machine for one agent session. Accumulates participant PCM,
 * runs STT → (on final) LLM via the gateway → ElevenLabs TTS → publishes PCM out the ingest socket. Holds the
 * conversation history. Persists nothing itself (the DO wrapper owns DO storage). Every stage is fail-safe: an
 * error is logged via the injected `log` and the turn is abandoned — it is NEVER thrown up the media path.
 */
export class TurnTakingCore {
  private readonly deps: AgentTurnDeps & AgentMediaDeps;
  private readonly config: TurnTakingConfig;
  private readonly framing: IngestFraming;
  private readonly messages: LlmMessage[];
  /** PCM accumulated since the last FINAL transcript (the current user utterance). */
  private utterance: Uint8Array[] = [];
  private outSeq = 0;
  /** Guards against re-entrant turns (a turn is in flight while we await STT/LLM/TTS). */
  private turnInFlight = false;
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
    },
  ) {
    this.deps = deps;
    this.config = config;
    this.framing = opts?.framing ?? "packet";
    this.messages = [{ role: "system", content: buildTurnSystemPrompt(config) }];
    this.vad = new Vad(opts?.vad);
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
      // VAD runs on EVERY decoded frame (design §L2.1) — it's the barge-in trigger AND the silence sensor.
      stage = "vad";
      const vadEvent = this.vad.feed(pkt.payload);
      this.utterance.push(pkt.payload);
      if (this.turnInFlight) {
        // Agent is speaking. A sustained speech ONSET = the user barged in → abort the in-flight turn NOW so the
        // agent goes silent immediately. The interrupting PCM is already accumulating (pushed above) → it becomes
        // the next utterance. This is the real barge-in wiring (onUserSpeech was only an external seam in step 3).
        this.framesThisTurn += 1;
        if (vadEvent === "speech-start") this.bargeIn();
        return; // while a turn is in flight we never start STT — accumulate + (maybe) interrupt
      }
      if (vadEvent === "speech-end") {
        // VAD endpointing SEAM (design §L2.2): a real silence-hangover ended the user's speech. v1 endpointing
        // stays final-transcript-driven below (STT decides the turn) so we never cut the user off on energy alone;
        // this transition is observed for the future semantic+silence endpointing refinement.
        // TODO(#81 step 4 follow-up): complement final-transcript endpointing with this silence signal once the
        //                             streaming-STT contract lands (pin debounce so a hard-silence ends the turn
        //                             faster without truncating slow speakers). Barge-in is the must-ship here.
        this.deps.log("agent-vad-endpoint", { ...this.idFields(), rms: Math.round(this.vad.lastFrameRms) });
      }
      stage = "stt";
      const pcm = concat(this.utterance);
      const stt = await this.deps.transcribe(pcm);
      if (!stt.isFinal) return; // partial — keep accumulating (v1 endpointing is final-driven)
      const userText = stt.transcript.trim();
      this.utterance = []; // consume the utterance now that it's final
      if (userText.length === 0) return; // final-but-empty (silence) → no turn
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
    this.turnInFlight = true;
    this.aborted = false;
    this.framesThisTurn = 0;
    const turnId = `t${this.turnSeq++}`;
    // The user's final utterance was just consumed → reset the VAD to silence so the FIRST sustained speech onset
    // while the agent talks is detected cleanly as a fresh barge-in (not contaminated by the prior episode's run).
    this.vad.reset();
    const startMs = this.deps.now();
    let stage = "llm";
    try {
      const userMsg: LlmMessage = { role: "user", content: userText };
      // The working history for THIS turn (committed state + this turn's user/assistant/tool messages). Nothing is
      // pushed to this.messages until the final atomic commit below.
      const working: LlmMessage[] = [...this.messages, userMsg];
      const toolDefs = this.tools.definitions();
      let toolsUsed = 0;

      // ── the bounded agentic loop ──────────────────────────────────────────────────────────────────────────
      for (let iter = 0; ; iter++) {
        stage = "llm";
        // Stream this iteration: collect text (only the FINAL no-tool iteration's text is spoken) + tool_use blocks.
        let assistant = "";
        const toolUses: ToolUse[] = [];
        for await (const evt of this.deps.complete([...working], toolDefs)) {
          if (this.aborted) break; // step-4 barge-in: cancel the in-flight stream
          if (evt.type === "text") assistant += evt.text;
          else toolUses.push({ id: evt.id, name: evt.name, input: evt.input });
        }
        if (this.aborted) return;

        // No tool calls → this is the final assistant turn. Speak it.
        if (toolUses.length === 0) {
          assistant = assistant.trim();
          if (assistant.length === 0) {
            this.deps.log("agent-turn-empty-llm", this.idFields());
            return; // nothing to say + nothing to commit → clean abandon (no dangling user)
          }
          working.push({ role: "assistant", content: assistant });
          // Commit the WHOLE turn atomically (user + every assistant/tool message produced this turn).
          this.messages.push(...working.slice(this.messages.length));
          stage = "tts";
          const pcmBytesOut = await this.speak(assistant);
          if (pcmBytesOut < 0) return; // aborted mid-TTS (already committed history is valid + alternating)
          await this.logMeter(userText, assistant, toolsUsed, pcmBytesOut, startMs, turnId);
          return;
        }

        // The model wants to use tools. Stop at the hard cap (anti-runaway) — DON'T execute another round.
        if (iter >= this.maxToolIterations) {
          this.deps.log("agent-turn-tool-cap", { ...this.idFields(), maxToolIterations: this.maxToolIterations });
          return; // abandon cleanly — no commit (no partial tool turn leaks into committed history)
        }

        // Append the assistant(tool_use) message verbatim (history must replay the model's tool_use blocks), then
        // execute each requested tool (allowlist-gated) and append the matching user(tool_result) message.
        working.push(assistantToolUseMessage(toolUses) as LlmMessage);
        stage = "tool";
        const results = await this.executeTools(toolUses);
        if (this.aborted) return; // barge-in DURING tool execution → abandon (nothing committed)
        toolsUsed += results.length;
        working.push(userToolResultMessage(results) as LlmMessage);
        // loop: re-call the LLM with the tool_result(s) in history
      }
    } catch (e) {
      this.deps.log("agent-turn-error", { stage, ...this.idFields(), message: (e as Error)?.message ?? "unknown" });
    } finally {
      this.turnInFlight = false;
    }
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
   * Speak the final assistant text via ElevenLabs streaming TTS → ingest socket (the EXACT echoFrame send path).
   * Returns the PCM bytes published, or -1 if a barge-in aborted mid-stream (the agent went silent). Honors abort.
   */
  private async speak(text: string): Promise<number> {
    let pcmBytesOut = 0;
    const sock = this.deps.ingestSocket();
    for await (const pcm of this.deps.synthesize(text)) {
      if (this.aborted) return -1; // barge-in: stop publishing the now-stale reply mid-stream
      if (!sock || pcm.length === 0) continue;
      for (const chunk of chunkPcm(pcm)) {
        const seq = this.outSeq++;
        // timestamp 0: a real source timeline lands with the live ingest wiring slice; the contract field is
        // present + monotonic-by-seq. (proven-live-or-not-done: not claiming a real media timeline yet.)
        const wire = encodeIngestFrame(chunk, { sequenceNumber: seq, timestamp: 0 }, this.framing);
        sock.send(wire);
        pcmBytesOut += chunk.length;
      }
    }
    return pcmBytesOut;
  }

  /**
   * Structured-log the honest per-turn counts AND emit the real `voice_agent_minutes` usage to the gateway
   * (step 7). The emit is FAIL-OPEN: it is awaited inside a try/catch so a metering error (or a thrown fake)
   * is logged and swallowed — it NEVER breaks the turn or drops media. The live `emitMeter` (buildTurnDeps)
   * mirrors src/metering.ts (POST /v1/internal/usage). turnWallMs drives the billable fractional minutes.
   */
  private async logMeter(
    userText: string,
    assistant: string,
    toolsUsed: number,
    pcmBytesOut: number,
    startMs: number,
    turnId: string,
  ): Promise<void> {
    const turnWallMs = this.deps.now() - startMs;
    this.deps.log("agent-turn-meter", {
      ...this.idFields(),
      turnId,
      userChars: userText.length,
      assistantChars: assistant.length,
      toolsUsed,
      pcmBytesOut,
      turnWallMs,
    });
    try {
      await this.deps.emitMeter({
        org: this.config.org,
        room: this.config.roomId,
        agentId: this.config.agentId,
        turnId,
        turnWallMs,
        llmChars: assistant.length,
        ttsChars: assistant.length,
        toolsUsed,
      });
    } catch (e) {
      // Fail-open: a metering error must NEVER break the turn (media-safety). Logged, swallowed.
      this.deps.log("agent-turn-meter-error", { ...this.idFields(), message: (e as Error)?.message ?? "unknown" });
    }
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

  private idFields(): Record<string, unknown> {
    return { org: this.config.org, room: this.config.roomId, agentId: this.config.agentId };
  }
}

/** Concatenate PCM chunks into one buffer (the accumulated utterance handed to STT). */
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

// ── Live deps wiring (env → real STT / WAVE-gateway / ElevenLabs). Creds referenced, NEVER logged/returned. ──

/**
 * Env the turn-taking LIVE deps read. All step-3 creds are added here as HONEST names — real values come from
 * Doppler at deploy. INERT until provisioned: a missing cred fails its stage CLOSED (logged, turn abandoned),
 * it never crashes the DO. Extends AgentSessionEnv so the DO env is one shape.
 */
export interface AgentTurnEnv extends AgentSessionEnv, VadEnv, VoiceMeterEnv {
  /** WAVE gateway origin for the LLM proxy (var; not a secret). e.g. https://api.wave.online */
  WAVE_GATEWAY_BASE?: string;
  /** Internal service-to-service bearer for the gateway LLM proxy (secret; deploy-time, never logged). */
  WAVE_GATEWAY_TOKEN?: string;
  /** Claude model id routed through the gateway (Opus/Sonnet per design). Defaults to a sensible Sonnet. */
  VOICE_AGENT_LLM_MODEL?: string;
  /** ElevenLabs API key (secret; server-side ONLY, never client, never logged). */
  ELEVENLABS_API_KEY?: string;
  /** ElevenLabs voice id for the agent persona (var). */
  ELEVENLABS_VOICE_ID?: string;
  /**
   * STT gateway base (var). The WAVE transcribe spoke is reached THROUGH the gateway (metering-governed).
   * Defaults to WAVE_GATEWAY_BASE when unset (one gateway origin serves both LLM + STT). e.g. https://api.wave.online
   */
  VOICE_AGENT_STT_BASE?: string;
  /** STT gateway internal service Bearer (secret; never logged). Defaults to WAVE_GATEWAY_TOKEN when unset. */
  VOICE_AGENT_STT_TOKEN?: string;
  /** STT engine routed by the transcribe spoke (var): auto|whisper|deepgram|elevenlabs. Default "auto". */
  VOICE_AGENT_STT_ENGINE?: string;
  /** STT path on the gateway/spoke (var). Default /v1/transcribe (the transcribe spoke's batch endpoint). */
  VOICE_AGENT_STT_PATH?: string;
  /**
   * Step-5 agent-least-privilege tool ALLOWLIST (var; JSON array of {name,description,input_schema}). The agent
   * advertises ONLY these to the model + refuses any unlisted tool. Unset/blank/garbage → NO tools (fail closed).
   */
  VOICE_AGENT_TOOLS?: string;
  /** Step-5 gateway tool-exec path override (var). Default /v1/internal/tools/exec (TODO #81: pin with gateway). */
  VOICE_AGENT_TOOL_EXEC_PATH?: string;
}

/** Default Claude model routed through the gateway. Sonnet = the sensible voice default (latency/cost); Opus is
 *  selectable via VOICE_AGENT_LLM_MODEL per the design's Opus/Sonnet choice. */
export const DEFAULT_VOICE_LLM_MODEL = "claude-sonnet-4-6";
/** ElevenLabs streaming output format — pcm_48000 = 16-bit LE PCM @ 48 kHz, exactly the ingest path's codec. */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_48000";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Build the LIVE turn-taking deps from env. Wires:
 *   • transcribe → the streaming STT provider (TODO #81 step 3 finalize: the in-repo #43 captions/STT spoke is
 *     the intended source — until that streaming contract is pinned, this fails CLOSED when STT creds are unset
 *     rather than faking a transcript. It is a documented honest gap, NOT a silent no-op).
 *   • complete   → the WAVE gateway LLM proxy (Claude Opus/Sonnet), streamed (SSE/NDJSON), Bearer service token.
 *   • synthesize → ElevenLabs streaming TTS, pcm_48000, key server-side only.
 * Tests pass fakes instead of calling this. The DO calls this ONLY behind voiceAgentEnabled(env).
 */
/**
 * Normalize the gateway base/token to ONE canonical pair so a single operator-provided set provisions EVERY
 * gateway path (LLM, STT, tools, metering). The voice runtime introduced `WAVE_GATEWAY_BASE`/`WAVE_GATEWAY_TOKEN`,
 * but the established edge convention (metering.ts, room.ts) is `GATEWAY_BASE_URL`/`WAVE_SERVICE_TOKEN`. Without
 * this, setting one pair leaves the other path silently INERT (e.g. LLM works but billing emits nothing) — a
 * config-no-silent-noop trap. We fill BOTH names from whichever is set (voice name wins when both are present),
 * so an operator may provision EITHER convention and every path resolves. Pure → unit-testable.
 */
export function normalizeGatewayEnv(env: AgentTurnEnv): AgentTurnEnv {
  const base = env.WAVE_GATEWAY_BASE ?? env.GATEWAY_BASE_URL;
  const token = env.WAVE_GATEWAY_TOKEN ?? env.WAVE_SERVICE_TOKEN;
  return {
    ...env,
    WAVE_GATEWAY_BASE: base,
    WAVE_GATEWAY_TOKEN: token,
    GATEWAY_BASE_URL: env.GATEWAY_BASE_URL ?? base,
    WAVE_SERVICE_TOKEN: env.WAVE_SERVICE_TOKEN ?? token,
  };
}

export function buildTurnDeps(
  rawEnv: AgentTurnEnv,
  media: AgentMediaDeps,
  fetchImpl: FetchLike = fetch,
): AgentTurnDeps & AgentMediaDeps {
  // One canonical gateway base/token for ALL paths (LLM, STT, tools, metering) — either convention provisions all.
  const env = normalizeGatewayEnv(rawEnv);
  return {
    ...media,
    async transcribe(pcm: Uint8Array): Promise<SttResult> {
      const base = env.VOICE_AGENT_STT_BASE ?? env.WAVE_GATEWAY_BASE;
      const token = env.VOICE_AGENT_STT_TOKEN ?? env.WAVE_GATEWAY_TOKEN;
      if (!base || !token) {
        // Fail CLOSED + loud — the WAVE transcribe spoke (gateway-fronted) is not provisioned. NEVER a fake.
        throw new AgentSessionError("STT_NOT_CONFIGURED", "STT gateway base/token not provisioned", 503);
      }
      return transcribeViaProvider(fetchImpl, env, base, token, pcm);
    },
    async *complete(messages: LlmMessage[], tools: ToolDefinition[]): AsyncIterable<CompletionEvent> {
      if (!env.WAVE_GATEWAY_BASE || !env.WAVE_GATEWAY_TOKEN) {
        throw new AgentSessionError("LLM_NOT_CONFIGURED", "WAVE gateway base/token not provisioned", 503);
      }
      yield* streamGatewayLlm(fetchImpl, env, messages, tools);
    },
    async callTool(name: string, input: unknown): Promise<string> {
      if (!env.WAVE_GATEWAY_BASE || !env.WAVE_GATEWAY_TOKEN) {
        // Fail CLOSED — a tool can ONLY be executed through the provisioned gateway (agent-least-privilege +
        // metering authority). Unprovisioned → throw (the core turns it into an is_error tool_result, logged).
        throw new AgentSessionError("TOOL_NOT_CONFIGURED", "WAVE gateway base/token not provisioned", 503);
      }
      return callGatewayTool(fetchImpl, env, name, input);
    },
    async *synthesize(text: string): AsyncIterable<Uint8Array> {
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
        throw new AgentSessionError("TTS_NOT_CONFIGURED", "ElevenLabs key/voice not provisioned", 503);
      }
      yield* streamElevenLabs(fetchImpl, env, text);
    },
    async emitMeter(usage: VoiceTurnUsage): Promise<void> {
      // Step-7 real usage emit (mirrors metering.ts). INERT until the gateway base + service token are
      // provisioned (now resolved from EITHER convention by normalizeGatewayEnv); fail-OPEN so a metering
      // error never breaks the turn (emitVoiceTurnUsage swallows + logs).
      await emitVoiceTurnUsage(env, usage, fetchImpl as unknown as typeof fetch);
    },
  };
}

/**
 * Stream the LLM via the WAVE gateway (Claude Opus/Sonnet), ALWAYS through the gateway (design §L1 LOCKED — the
 * gateway is the metering + auth authority; never a direct Anthropic call). Posts the messages to the gateway's
 * Anthropic-compatible streaming endpoint with the internal Bearer; yields each assistant text delta. The exact
 * gateway path + stream envelope is pinned with the gateway side this step (TODO #81): the gateway already
 * proxies Claude (design §L2) — this consumes Anthropic-style SSE `content_block_delta` text deltas.
 */
async function* streamGatewayLlm(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  messages: LlmMessage[],
  tools: ToolDefinition[] = [],
): AsyncIterable<CompletionEvent> {
  const base = env.WAVE_GATEWAY_BASE!.replace(/\/+$/, "");
  const model = env.VOICE_AGENT_LLM_MODEL ?? DEFAULT_VOICE_LLM_MODEL;
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: 1024, stream: true, system, messages: turns };
  // agent-least-privilege: advertise ONLY the allowlisted tools (omit the field entirely when there are none).
  if (tools.length > 0) body.tools = tools;
  const res = await fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.WAVE_GATEWAY_TOKEN}`, // gateway service token — never logged
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new AgentSessionError("LLM_UPSTREAM", `gateway LLM returned ${res.status}`, 502);
  }
  yield* parseAnthropicStream(res.body);
}

/**
 * Parse the Anthropic streaming envelope into CompletionEvents. Handles BOTH text and tool_use content blocks:
 *   • content_block_start {index, content_block:{type:"tool_use", id, name}} — begin accumulating a tool_use.
 *   • content_block_delta {index, delta:{type:"text_delta", text}}           — emit a text event.
 *   • content_block_delta {index, delta:{type:"input_json_delta", partial_json}} — accumulate the tool input JSON.
 *   • content_block_stop  {index} — a finished tool_use block is emitted (its accumulated partial JSON is parsed).
 * Per-event fail-soft (a malformed event is skipped, never kills the stream) — the SSE layer already skips bad JSON.
 */
async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncIterable<CompletionEvent> {
  // Accumulate streamed tool_use blocks by content-block index (id+name from start, partial JSON from deltas).
  const pending = new Map<number, { id: string; name: string; json: string }>();
  for await (const raw of sseEvents(body)) {
    const evt = raw as {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string };
    };
    if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
      pending.set(evt.index ?? 0, { id: evt.content_block.id ?? "", name: evt.content_block.name ?? "", json: "" });
      continue;
    }
    if (evt.type === "content_block_delta") {
      const d = evt.delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
        yield { type: "text", text: d.text };
      } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
        const acc = pending.get(evt.index ?? 0);
        if (acc) acc.json += d.partial_json;
      }
      continue;
    }
    if (evt.type === "content_block_stop") {
      const acc = pending.get(evt.index ?? 0);
      if (acc) {
        pending.delete(evt.index ?? 0);
        let input: unknown = {};
        try {
          input = acc.json.length > 0 ? JSON.parse(acc.json) : {};
        } catch {
          input = {}; // a malformed tool input → empty object (the tool/loop handles it; never crash the stream)
        }
        yield { type: "tool_use", id: acc.id, name: acc.name, input };
      }
    }
  }
}

/**
 * Execute ONE tool via the WAVE gateway tool-exec endpoint (step 5). Posts {name,input} with the internal Bearer;
 * returns the stringified result. TODO(#81): the EXACT gateway tool-exec/MCP path is pinned with the gateway side —
 * until then this targets a sensible `/v1/internal/tools/exec` (mirrors the `/v1/internal/usage` server-to-server
 * convention already used in metering.ts). It is NOT a fake: it makes a real call when the gateway is provisioned
 * and the core fails CLOSED (an is_error tool_result, logged) when it errors. The agent NEVER fabricates a result.
 */
async function callGatewayTool(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  name: string,
  input: unknown,
): Promise<string> {
  const base = env.WAVE_GATEWAY_BASE!.replace(/\/+$/, "");
  const path = env.VOICE_AGENT_TOOL_EXEC_PATH ?? "/v1/internal/tools/exec";
  const res = await fetchImpl(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.WAVE_GATEWAY_TOKEN}`, // gateway service token — never logged
    },
    body: JSON.stringify({ name, input }),
  });
  if (!res.ok) throw new AgentSessionError("TOOL_UPSTREAM", `gateway tool-exec returned ${res.status}`, 502);
  // Accept either a JSON {result} envelope or a raw string body — stringify so the model always gets text.
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { result?: unknown };
    return typeof j.result === "string" ? j.result : JSON.stringify(j.result ?? j);
  } catch {
    return text; // non-JSON body → pass through verbatim
  }
}

/**
 * Stream ElevenLabs TTS → pcm_48000 chunks (16-bit LE @ 48 kHz, zero transcode for the ingest path). Key is
 * server-side ONLY (xi-api-key header), never logged, never returned. The HTTP streaming endpoint returns the
 * raw PCM body in chunks; we yield each chunk straight to the caller for just-in-time publish (tight barge-in).
 */
async function* streamElevenLabs(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  text: string,
): AsyncIterable<Uint8Array> {
  const voice = encodeURIComponent(env.ELEVENLABS_VOICE_ID!);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": env.ELEVENLABS_API_KEY!, // server-side secret — never logged
      accept: "audio/pcm",
    },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
  });
  if (!res.ok || !res.body) {
    throw new AgentSessionError("TTS_UPSTREAM", `ElevenLabs returned ${res.status}`, 502);
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) yield value;
  }
}

/**
 * STT via the WAVE transcribe spoke (gateway-fronted) — the PINNED contract (see /tmp/claude/handoff/
 * voice-stt-contract.md). No TRUE streaming STT exists in WAVE today (verified: the transcribe + captions
 * spokes are both BATCH — Whisper/Deepgram/Scribe, buffer-in → JSON-out), so the correct low-latency variant
 * is a SHORT-BUFFER BATCH per utterance: the agent's egress PCM (16-bit LE / 48 kHz / stereo) is wrapped in a
 * WAV container and POSTed to `{gateway}/v1/transcribe?engine=auto` with the internal service Bearer (the same
 * server-to-server convention metering.ts uses). The spoke returns `{ text, durationSec, words?, ... }`; we map
 * `text` → transcript and mark `isFinal:true` (one batch call == one final user turn; v1 endpointing is
 * final-driven). A truly STREAMING (per-partial) STT replaces this behind the SAME `transcribe` seam with no
 * change to TurnTakingCore (TODO #81 — gateway + transcribe-spoke streaming endpoint). NOT a fake: a real call
 * when provisioned; fails CLOSED (caller logs + abandons the turn) on a provider error.
 */
async function transcribeViaProvider(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  base: string,
  token: string,
  pcm: Uint8Array,
): Promise<SttResult> {
  const origin = base.replace(/\/+$/, "");
  const rawPath = env.VOICE_AGENT_STT_PATH ?? "/v1/transcribe";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const engine = env.VOICE_AGENT_STT_ENGINE ?? "auto";
  const wav = pcmToWav(pcm); // 48k/16-bit/stereo PCM → WAV container (the spoke engines need a container)
  const res = await fetchImpl(`${origin}${path}?engine=${encodeURIComponent(engine)}`, {
    method: "POST",
    headers: {
      "content-type": WAV_MIME,
      authorization: `Bearer ${token}`, // gateway internal service token — never logged
    },
    body: wav,
  });
  if (!res.ok) throw new AgentSessionError("STT_UPSTREAM", `STT returned ${res.status}`, 502);
  // The transcribe spoke returns { text, durationSec, words?, ... }; batch ⇒ this result IS the final.
  const json = (await res.json().catch(() => ({}))) as { text?: unknown; transcript?: unknown };
  const text =
    typeof json.text === "string" ? json.text : typeof json.transcript === "string" ? json.transcript : "";
  return { isFinal: true, transcript: text };
}

/**
 * Minimal SSE parser over a ReadableStream<Uint8Array>: yields the JSON.parse of each `data:` line (skips
 * `[DONE]` + comments). Sufficient for the Anthropic-style stream the gateway proxies. Fail-soft per event: a
 * non-JSON data line is skipped, not thrown (one bad event must not kill the stream).
 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0 || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* skip a malformed event — never kill the stream */
      }
    }
  }
}

/** Re-export for callers that need it next to the turn module. */
export type { IngestSocket };
/** Step-5 re-exports so the DO + callers reach the tool types/allowlist from the turn module. */
export {
  ToolAllowlist,
  toolAllowlistFromEnv,
  type ToolDefinition,
  type ToolUse,
  type ToolResult,
  type CompletionEvent,
} from "./agent-tools.js";
