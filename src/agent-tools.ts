/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b), build-order step 5 — TOOL-CALLING via the WAVE gateway (the agent-least-privilege
 * surface). This module is the PURE, dependency-free half: the tool ALLOWLIST (agent-least-privilege — the agent
 * may only ever run an explicit, config/env-driven set of tools), the Anthropic tool-use/tool-result block shapes
 * the turn loop appends to history, and the audit-redaction helper (log a tool's NAME + a SIZE summary, never the
 * raw input verbatim — never-log-or-leak-sensitive-data). The LIVE `callTool` gateway wiring lives in
 * `agent-turn.ts` (buildTurnDeps) next to the LLM/TTS/STT wiring so the env shape stays one place.
 *
 * ── WHY AN ALLOWLIST (agent-least-privilege, design §L2.4) ────────────────────────────────────────────────────
 *  The model PROPOSES a tool call; it does NOT get to pick from the universe of tools. The agent runtime hands the
 *  gateway ONLY the tool definitions in this allowlist, and refuses (a logged error tool_result, never an execute)
 *  any model-requested name not on it. A model that hallucinates / is jailbroken into requesting `delete_account`
 *  simply gets "tool not permitted" back — it can never reach an unlisted tool's executor.
 */

/** One Anthropic-style tool definition the agent exposes to the model (name + description + JSON-Schema input). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON-Schema for the tool input (Anthropic `input_schema`). Opaque to the core — passed through to the model. */
  input_schema: Record<string, unknown>;
}

/** A model-requested tool call, surfaced by the LLM stream (Anthropic `tool_use` content block). */
export interface ToolUse {
  /** The tool_use block id the matching tool_result must reference (Anthropic strict pairing). */
  id: string;
  name: string;
  /** The accumulated tool input (parsed from the streamed `input_json_delta` partial JSON). */
  input: unknown;
}

/** The result of executing one tool call, appended to history as an Anthropic `tool_result` content block. */
export interface ToolResult {
  tool_use_id: string;
  /** Stringified result (or error message); `is_error` marks a refusal / execution failure for the model. */
  content: string;
  is_error: boolean;
}

/**
 * The discriminated union `complete` yields: streamed assistant TEXT (→ TTS) OR a completed TOOL_USE block. The
 * turn loop streams text straight to TTS and collects any tool_use blocks to execute before re-calling the LLM.
 */
export type CompletionEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** Name regex for a tool — same SAFE shape used across the agent layer (no surprise characters reach the gateway). */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * ToolAllowlist — the agent-least-privilege gate. Holds the EXPLICIT set of tool definitions this agent may run.
 * Pure + immutable. `definitions()` is what we hand the gateway/model; `isAllowed(name)` is the refuse-or-execute
 * decision the turn loop makes for every model-requested tool_use BEFORE any executor is reached.
 */
export class ToolAllowlist {
  private readonly byName: Map<string, ToolDefinition>;

  constructor(definitions: ToolDefinition[] = []) {
    this.byName = new Map();
    for (const d of definitions) {
      if (!TOOL_NAME.test(d?.name ?? "")) continue; // drop a malformed name rather than expose it
      this.byName.set(d.name, d);
    }
  }

  /** The tool definitions to advertise to the model (gateway `tools` field). Empty = no tools offered. */
  definitions(): ToolDefinition[] {
    return [...this.byName.values()];
  }

  /** True ONLY when `name` is an explicitly-allowed tool. The single execute-or-refuse decision (least-privilege). */
  isAllowed(name: string): boolean {
    return this.byName.has(name);
  }

  /** Count of allowed tools (0 = the agent runs text-only; tool-calling is effectively off). */
  get size(): number {
    return this.byName.size;
  }
}

/**
 * Parse the tool allowlist from env. Honest, fail-CLOSED: an unset/blank/garbage value yields an EMPTY allowlist
 * (the agent simply offers no tools — never accidentally exposes one). The JSON is an array of ToolDefinition.
 * INERT-safe: a parse error logs nothing here (pure) and returns empty — the caller logs the arming context.
 */
export function toolAllowlistFromEnv(env: { VOICE_AGENT_TOOLS?: string }): ToolAllowlist {
  const raw = (env.VOICE_AGENT_TOOLS ?? "").trim();
  if (raw.length === 0) return new ToolAllowlist([]);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new ToolAllowlist([]);
    const defs = parsed.filter(
      (d): d is ToolDefinition =>
        !!d && typeof d.name === "string" && typeof d.description === "string" && typeof d.input_schema === "object",
    );
    return new ToolAllowlist(defs);
  } catch {
    return new ToolAllowlist([]); // fail closed — a malformed config exposes ZERO tools, never all of them
  }
}

/**
 * Redact a tool input for AUDIT logging: never log the raw input verbatim (never-log-or-leak-sensitive-data — it
 * may carry PII/secrets). We log the tool NAME (logged by the caller) + a SIZE summary of the input here. Pure.
 */
export function redactToolInput(input: unknown): { inputBytes: number; inputKeys?: string[] } {
  let json = "";
  try {
    json = JSON.stringify(input ?? null);
  } catch {
    json = "";
  }
  const summary: { inputBytes: number; inputKeys?: string[] } = { inputBytes: json.length };
  // Top-level KEY NAMES are low-sensitivity + high-diagnostic — values are NOT logged. Skip if it's not an object.
  if (input && typeof input === "object" && !Array.isArray(input)) {
    summary.inputKeys = Object.keys(input as Record<string, unknown>).slice(0, 16);
  }
  return summary;
}

/** Build an Anthropic `assistant` message carrying the model's tool_use blocks (history must replay them verbatim). */
export function assistantToolUseMessage(toolUses: ToolUse[]): {
  role: "assistant";
  content: Array<{ type: "tool_use"; id: string; name: string; input: unknown }>;
} {
  return {
    role: "assistant",
    content: toolUses.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
  };
}

/** Build the matching `user` message carrying the tool_result blocks (one per tool_use, strict id pairing). */
export function userToolResultMessage(results: ToolResult[]): {
  role: "user";
  content: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error: boolean }>;
} {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error,
    })),
  };
}
