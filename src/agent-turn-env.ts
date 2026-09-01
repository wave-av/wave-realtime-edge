// agent-turn-env — AgentTurnEnv (the env-shape union the DO arms the core behind) and
// buildTurnDeps (the LIVE wiring from env to the injectable deps), extracted from agent-turn.ts
// (token-budget decompose, 2026-08-30). The seam: TYPE + WIRING vs the state machine that uses
// them. agent-turn.ts re-exports both so no importer changes.
import { AgentSessionError, type AgentSessionEnv, type AgentMediaDeps, type IngestSocket } from "./agent-session.js";
import { emitVoiceTurnUsage, type VoiceMeterEnv, type VoiceTurnUsage } from "./voice-meter.js";
import type { VadEnv } from "./agent-vad.js";
import type { VoiceCogsRatesEnv } from "./voice-cogs.js";
import type { AgentTurnDeps, LlmMessage, SttResult, TurnTakingConfig } from "./agent-turn-types.js";
import type { ToolDefinition, ToolResult, CompletionEvent } from "./agent-tools.js";
import {
  streamGatewayLlm,
  callGatewayTool,
  streamElevenLabs,
  transcribeViaProvider,
  buildTurnSystemPrompt,
  normalizeGatewayEnv,
  upmixMonoToStereo16LE,
  type FetchLike,
} from "./agent-turn-providers.js";
import { streamingTranscribe } from "./agent-stt-streaming.js";
import { streamingTranscribeElevenLabs } from "./agent-stt-elevenlabs-realtime.js";

export interface AgentTurnEnv extends AgentSessionEnv, VadEnv, VoiceMeterEnv, VoiceCogsRatesEnv {
  /** WAVE gateway origin for the LLM proxy (var; not a secret). e.g. https://api.wave.online */
  WAVE_GATEWAY_BASE?: string;
  /** Internal service-to-service bearer for the gateway LLM proxy (secret; deploy-time, never logged). */
  WAVE_GATEWAY_TOKEN?: string;
  /** Claude model id routed through the gateway (Opus/Sonnet per design). Defaults to a sensible Sonnet. */
  VOICE_AGENT_LLM_MODEL?: string;
  /** LLM backend routed through the gateway (`x-wave-inference-backend`, agent-spokes.ts:286). Defaults
   *  "anthropic"; "ollama"|"runpod"|"openrouter"|"ssd-stream" route to an OpenAI-compatible GPU plane. */
  VOICE_AGENT_LLM_BACKEND?: string;
  /** LLM proxy path on the gateway (var). Default /v1/internal/messages (the service-token-gated internal route). */
  VOICE_AGENT_LLM_PATH?: string;
  /** ElevenLabs API key (secret; server-side ONLY, never client, never logged). */
  ELEVENLABS_API_KEY?: string;
  /** ElevenLabs voice id for the agent persona (var). */
  ELEVENLABS_VOICE_ID?: string;
  /** ElevenLabs optimize_streaming_latency (0-4): higher = lower first-audio latency, lower quality. Default 3. */
  VOICE_AGENT_TTS_LATENCY?: string;
  /**
   * STT gateway base (var). The WAVE transcribe spoke is reached THROUGH the gateway (metering-governed).
   * Defaults to WAVE_GATEWAY_BASE when unset (one gateway origin serves both LLM + STT). e.g. https://api.wave.online
   */
  VOICE_AGENT_STT_BASE?: string;
  /** STT gateway internal service Bearer (secret; never logged). Defaults to WAVE_GATEWAY_TOKEN when unset. */
  VOICE_AGENT_STT_TOKEN?: string;
  /** STT engine routed by the transcribe spoke (var): auto|whisper|deepgram|elevenlabs. Default "auto". */
  VOICE_AGENT_STT_ENGINE?: string;
  /** STT path on the gateway (var). Default /v1/internal/transcribe (the service-token-gated internal STT route). */
  VOICE_AGENT_STT_PATH?: string;
  /**
   * Step-5 agent-least-privilege tool ALLOWLIST (var; JSON array of {name,description,input_schema}). The agent
   * advertises ONLY these to the model + refuses any unlisted tool. Unset/blank/garbage → NO tools (fail closed).
   */
  VOICE_AGENT_TOOLS?: string;
  /** Step-5 gateway tool-exec path override (var). Default /v1/internal/tools/exec (TODO #81: pin with gateway). */
  VOICE_AGENT_TOOL_EXEC_PATH?: string;
  /**
   * Streaming STT flag (var). When "true" or "1", uses WebSocket streaming STT
   * instead of the batch gateway-fronted path. Default OFF (byte-identical batch path).
   */
  VOICE_AGENT_STREAMING_STT?: string;
  /** Deepgram API key (secret; server-side ONLY). Required when VOICE_AGENT_STREAMING_STT is enabled. */
  DEEPGRAM_API_KEY?: string;
  /**
   * E1 (elevenlabs-surface-adoption epic, #4081) — streaming STT PROVIDER selector (var):
   * "deepgram" | "elevenlabs". Only consulted when VOICE_AGENT_STREAMING_STT is armed. Default
   * "deepgram" (byte-identical to the pre-E1 streaming path when unset). "elevenlabs" routes to
   * the Scribe v2 Realtime WebSocket adapter (agent-stt-elevenlabs-realtime.ts); on ANY ElevenLabs
   * error this FAILS CLOSED back to the Deepgram streaming adapter — the turn is never dropped.
   */
  VOICE_AGENT_STREAMING_STT_PROVIDER?: string;
}

/**
 * Build the LIVE turn-taking deps from env (the concrete network adapters live in agent-turn-providers.ts). Wires:
 *   • transcribe → the WAVE transcribe spoke via the gateway (batch-on-utterance; fails CLOSED when unprovisioned,
 *     never a fake transcript).
 *   • complete   → the WAVE gateway LLM proxy (Claude Opus/Sonnet), streamed, Bearer service token.
 *   • synthesize → ElevenLabs streaming TTS, pcm_48000, key server-side only.
 *   • emitMeter  → voice_agent_minutes usage emit (fail-OPEN).
 * Tests pass fakes instead of calling this. The DO calls this ONLY behind voiceAgentEnabled(env).
 */
export function buildTurnDeps(
  rawEnv: AgentTurnEnv,
  media: AgentMediaDeps,
  fetchImpl: FetchLike = fetch,
  org = "", agentId = "", // agentId → x-wave-agent (gateway per-agent usage attribution, #81 envelope)
): AgentTurnDeps & AgentMediaDeps {
  // One canonical gateway base/token for ALL paths (LLM, STT, tools, metering) — either convention provisions all.
  const env = normalizeGatewayEnv(rawEnv);
  // `org` (the bound tenant) is asserted as x-wave-org on each gateway call so the gateway's internal STT/LLM
  // routes attribute + meter usage to the right tenant. Empty only in non-bound test paths.
  return {
    ...media,
    flowTap: env.AGENT_FLOW_TAP === "true" || env.AGENT_FLOW_TAP === "1",
    async transcribe(pcm: Uint8Array): Promise<SttResult> {
      // Streaming STT path — behind env flag, default OFF. When armed, PROVIDER selects the
      // WebSocket backend (E1, elevenlabs-surface-adoption epic #4081): "elevenlabs" routes to
      // the Scribe v2 Realtime adapter; anything else (including unset) stays on Deepgram — the
      // pre-E1 default, byte-identical when VOICE_AGENT_STREAMING_STT_PROVIDER is unset.
      if (env.VOICE_AGENT_STREAMING_STT === "true" || env.VOICE_AGENT_STREAMING_STT === "1") {
        if (env.VOICE_AGENT_STREAMING_STT_PROVIDER === "elevenlabs") {
          try {
            return await streamingTranscribeElevenLabs(pcm, env, fetchImpl);
          } catch {
            // Fail CLOSED to Deepgram on ANY ElevenLabs error (upgrade failure, vendor error
            // event, timeout, missing key) — never drop the turn. A second failure here still
            // throws (both backends unavailable is a real STT outage, not silently swallowed).
            return streamingTranscribe(pcm, env);
          }
        }
        return streamingTranscribe(pcm, env);
      }
      // Batch path (byte-identical to current) — the proven gateway-fronted transcribe spoke.
      const base = env.VOICE_AGENT_STT_BASE ?? env.WAVE_GATEWAY_BASE;
      const token = env.VOICE_AGENT_STT_TOKEN ?? env.WAVE_GATEWAY_TOKEN;
      if (!base || !token) {
        // Fail CLOSED + loud — the WAVE transcribe spoke (gateway-fronted) is not provisioned. NEVER a fake.
        throw new AgentSessionError("STT_NOT_CONFIGURED", "STT gateway base/token not provisioned", 503);
      }
      return transcribeViaProvider(fetchImpl, env, org, base, token, pcm);
    },
    async *complete(messages: LlmMessage[], tools: ToolDefinition[]): AsyncIterable<CompletionEvent> {
      if (!env.WAVE_GATEWAY_BASE || !env.WAVE_GATEWAY_TOKEN) {
        throw new AgentSessionError("LLM_NOT_CONFIGURED", "WAVE gateway base/token not provisioned", 503);
      }
      yield* streamGatewayLlm(fetchImpl, env, org, messages, tools, agentId);
    },
    async callTool(name: string, input: unknown): Promise<string> {
      if (!env.WAVE_GATEWAY_BASE || !env.WAVE_GATEWAY_TOKEN) {
        // Fail CLOSED — a tool can ONLY be executed through the provisioned gateway (agent-least-privilege +
        // metering authority). Unprovisioned → throw (the core turns it into an is_error tool_result, logged).
        throw new AgentSessionError("TOOL_NOT_CONFIGURED", "WAVE gateway base/token not provisioned", 503);
      }
      return callGatewayTool(fetchImpl, env, org, name, input);
    },
    async *synthesize(text: string): AsyncIterable<Uint8Array> {
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
        throw new AgentSessionError("TTS_NOT_CONFIGURED", "ElevenLabs key/voice not provisioned", 503);
      }
      // ElevenLabs pcm_48000 is MONO; CF Realtime buffer-mode ingest wants 48 kHz/16-bit/STEREO interleaved.
      // Upmix (L=R) before publish or the agent's voice plays as endianness-shifted noise. (#30)
      yield* upmixMonoToStereo16LE(streamElevenLabs(fetchImpl, env, text), env);
    },
    async emitMeter(usage: VoiceTurnUsage): Promise<void> {
      // Step-7 real usage emit (mirrors metering.ts). INERT until the gateway base + service token are
      // provisioned (now resolved from EITHER convention by normalizeGatewayEnv); fail-OPEN so a metering
      // error never breaks the turn (emitVoiceTurnUsage swallows + logs).
      await emitVoiceTurnUsage(env, usage, fetchImpl as unknown as typeof fetch);
    },
  };
}

/** Re-export the live-adapter constants so callers (+ tests) reach them from the turn module's public API. */
export { DEFAULT_VOICE_LLM_MODEL, ELEVENLABS_OUTPUT_FORMAT } from "./agent-turn-providers.js";

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
