// agent-turn-tools-exec — the tool-execution arm of the turn loop (agent-least-privilege),
// extracted from agent-turn.ts (token-budget decompose, 2026-08-30; DECOMPOSE by responsibility,
// never trim). The seam: EXECUTION policy is its own responsibility — the allowlist refusal, the
// fail-safe error shape, the redacted audit — separate from the session state machine that calls
// it. TurnTakingCore.executeTools delegates; the loop (agent-turn-run.ts) reaches it through the
// context. Moved verbatim, comments included.
import type { ToolUse, ToolResult, ToolAllowlist } from "./agent-tools.js";
import { redactToolInput } from "./agent-tools.js";
import type { AgentTurnDeps } from "./agent-turn-types.js";
import type { AgentMediaDeps } from "./agent-session.js";

/** What tool execution needs from the session. */
export interface ToolExecContext {
  deps: AgentTurnDeps & AgentMediaDeps;
  tools: ToolAllowlist;
  aborted(): boolean;
  idFields(): Record<string, unknown>;
}

export async function executeTurnTools(ctx: ToolExecContext, toolUses: ToolUse[]): Promise<ToolResult[]> {
/**
 * Execute the model-requested tool_use blocks (agent-least-privilege). For EACH: refuse (an is_error tool_result,
 * logged, NEVER executed) any name not on the allowlist; otherwise call `callTool` and return its result. A
 * thrown executor is fail-safe — it becomes an is_error tool_result (the model can react / the loop ends), it is
 * NOT thrown up the media path. Audit: each tool is structured-logged by NAME + a REDACTED input size summary —
 * the raw input (possible PII/secrets) is never logged verbatim. Honors barge-in between tools.
 */

  const results: ToolResult[] = [];
  for (const t of toolUses) {
    if (ctx.aborted()) break;
    const audit = redactToolInput(t.input);
    if (!ctx.tools.isAllowed(t.name)) {
      // REFUSE — a model-requested tool not on the explicit allowlist is never executed (least-privilege).
      ctx.deps.log("agent-tool-refused", { ...ctx.idFields(), tool: t.name, ...audit });
      results.push({ tool_use_id: t.id, content: `tool not permitted: ${t.name}`, is_error: true });
      continue;
    }
    try {
      const out = await ctx.deps.callTool(t.name, t.input);
      ctx.deps.log("agent-tool-call", { ...ctx.idFields(), tool: t.name, ok: true, ...audit });
      results.push({ tool_use_id: t.id, content: out, is_error: false });
    } catch (e) {
      // Fail-safe: an executor throw is captured as an error tool_result (logged), never thrown up the media path.
      ctx.deps.log("agent-tool-error", {
        ...ctx.idFields(),
        tool: t.name,
        ...audit,
        message: (e as Error)?.message ?? "unknown",
      });
      results.push({ tool_use_id: t.id, content: `tool error: ${t.name}`, is_error: true });
    }
  }
  return results;
}

