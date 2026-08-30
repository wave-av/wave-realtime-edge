// agent-turn-run — the runTurn USE CASE (the turn's LLM-stream → chunk → speak → tools loop),
// extracted from agent-turn.ts (token-budget decompose, 2026-08-30; DECOMPOSE by responsibility,
// never trim). The seam: the LOOP is the use case; the class is the session state machine. The
// explicit TurnRunContext below is the honest contract between them — every field is a thing the
// loop needs from the session, named, instead of seventeen `this.*` captures. Moved verbatim
// (comments included); TurnTakingCore.runTurn delegates.
import type { LlmMessage, AgentTurnDeps, TurnTakingConfig } from "./agent-turn-types.js";
import type { AgentMediaDeps } from "./agent-session.js";
import type { ToolDefinition, ToolResult, ToolUse, CompletionEvent } from "./agent-tools.js";
import type { LatencyCollector, TurnHopMarks } from "./turn-latency.js";
import { streamSpeakSentences, type SpeechSession, type StreamSpeakAcc } from "./agent-turn-speech.js";
import { SentenceChunker } from "./sentence-chunker.js";
import type { TurnCogsLedger } from "./voice-cogs-ledger.js";
import type { VoiceCogsRates } from "./voice-cogs.js";
import type { Vad } from "./agent-vad.js";
import type { ToolAllowlist } from "./agent-tools.js";
import { assistantToolUseMessage, userToolResultMessage } from "./agent-tools.js";
import { meterAbandonedTurn } from "./agent-turn-meter.js";

/** The session surface the turn loop needs. Owned by TurnTakingCore; passed per turn. */
export interface TurnRunContext {
  deps: AgentTurnDeps & AgentMediaDeps;
  config: TurnTakingConfig;
  messages: LlmMessage[];
  tools: ToolAllowlist;
  vad: Vad;
  latency: LatencyCollector;
  cogs: TurnCogsLedger;
  cogsRates?: VoiceCogsRates;
  /** Mutable turn flags the loop sets and the frame path reads. */
  state: {
    turnInFlight: boolean;
    aborted: boolean;
    committed: boolean;
    framesThisTurn: number;
    turnSeq: number;
    echoMuteMs: number;
    echoMuteUntil: number;
  };
  maxToolIterations: number;
  currentMarks?: TurnHopMarks;
  /** Session-scoped helpers owned by the class. */
  idFields(): Record<string, unknown>;
  openSpeech(): SpeechSession;
  commitSpoken(working: LlmMessage[], spoken: string, reason: string): void;
  logMeter(userText: string, assistant: string, toolsUsed: number, turnId: string, startMs: number, speech: SpeechSession): Promise<void>;
  resetUtterance(): void;
  executeTools(toolUses: ToolUse[]): Promise<ToolResult[]>;
}

/** The turn loop. Sets ctx.state flags; mutates ctx.messages via commitSpoken. */
export async function runAgentTurn(ctx: TurnRunContext, userText: string): Promise<void> {

  ctx.state.turnInFlight = true;
  ctx.state.aborted = false;
  ctx.state.committed = false;
  ctx.state.framesThisTurn = 0;
  const turnId = `t${ctx.state.turnSeq++}`;
  // The user's final utterance was just consumed. MARK the VAD as speaking (NOT reset-to-silence): the audio that
  // produced this turn's transcript is often still arriving (network/jitter-buffer lag, the utterance tail), and a
  // reset-to-silence would re-onset on that same-utterance audio and FALSE-barge-in the agent before it utters a
  // word. Holding "speaking" makes the trailing audio steady-speech (no event); a REAL barge-in must be a fresh
  // speech-start, which the VAD only emits after a silence (speech-end) — the user genuinely stops, then speaks
  // over the agent. (#27: this self-barge-in was why agent-turn-interrupt fired on every live turn → 0 RTP out.)
  ctx.vad.markSpeaking();
  const startMs = ctx.deps.now();
  let stage = "llm";
  // E0-P2: the turn's speech session, hoisted so the `finally` COGS emit below can read its counters on EVERY
  // exit. The abandoned exits (barge-in, mid-stream error, empty reply, tool cap, unexpected tool_use) are
  // exactly the turns that WASTE, so a receipt skipped there would structurally zero the wastage term.
  let turnSpeech: SpeechSession | undefined;
  let metered = false;
  try {
    const userMsg: LlmMessage = { role: "user", content: userText };
    // The working history for THIS turn (committed state + this turn's user/assistant/tool messages). Nothing is
    // pushed to ctx.messages until the final atomic commit below.
    const working: LlmMessage[] = [...ctx.messages, userMsg];
    const toolDefs = ctx.tools.definitions();
    let toolsUsed = 0;

    // D1: speak sentences AS THEY ARRIVE (see speakStreaming) instead of after the stream completes — but ONLY
    // when no tool is advertised, because a tool_use block can arrive AFTER text in the same stream and
    // `assistantToolUseMessage` carries tool_use blocks only. Speaking a preamble we then cannot commit would
    // desync history from what the listener actually heard, which is worse than the latency. TODO(#81 D1
    // follow-up): teach assistantToolUseMessage to carry the leading text block, then drop this condition.
    const eager = toolDefs.length === 0;

    // ── the bounded agentic loop ──────────────────────────────────────────────────────────────────────────
    for (let iter = 0; ; iter++) {
      stage = "llm";
      // Stream this iteration: collect text (only the FINAL no-tool iteration's text is spoken) + tool_use blocks.
      let assistant = "";
      const toolUses: ToolUse[] = [];
      if (eager) {
        // ── D1 sentence-streaming path (the ONLY iteration — no tools are advertised, so there is no loop) ──
        const speech = (turnSpeech = ctx.openSpeech());
        const acc: StreamSpeakAcc = { assistant: "", spoken: "", toolUses: [], aborted: false };
        const chunker = new SentenceChunker();
        try {
          await streamSpeakSentences(ctx.deps.complete([...working], toolDefs), speech, chunker, acc, () => ctx.state.aborted, () => { if (ctx.currentMarks) ctx.currentMarks.llmFirstTokenMs = ctx.deps.now(); }, () => { if (ctx.currentMarks) ctx.currentMarks.ttsFirstAudioMs = ctx.deps.now(); });
        } catch (e) {
          // HONEST FAILURE (#344 semantics): the turn FAILED, but audio already on the wire cannot be unheard.
          // Commit exactly what was spoken so the next turn's history matches what the listener heard, then
          // rethrow so the outer catch marks the turn failed (agent-turn-error) — never a silent success.
          // `errorStage` tells WHICH lane died: a synthesize/send throw is a TTS failure, not an LLM one, and
          // must be logged as such or production debugging chases the wrong upstream.
          if (acc.errorStage === "tts") stage = "tts";
          ctx.commitSpoken(working, acc.spoken, acc.errorStage === "tts" ? "tts-error" : "llm-error");
          throw e;
        }
        if (acc.aborted || ctx.state.aborted) {
          ctx.commitSpoken(working, acc.spoken, "barge-in"); // same rule for barge-in: heard ⇒ remembered
          return;
        }
        if (acc.toolUses.length > 0) {
          // FAIL-CLOSED (D1 scope guard): eager mode is entered ONLY with no tools advertised, so a tool_use
          // here means the provider mis-behaved. streamSpeakSentences already stopped speaking at the first
          // tool_use; committing acc.assistant as a plain reply (or speaking the tail) would desync history
          // from tool semantics AND from what was heard. Acknowledge only the spoken prefix and abandon.
          ctx.deps.log("agent-turn-unexpected-tool-use", { ...ctx.idFields(), toolUses: acc.toolUses.length });
          ctx.commitSpoken(working, acc.spoken, "unexpected-tool-use");
          return;
        }
        const assistant = acc.assistant.trim();
        if (assistant.length === 0) {
          ctx.deps.log("agent-turn-empty-llm", ctx.idFields());
          return; // nothing to say + nothing to commit → clean abandon (no dangling user)
        }
        working.push({ role: "assistant", content: assistant });
        // Commit the WHOLE turn atomically at STREAM END (one splice) — exactly as the non-eager path does, and
        // still BEFORE the final speak() below.
        ctx.messages.push(...working.slice(ctx.messages.length));
        ctx.state.committed = true;
        stage = "tts";
        const tail = chunker.flush(); // the trailing partial sentence the boundary policy held back
        if (tail.length > 0 && (await speech.speak(tail, () => { if (ctx.currentMarks) ctx.currentMarks.ttsFirstAudioMs = ctx.deps.now(); })) < 0) return; // aborted mid-tail: history already valid
        metered = true;
        await ctx.logMeter(userText, assistant, toolsUsed, turnId, startMs, speech);
        return;
      }
      for await (const evt of ctx.deps.complete([...working], toolDefs)) {
        if (ctx.state.aborted) break; // step-4 barge-in: cancel the in-flight stream
        if (evt.type === "text") assistant += evt.text;
        else toolUses.push({ id: evt.id, name: evt.name, input: evt.input });
      }
      if (ctx.state.aborted) return;

      // No tool calls → this is the final assistant turn. Speak it.
      if (toolUses.length === 0) {
        assistant = assistant.trim();
        if (assistant.length === 0) {
          ctx.deps.log("agent-turn-empty-llm", ctx.idFields());
          return; // nothing to say + nothing to commit → clean abandon (no dangling user)
        }
        working.push({ role: "assistant", content: assistant });
        // Commit the WHOLE turn atomically (user + every assistant/tool message produced this turn).
        ctx.messages.push(...working.slice(ctx.messages.length));
        ctx.state.committed = true;
        stage = "tts";
        const speech = (turnSpeech = ctx.openSpeech());
        const pcmBytesOut = await speech.speak(assistant, () => { if (ctx.currentMarks) ctx.currentMarks.ttsFirstAudioMs = ctx.deps.now(); });
        if (pcmBytesOut < 0) return; // aborted mid-TTS (already committed history is valid + alternating)
        metered = true;
        await ctx.logMeter(userText, assistant, toolsUsed, turnId, startMs, speech);
        return;
      }

      // The model wants to use tools. Stop at the hard cap (anti-runaway) — DON'T execute another round.
      if (iter >= ctx.maxToolIterations) {
        ctx.deps.log("agent-turn-tool-cap", { ...ctx.idFields(), maxToolIterations: ctx.maxToolIterations });
        return; // abandon cleanly — no commit (no partial tool turn leaks into committed history)
      }

      // Append the assistant(tool_use) message verbatim (history must replay the model's tool_use blocks), then
      // execute each requested tool (allowlist-gated) and append the matching user(tool_result) message.
      working.push(assistantToolUseMessage(toolUses) as LlmMessage);
      stage = "tool";
      const results = await ctx.executeTools(toolUses);
      if (ctx.state.aborted) return; // barge-in DURING tool execution → abandon (nothing committed)
      toolsUsed += results.length;
      working.push(userToolResultMessage(results) as LlmMessage);
      // loop: re-call the LLM with the tool_result(s) in history
    }
  } catch (e) {
    ctx.deps.log("agent-turn-error", { stage, ...ctx.idFields(), message: (e as Error)?.message ?? "unknown" });
  } finally {
    ctx.state.turnInFlight = false;
    // ECHO MUTE: discard the audio accumulated during the turn (the agent's own TTS picked up by the mic) +
    // hold a short grace so the reverberation tail isn't transcribed as the next user turn. This is the code-
    // level backstop; real deployments add AEC (WebRTC AEC3) on the client for the full fix.
    ctx.resetUtterance();
    ctx.state.echoMuteUntil = ctx.deps.now() + ctx.state.echoMuteMs;
    // E0-P2: EVERY turn closes the ledger exactly once. A turn that died before the clean-completion meter
    // still SUBMITTED characters the vendor bills, so it still gets a COGS receipt (log-only, never a billable
    // emit). Without this, no emitted row could ever carry abortedSpeaks > 0 and the barge-in wastage term
    // would be structurally ~0 in production: the aborted turns are exactly the ones that waste.
    if (!metered) {
      const { org, roomId: room, agentId } = ctx.config;
      const who = { org, room, agentId, ledger: ctx.cogs, rates: ctx.cogsRates };
      meterAbandonedTurn(ctx.deps, ctx.idFields(), who, { turnId, startMs, speech: turnSpeech });
    }
    // E1 harness: record this turn's hop marks. Every 30 turns, log the p50/p95 distribution (the
    // Done-check names it) so the numbers land in the agent-turn logs without any extra plumbing.
    if (ctx.currentMarks) {
      ctx.latency.record(ctx.currentMarks);
      ctx.deps.log("agent-turn-hop", { ...ctx.idFields(), ...ctx.currentMarks });
      if (ctx.latency.count() % 30 === 0) {
        ctx.deps.log("agent-turn-latency", { ...ctx.idFields(), distribution: ctx.latency.distribution() });
      }
      ctx.currentMarks = undefined;
    }
  }}
