// agent-turn-types — the public contracts of the turn-taking core (the injectable-deps seam),
// extracted from agent-turn.ts (token-budget decompose, 2026-08-30; DECOMPOSE by responsibility,
// never trim). The types are the SEAM ITSELF — they move together because everything else imports
// them as one surface. agent-turn.ts re-exports this module so no importer changes.
import type { ToolDefinition, CompletionEvent } from "./agent-tools.js";
import type { VoiceTurnUsage } from "./voice-meter.js";
import { DEFAULT_SYSTEM_PROMPT, buildTurnSystemPrompt, normalizeGatewayEnv } from "./agent-turn-providers.js";

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
  flowTap?: boolean;
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
export { DEFAULT_SYSTEM_PROMPT, buildTurnSystemPrompt, normalizeGatewayEnv };

import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_TTS_LEAD_MS,
  ttsLeadMsFromEnv,
  MAX_UTTERANCE_BYTES,
} from "./turn-config.js";
export { DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_TTS_LEAD_MS, ttsLeadMsFromEnv, MAX_UTTERANCE_BYTES };

/**
 * Stop words that mute the agent (voice-control-deck E1.P1): the transcript matching one of these mutes
 * locally — no LLM turn, no TTS. Kept narrow (a real "stop" intent, not a backchannel like "uh-huh").
 */
const STOP_WORDS = new Set(["mute", "stop", "stop listening", "shut up", "turn off the mic", "be quiet"]);

/**
 * TurnTakingCore — the pure, testable turn state machine for one agent session. Accumulates participant PCM,
 * runs STT → (on final) LLM via the gateway → ElevenLabs TTS → publishes PCM out the ingest socket. Holds the
 * conversation history. Persists nothing itself (the DO wrapper owns DO storage). Every stage is fail-safe: an
 * error is logged via the injected `log` and the turn is abandoned — it is NEVER thrown up the media path.
 */
