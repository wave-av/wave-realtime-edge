// Task #81 — CONTRACT TEST for the voice agent's LLM call against the WAVE gateway's governed Claude proxy,
// POST /v1/internal/messages. This is the pin the TODO in agent-turn-providers.ts asked for: every assertion
// below cites the gateway-side file:line it is derived from, so a gateway change to the envelope breaks a
// test HERE rather than silently breaking a live voice turn.
//
// GATEWAY SIDE OF RECORD (read-only): the WAVE gateway service @90fcf01
//   src/agent-spokes.ts  L94-L112  tryAgentSpokeRoutes  (POST-only; /v1/internal/messages(/) → handleInternalMessages)
//   src/agent-spokes.ts  L267-L434 handleInternalMessages
//   src/agent-budget.ts  L35, L98  AGENT_HEADER = "x-wave-agent"; resolveAgentId (slice 0,128)
// No live network: every fetch is a fake.
import { describe, it, expect, vi } from "vitest";
import {
  buildGatewayLlmRequest,
  streamGatewayLlm,
  GATEWAY_LLM_MAX_BODY_BYTES,
  GATEWAY_LLM_MAX_TOKENS,
  DEFAULT_VOICE_LLM_MODEL,
} from "../src/gateway-llm-envelope.js";
import type { AgentTurnEnv, LlmMessage } from "../src/agent-turn.js";
import type { CompletionEvent, ToolDefinition } from "../src/agent-tools.js";

const ENV: AgentTurnEnv = {
  WAVE_GATEWAY_BASE: "https://api.wave.online/",
  WAVE_GATEWAY_TOKEN: "secret-gw-token",
};
const MSGS: LlmMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];

async function collect(it: AsyncIterable<CompletionEvent>): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** An SSE Response shaped EXACTLY like what the gateway hands back. */
function gatewaySse(events: unknown[]): Response {
  const body = `${events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("")}`;
  // Headers mirror agent-spokes.ts L430-L434: the gateway returns the TEE'd upstream body with the upstream
  // status and the upstream content-type, plus cache-control: no-store (it adds no envelope of its own).
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

// ─────────────────────────── REQUEST ENVELOPE ───────────────────────────
describe("#81 gateway LLM request envelope — pinned to handleInternalMessages", () => {
  it("targets POST /v1/internal/messages on the gateway base (agent-spokes.ts:100,107)", () => {
    const req = buildGatewayLlmRequest(ENV, "org_acme", "", MSGS);
    expect(req.url).toBe("https://api.wave.online/v1/internal/messages"); // trailing slash on the base normalized
    expect(req.method).toBe("POST"); // tryAgentSpokeRoutes returns null for any other method → route never matches
  });

  it("sends the service Bearer in the header and NEVER in the URL (agent-spokes.ts:273 serviceAuthed → 401)", () => {
    const req = buildGatewayLlmRequest(ENV, "org_acme", "", MSGS);
    expect(req.headers.authorization).toBe("Bearer secret-gw-token");
    expect(req.url).not.toContain("secret-gw-token");
  });

  it("ALWAYS sends a non-empty x-wave-org — the gateway 400s org_required without it (agent-spokes.ts:275)", () => {
    const req = buildGatewayLlmRequest(ENV, "org_acme", "", MSGS);
    expect(req.headers["x-wave-org"]).toBe("org_acme");
  });

  it("fails CLOSED locally when org is empty instead of burning a 400 round-trip (agent-spokes.ts:275)", () => {
    expect(() => buildGatewayLlmRequest(ENV, "", "", MSGS)).toThrowError(/org_required/);
    try {
      buildGatewayLlmRequest(ENV, "", "", MSGS);
    } catch (e) {
      expect((e as { code: string; status: number }).code).toBe("LLM_ORG_REQUIRED");
      expect((e as { status: number }).status).toBe(400);
    }
  });

  it("sends x-wave-agent when known, truncated at 128 (agent-budget.ts:35,98-99 → usage blob[2])", () => {
    expect(buildGatewayLlmRequest(ENV, "org_acme", "agent_7", MSGS).headers["x-wave-agent"]).toBe("agent_7");
    const long = "a".repeat(200);
    expect(buildGatewayLlmRequest(ENV, "org_acme", long, MSGS).headers["x-wave-agent"]).toHaveLength(128);
    // Absent is LEGAL (resolveAgentId → ""); only a missing ORG is a 400.
    expect(buildGatewayLlmRequest(ENV, "org_acme", "", MSGS).headers["x-wave-agent"]).toBeUndefined();
  });

  it("sends accept: text/event-stream — the gateway forwards OUR accept to Anthropic (agent-spokes.ts:365)", () => {
    expect(buildGatewayLlmRequest(ENV, "org_acme", "", MSGS).headers.accept).toBe("text/event-stream");
  });

  it("sends a non-empty model + max_tokens + stream, system hoisted out of messages (agent-spokes.ts:296-298)", () => {
    const body = JSON.parse(buildGatewayLlmRequest(ENV, "org_acme", "", MSGS).body);
    expect(body.model).toBe(DEFAULT_VOICE_LLM_MODEL); // "" would be a 400 model_required
    expect(body.max_tokens).toBe(GATEWAY_LLM_MAX_TOKENS); // Anthropic Messages requires it; gateway forwards verbatim
    expect(body.stream).toBe(true);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]); // role:"system" is NOT a valid Anthropic turn
    expect(body.tools).toBeUndefined(); // agent-least-privilege: omitted entirely when the allowlist is empty
  });

  it("honors VOICE_AGENT_LLM_MODEL / VOICE_AGENT_LLM_PATH overrides", () => {
    const env = { ...ENV, VOICE_AGENT_LLM_MODEL: "claude-opus-4-5", VOICE_AGENT_LLM_PATH: "v1/internal/messages/" };
    const req = buildGatewayLlmRequest(env, "org_acme", "", MSGS);
    expect(JSON.parse(req.body).model).toBe("claude-opus-4-5"); // a retired id is normalized gateway-side (L302), not rejected
    expect(req.url).toBe("https://api.wave.online/v1/internal/messages/"); // trailing-slash form also routes (L107)
  });

  it("passes the tool allowlist through in Anthropic shape when non-empty", () => {
    const tools: ToolDefinition[] = [{ name: "lookup", description: "d", input_schema: { type: "object" } }];
    const body = JSON.parse(buildGatewayLlmRequest(ENV, "org_acme", "", MSGS, tools).body);
    expect(body.tools).toEqual(tools);
  });

  it("refuses a body over the gateway's 256 KiB cap before sending (agent-spokes.ts:290 body_too_large)", () => {
    expect(GATEWAY_LLM_MAX_BODY_BYTES).toBe(256 * 1024);
    const huge: LlmMessage[] = [{ role: "user", content: "x".repeat(GATEWAY_LLM_MAX_BODY_BYTES) }];
    expect(() => buildGatewayLlmRequest(ENV, "org_acme", "", huge)).toThrowError(/body_too_large/);
  });

  it("does NOT send x-wave-inference-backend — any unknown value is a 400 (agent-spokes.ts:283-284)", () => {
    expect(buildGatewayLlmRequest(ENV, "org_acme", "", MSGS).headers["x-wave-inference-backend"]).toBeUndefined();
  });
});

// ─────────────────────────── RESPONSE ENVELOPE ───────────────────────────
// The gateway does NOT reshape the LLM response: agent-spokes.ts:356-368 forwards the body to
// `${ANTHROPIC_BASE}/v1/messages` with anthropic-version: 2023-06-01, and L430-L434 tees the upstream body
// straight back with the upstream status/content-type. So the wire format we parse IS the Anthropic Messages
// streaming format, and these fixtures are that format verbatim.
describe("#81 gateway LLM response envelope — Anthropic SSE passthrough", () => {
  it("yields text deltas from content_block_delta/text_delta", async () => {
    const fetchImpl = vi.fn(async () =>
      gatewaySse([
        { type: "message_start", message: { id: "msg_1", role: "assistant" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]),
    );
    const out = await collect(streamGatewayLlm(fetchImpl, ENV, "org_acme", MSGS));
    expect(out).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ]);
  });

  it("reassembles a streamed tool_use block from input_json_delta partials", async () => {
    const fetchImpl = vi.fn(async () =>
      gatewaySse([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "lookup" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"wave"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]),
    );
    expect(await collect(streamGatewayLlm(fetchImpl, ENV, "org_acme", MSGS))).toEqual([
      { type: "tool_use", id: "tu_1", name: "lookup", input: { q: "wave" } },
    ]);
  });

  it("fails CLOSED on a MID-STREAM Anthropic error event (the gateway already sent 200 — it cannot 502 it)", async () => {
    const fetchImpl = vi.fn(async () =>
      gatewaySse([
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
    );
    await expect(collect(streamGatewayLlm(fetchImpl, ENV, "org_acme", MSGS))).rejects.toMatchObject({
      code: "LLM_UPSTREAM",
    });
  });

  it("surfaces the gateway's {ok:false,reason} on a non-2xx (agent-spokes.ts json() at L273/275/284/287/290/298)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, reason: "llm_unconfigured" }), {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    );
    await expect(collect(streamGatewayLlm(fetchImpl, ENV, "org_acme", MSGS))).rejects.toMatchObject({
      code: "LLM_UPSTREAM",
      message: "gateway LLM returned 503 (llm_unconfigured)",
    });
  });

  it("still fails cleanly on a non-JSON error body (status alone)", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(collect(streamGatewayLlm(fetchImpl, ENV, "org_acme", MSGS))).rejects.toMatchObject({
      code: "LLM_UPSTREAM",
      message: "gateway LLM returned 502",
    });
  });
});

// ─────────────────────────── NON-ANTHROPIC (GPU) BACKEND ───────────────────────────
// VOICE_AGENT_LLM_BACKEND=ollama routes the turn through the gateway's GPU plane (agent-spokes.ts:286 selects
// the backend; forwardToBackend forwards an OpenAI-compatible body and streams OpenAI SSE back). This is the
// route-around for the Anthropic account's billing-failure (the governed gateway's model-normalization.ts).
describe("#81 gateway LLM — non-Anthropic (GPU) backend", () => {
  it("routes ollama via x-wave-inference-backend + OpenAI-shape body (system as a message role)", () => {
    const env = { ...ENV, VOICE_AGENT_LLM_BACKEND: "ollama", VOICE_AGENT_LLM_MODEL: "qwen3.8:27b-chat" };
    const req = buildGatewayLlmRequest(env, "org_acme", "", MSGS);
    expect(req.headers["x-wave-inference-backend"]).toBe("ollama");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("qwen3.8:27b-chat");
    expect(body.system).toBeUndefined(); // no top-level system on the OpenAI plane
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(body.tools).toBeUndefined(); // tools dropped on the GPU plane (text-only)
  });

  it("an unknown backend falls back to anthropic (never guessed)", () => {
    const env = { ...ENV, VOICE_AGENT_LLM_BACKEND: "definitely-not-a-backend" };
    const req = buildGatewayLlmRequest(env, "org_acme", "", MSGS);
    expect(req.headers["x-wave-inference-backend"]).toBeUndefined();
    expect(JSON.parse(req.body).system).toBe("sys"); // Anthropic shape restored
  });

  it("parses OpenAI SSE deltas into text events (the GPU stream, not Anthropic content_block_delta)", async () => {
    const fetchImpl = vi.fn(async () =>
      gatewaySse([
        { choices: [{ delta: { content: "Hel" }, index: 0 }] },
        { choices: [{ delta: { content: "lo" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ]),
    );
    const env = { ...ENV, VOICE_AGENT_LLM_BACKEND: "ollama" };
    expect(await collect(streamGatewayLlm(fetchImpl, env, "org_acme", MSGS))).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ]);
  });
});
