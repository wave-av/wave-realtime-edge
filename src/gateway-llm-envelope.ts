/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 — the PINNED wire contract for the voice agent's LLM call: the gateway's governed Claude proxy
 * `POST /v1/internal/messages`.
 *
 * Split out of agent-turn-providers.ts along a real seam (file-size-two-tier-gate): providers.ts owns the STT /
 * TTS / tool-exec adapters; THIS file owns ONE responsibility — the request envelope we send to the gateway LLM
 * proxy and the response envelope we parse back. Both halves are pinned against the gateway source (cited by
 * file:line below) and locked by test/gateway-llm-contract.test.ts, so a gateway-side change breaks a test here
 * instead of silently breaking a live voice turn (the #81 TODO this file resolves).
 *
 * GATEWAY SIDE OF RECORD: the WAVE gateway service @90fcf01, `src/agent-spokes.ts` — `tryAgentSpokeRoutes` (L94-L112) +
 * `handleInternalMessages` (L267-L434). READ-ONLY dependency: nothing here may assume gateway behaviour that
 * isn't in that handler.
 *
 * Dependency direction (no runtime cycle): value-imports only the leaf AgentSessionError; everything else —
 * including FetchLike from agent-turn-providers.ts — is a TYPE import (erased at compile time).
 */
import { AgentSessionError } from "./agent-session.js";
import type { AgentTurnEnv, LlmMessage } from "./agent-turn.js";
import type { ToolDefinition, CompletionEvent } from "./agent-tools.js";
import type { FetchLike } from "./agent-turn-providers.js";

/**
 * Which inference backend the voice agent's LLM call routes to through the gateway's governed proxy
 * (`x-wave-inference-backend`, agent-spokes.ts:286). "anthropic" (default) is the Anthropic Messages path —
 * byte-identical to today. The GPU backends (ollama fleet / RunPod / OpenRouter / SSD-streamed) are our own
 * capacity or an allowlisted third party, reached with an OpenAI-compatible body/stream instead.
 */
export type LlmBackend = "anthropic" | "ollama" | "runpod" | "openrouter" | "ssd-stream";

/** Resolve the voice agent's LLM backend from env. Empty/unknown → "anthropic" (the default plane). */
export function resolveLlmBackend(env: { VOICE_AGENT_LLM_BACKEND?: string }): LlmBackend {
  const b = (env.VOICE_AGENT_LLM_BACKEND ?? "").trim().toLowerCase();
  if (b === "ollama" || b === "runpod" || b === "openrouter" || b === "ssd-stream") return b;
  return "anthropic";
}

/** Default Claude model routed through the gateway. Sonnet = the sensible voice default (latency/cost); a larger
 *  model (e.g. Opus) is selectable via VOICE_AGENT_LLM_MODEL per the design's Opus/Sonnet choice.
 *  #118 flip (2026-07-03): migrated sonnet-4-6 → sonnet-5, the supported sonnet tier. Measured A/B on the
 *  voice-LLM surface (wave-eval e1-voice-llm-ab, staging run 0e51451c): sonnet-5 judge_quality 0.976 vs
 *  sonnet-4-6 0.968 — no regression, and 4-6 is deprecated. Same input/output pricing ($3/$15 per M).
 *  Reversible: set env VOICE_AGENT_LLM_MODEL to pin any model without a redeploy. */
export const DEFAULT_VOICE_LLM_MODEL = "claude-sonnet-5";
/**
 * Max request body the gateway's LLM proxy accepts. PINNED to the gateway's src/agent-spokes.ts:290
 * (`if (raw.length > 256 * 1024) return json({ ok:false, reason:"body_too_large" }, 413)`). Enforced edge-side
 * so an over-cap turn fails with an ACTIONABLE local error instead of an opaque gateway 413.
 */
export const GATEWAY_LLM_MAX_BODY_BYTES = 256 * 1024;
/** Anthropic `max_tokens` for one voice turn (required by the Messages API; the gateway forwards the body verbatim). */
export const GATEWAY_LLM_MAX_TOKENS = 1024;

/** The exact wire envelope posted to the gateway LLM proxy — pure, so the contract is unit-testable. */
export interface GatewayLlmRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * Build the `/v1/internal/messages` request — PINNED against the gateway @90fcf01, src/agent-spokes.ts
 * `handleInternalMessages`. Every requirement of that handler, in its own check order:
 *   • POST only ....................... L100 `if (req.method !== "POST") return null` (else the route never matches)
 *   • Authorization: Bearer <token> ... L273 serviceAuthed (timing-safe vs WAVE_SERVICE_TOKEN) → 401 service_auth_required
 *   • x-wave-org NON-EMPTY ............ L275 → 400 org_required   ← REQUIRED, not "send it if we have one"
 *   • x-wave-agent (optional) ......... L278 resolveAgentId (agent-budget.ts:98, truncated to 128) → usage blob[2] (#25)
 *   • body ≤ 256 KiB (decoded text) ... L290 → 413 body_too_large
 *   • body.model non-empty string ..... L298 → 400 model_required (a retired id is normalized at L302, not rejected)
 *   • body otherwise VERBATIM ......... L356-L368: forwarded to `${ANTHROPIC_BASE}/v1/messages` with the gateway's
 *     own x-api-key + `anthropic-version: 2023-06-01`, and `accept` taken from OUR request (L365) — which is why
 *     `accept: text/event-stream` is what makes the turn stream.
 * NOT sent: `x-wave-inference-backend` (L283 — an unknown value is a 400; absent = the default Anthropic plane).
 *
 * Fails CLOSED with a typed AgentSessionError (never a silent 400 round-trip) when org is missing or the body is
 * over cap. Pinned by test/gateway-llm-contract.test.ts.
 */
export function buildGatewayLlmRequest(
  env: AgentTurnEnv,
  org: string,
  agentId: string,
  messages: LlmMessage[],
  tools: ToolDefinition[] = [],
): GatewayLlmRequest {
  const base = env.WAVE_GATEWAY_BASE!.replace(/\/+$/, "");
  // The gateway exposes the LLM proxy as an INTERNAL route (service-token gated): /v1/internal/messages.
  // Overridable via VOICE_AGENT_LLM_PATH.
  const rawPath = env.VOICE_AGENT_LLM_PATH ?? "/v1/internal/messages";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  // gateway L275 hard-400s an empty org. Fail CLOSED here with the reason NAMED, rather than burning a round
  // trip to learn "gateway LLM returned 400" (an unbound session must never reach the LLM at all).
  if (!org) {
    throw new AgentSessionError(
      "LLM_ORG_REQUIRED",
      "x-wave-org is required by the gateway LLM proxy (agent-spokes.ts:275 org_required) — bind the session to an org",
      400,
    );
  }
  const model = env.VOICE_AGENT_LLM_MODEL ?? DEFAULT_VOICE_LLM_MODEL;
  const backend = resolveLlmBackend(env);
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages.filter((m) => m.role !== "system");
  let body: Record<string, unknown>;
  if (backend === "anthropic") {
    // Anthropic Messages shape: system hoisted OUT of messages; tools in Anthropic `tools` shape.
    body = {
      model,
      max_tokens: GATEWAY_LLM_MAX_TOKENS,
      stream: true,
      system,
      messages: turns,
    };
    // agent-least-privilege: advertise ONLY the allowlisted tools (omit the field entirely when there are none).
    if (tools.length > 0) body.tools = tools;
  } else {
    // OpenAI-compatible shape (ollama fleet / RunPod / OpenRouter / SSD-stream): the system prompt is a MESSAGE
    // role, not a top-level field. Tools are DROPPED on this plane — the fleet model runs text-only (the Anthropic
    // tool_use wire is not present here; a follow-up converts the allowlist to OpenAI function-calling).
    const openAiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    body = {
      model,
      max_tokens: GATEWAY_LLM_MAX_TOKENS,
      stream: true,
      messages: openAiMessages,
    };
  }
  const serialized = JSON.stringify(body);
  // The gateway measures the DECODED body (`const raw = await req.text()`), so measure the same string. A
  // multi-byte transcript makes this conservative in our favour — it never under-counts against the gate.
  if (serialized.length > GATEWAY_LLM_MAX_BODY_BYTES) {
    throw new AgentSessionError(
      "LLM_BODY_TOO_LARGE",
      `LLM request body ${serialized.length}B exceeds the gateway cap ${GATEWAY_LLM_MAX_BODY_BYTES}B (agent-spokes.ts:290 body_too_large)`,
      413,
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.WAVE_GATEWAY_TOKEN}`, // gateway service token — never logged, never in the URL
    accept: "text/event-stream", // forwarded verbatim to Anthropic (agent-spokes.ts:365) — this is what streams
    "x-wave-org": org, // REQUIRED tenant attribution + metering (agent-spokes.ts:275)
  };
  // A non-Anthropic backend is NAMED explicitly (agent-spokes.ts:286) so the gateway routes it to the ollama
  // fleet / RunPod / OpenRouter instead of the default Anthropic plane. Omitted for the default (never guessed).
  if (backend !== "anthropic") headers["x-wave-inference-backend"] = backend;
  // #25 per-agent attribution: the gateway reads x-wave-agent (agent-budget.ts:98) into usage blob[2]. Omitted
  // when unknown — absent is legal ("" attribution), only a MISSING org is a 400.
  if (agentId) headers["x-wave-agent"] = agentId.slice(0, 128); // gateway truncates at 128 (agent-budget.ts:99)
  return { url: `${base}${path}`, method: "POST", headers, body: serialized };
}

/**
 * Stream the LLM via the WAVE gateway (Claude Opus/Sonnet), ALWAYS through the gateway (design §L1 LOCKED — the
 * gateway is the metering + auth authority; never a direct Anthropic call). Yields each assistant text delta and
 * each completed tool_use block.
 *
 * #81 RESOLVED: the request envelope is pinned by `buildGatewayLlmRequest` and the response envelope by
 * `parseAnthropicStream` (the gateway is a VERBATIM Anthropic-SSE passthrough — agent-spokes.ts L356-L434 returns
 * the upstream body via `tee()` with the upstream status + content-type). Both are locked by
 * test/gateway-llm-contract.test.ts.
 */
export async function* streamGatewayLlm(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  org: string,
  messages: LlmMessage[],
  tools: ToolDefinition[] = [],
  agentId = "",
): AsyncIterable<CompletionEvent> {
  const req = buildGatewayLlmRequest(env, org, agentId, messages, tools);
  const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  if (!res.ok || !res.body) {
    // The gateway's failures are small JSON `{ok:false,reason}` bodies (agent-spokes.ts L273/275/284/287/290/298,
    // plus llmUpstreamBody on a 502). Surface the REASON — a bare "gateway LLM returned 400" is unactionable when
    // org_required / model_required / unknown_backend are three different bugs. Reading also RELEASES the body
    // (an un-drained Response deadlocks the DO's fetch pool).
    const reason = await gatewayFailureReason(res);
    throw new AgentSessionError(
      "LLM_UPSTREAM",
      `gateway LLM returned ${res.status}${reason ? ` (${reason})` : ""}`,
      502,
    );
  }
  yield* resolveLlmBackend(env) === "anthropic" ? parseAnthropicStream(res.body) : parseOpenAiStream(res.body);
}

/** Extract the gateway's `{ok:false,reason}` marker from a failed response — always drains/releases the body. */
async function gatewayFailureReason(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 512); // gateway error bodies are tiny JSON; bound it regardless
    const reason = (JSON.parse(text) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason.slice(0, 64) : "";
  } catch {
    return ""; // non-JSON / empty body → status alone (the body is released either way)
  }
}

/**
 * Parse the Anthropic streaming envelope into CompletionEvents. The gateway does NOT reshape the stream — it
 * pipes Anthropic's SSE through verbatim (agent-spokes.ts:356 forwards to `${ANTHROPIC_BASE}/v1/messages`;
 * L430-L434 tees that body straight to us) — so this parses the Anthropic Messages streaming format:
 *   • content_block_start {index, content_block:{type:"tool_use", id, name}} — begin accumulating a tool_use.
 *   • content_block_delta {index, delta:{type:"text_delta", text}}           — emit a text event.
 *   • content_block_delta {index, delta:{type:"input_json_delta", partial_json}} — accumulate the tool input JSON.
 *   • content_block_stop  {index} — a finished tool_use block is emitted (its accumulated partial JSON is parsed).
 *   • error {error:{type,message}} — a MID-STREAM Anthropic failure (overloaded_error, api_error). The gateway
 *     already committed a 200 + headers before this arrives, so it CANNOT turn it into a 502 — if we ignored it
 *     the turn would end silently with no audio. Fail CLOSED and loud instead.
 * Per-event fail-soft otherwise (a malformed event is skipped, never kills the stream).
 */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncIterable<CompletionEvent> {
  // Accumulate streamed tool_use blocks by content-block index (id+name from start, partial JSON from deltas).
  const pending = new Map<number, { id: string; name: string; json: string }>();
  for await (const raw of sseEvents(body)) {
    const evt = raw as {
      type?: string;
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string };
      error?: { type?: string; message?: string };
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
      continue;
    }
    if (evt.type === "error") {
      // Throwing here runs sseEvents' finally → reader.cancel(), releasing the body (no DO fetch-pool deadlock).
      throw new AgentSessionError(
        "LLM_UPSTREAM",
        `gateway LLM stream error: ${evt.error?.type ?? "unknown"}`,
        502,
      );
    }
  }
}

/**
 * Parse the OpenAI-compatible streaming envelope (ollama fleet / RunPod / OpenRouter) into CompletionEvents.
 * The GPU backends are OpenAI-shape: `data: {"choices":[{"delta":{"content":"…"}}]}` deltas, ending in
 * `data: [DONE]`. Tool-calling is NOT on this plane (the edge drops tools for the GPU path), so only text
 * deltas are read — a `delta.role`/`delta.tool_calls` line is skipped, never mis-parsed as text.
 * Per-event fail-soft (a malformed event is skipped, never kills the stream).
 */
export async function* parseOpenAiStream(body: ReadableStream<Uint8Array>): AsyncIterable<CompletionEvent> {
  for await (const raw of sseEvents(body)) {
    const choices = (raw as { choices?: { delta?: { content?: unknown } }[] }).choices;
    if (!Array.isArray(choices)) continue;
    for (const c of choices) {
      const text = c?.delta?.content;
      if (typeof text === "string" && text.length > 0) yield { type: "text", text };
    }
  }
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
  // try/finally so a consumer that breaks early (barge-in abort cancels the for-await over this generator)
  // releases the underlying body via reader.cancel() — an abandoned LLM Response otherwise leaks and
  // deadlocks the DO's fetch pool ("a stalled HTTP response was canceled to prevent deadlock").
  try {
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
  } finally {
    reader.cancel().catch(() => {});
  }
}
