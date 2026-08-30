// agent-turn — the PUBLIC BARREL of the turn-taking surface. The machinery lives in sibling
// modules (token-budget decompose, 2026-08-30; DECOMPOSE by responsibility, never trim):
//   agent-turn-core.ts       — TurnTakingCore (the session state machine) + the architecture header
//   agent-turn-run.ts        — runAgentTurn (the turn use case: LLM-stream -> chunk -> speak -> tools)
//   agent-turn-tools-exec.ts — the least-privilege tool-execution arm
//   agent-turn-utterance.ts  — the bounded utterance buffer (drop-oldest eviction law)
//   agent-turn-types.ts      — the public contracts (the injectable-deps seam)
//   agent-turn-env.ts        — AgentTurnEnv + buildTurnDeps (the LIVE env wiring)
// This barrel preserves the module's historical public surface EXACTLY — no importer changes.
export { TurnTakingCore } from "./agent-turn-core.js";
export type { SttResult, LlmMessage, AgentTurnDeps, TurnTakingConfig } from "./agent-turn-types.js";
export type { AgentTurnEnv } from "./agent-turn-env.js";
export { buildTurnDeps } from "./agent-turn-env.js";
export { DEFAULT_VOICE_LLM_MODEL, ELEVENLABS_OUTPUT_FORMAT, DEFAULT_SYSTEM_PROMPT, buildTurnSystemPrompt, normalizeGatewayEnv } from "./agent-turn-providers.js";
export type { ToolDefinition, ToolUse, ToolResult, CompletionEvent } from "./agent-tools.js";
export { ToolAllowlist, toolAllowlistFromEnv } from "./agent-tools.js";
export { DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_TTS_LEAD_MS, ttsLeadMsFromEnv, MAX_UTTERANCE_BYTES } from "./turn-config.js";
