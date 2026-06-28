/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b) — LIVE provider adapters for the voice-agent turn pipeline.
 *
 * Split out of agent-turn.ts (file-size-two-tier-gate): the pure TurnTakingCore + the injectable-deps SEAM stay
 * in agent-turn.ts; the concrete network adapters that `buildTurnDeps` wires live HERE. Each adapter is
 * fail-CLOSED on a provider error (throws a typed `AgentSessionError` → the core logs + abandons the turn,
 * never a fabricated result) and keeps every secret server-side (referenced in a header — never logged, never
 * in a URL).
 *
 * Dependency direction (no runtime cycle): this module TYPE-imports its contracts from agent-turn.ts /
 * agent-tools.ts (type imports are erased at compile time) and value-imports only leaf utilities
 * (AgentSessionError, pcm-wav). agent-turn.ts imports the adapters from here; nothing here imports a runtime
 * value from agent-turn.ts.
 */
import { AgentSessionError } from "./agent-session.js";
import { pcmToWav, WAV_MIME } from "./pcm-wav.js";
import type { AgentTurnEnv, SttResult, LlmMessage } from "./agent-turn.js";
import type { ToolDefinition, CompletionEvent } from "./agent-tools.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Default Claude model routed through the gateway. Sonnet = the sensible voice default (latency/cost); Opus is
 *  selectable via VOICE_AGENT_LLM_MODEL per the design's Opus/Sonnet choice. */
export const DEFAULT_VOICE_LLM_MODEL = "claude-sonnet-4-6";
/** ElevenLabs streaming output format — pcm_48000 = 16-bit LE PCM @ 48 kHz, exactly the ingest path's codec. */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_48000";

/**
 * Stream the LLM via the WAVE gateway (Claude Opus/Sonnet), ALWAYS through the gateway (design §L1 LOCKED — the
 * gateway is the metering + auth authority; never a direct Anthropic call). Posts the messages to the gateway's
 * Anthropic-compatible streaming endpoint with the internal Bearer; yields each assistant text delta. The exact
 * gateway path + stream envelope is pinned with the gateway side this step (TODO #81): the gateway already
 * proxies Claude (design §L2) — this consumes Anthropic-style SSE `content_block_delta` text deltas.
 */
export async function* streamGatewayLlm(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  org: string,
  messages: LlmMessage[],
  tools: ToolDefinition[] = [],
): AsyncIterable<CompletionEvent> {
  const base = env.WAVE_GATEWAY_BASE!.replace(/\/+$/, "");
  // The gateway exposes the LLM proxy as an INTERNAL route (service-token gated): /v1/internal/messages.
  // Overridable via VOICE_AGENT_LLM_PATH. The org is asserted via x-wave-org so the gateway meters the tokens
  // to the right tenant (wave_ai_tokens_<tier>_<dir>).
  const rawPath = env.VOICE_AGENT_LLM_PATH ?? "/v1/internal/messages";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const model = env.VOICE_AGENT_LLM_MODEL ?? DEFAULT_VOICE_LLM_MODEL;
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = { model, max_tokens: 1024, stream: true, system, messages: turns };
  // agent-least-privilege: advertise ONLY the allowlisted tools (omit the field entirely when there are none).
  if (tools.length > 0) body.tools = tools;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.WAVE_GATEWAY_TOKEN}`, // gateway service token — never logged
    accept: "text/event-stream",
  };
  if (org) headers["x-wave-org"] = org; // tenant attribution for gateway metering
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {}); // release the body — an un-drained Response deadlocks the DO's fetch pool
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
export async function callGatewayTool(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  org: string,
  name: string,
  input: unknown,
): Promise<string> {
  const base = env.WAVE_GATEWAY_BASE!.replace(/\/+$/, "");
  const path = env.VOICE_AGENT_TOOL_EXEC_PATH ?? "/v1/internal/tools/exec";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.WAVE_GATEWAY_TOKEN}`, // gateway service token — never logged
  };
  if (org) headers["x-wave-org"] = org; // tenant attribution
  const res = await fetchImpl(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, input }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {}); // release the body — an un-drained Response deadlocks the DO's fetch pool
    throw new AgentSessionError("TOOL_UPSTREAM", `gateway tool-exec returned ${res.status}`, 502);
  }
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
 * Stream ElevenLabs TTS → pcm_48000 chunks (16-bit LE @ 48 kHz, **MONO** — ElevenLabs `pcm_48000` is single-
 * channel). Key is server-side ONLY (xi-api-key header), never logged, never returned. The HTTP streaming
 * endpoint returns the raw PCM body in chunks; we yield each chunk straight to the caller for just-in-time
 * publish (tight barge-in). NOTE: the CF Realtime buffer-mode ingest path wants 48 kHz/16-bit/**STEREO
 * interleaved** — wrap this with `upmixMonoToStereo16LE` before sending (see synthesize in agent-turn.ts).
 */
export async function* streamElevenLabs(
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
    await res.body?.cancel().catch(() => {}); // release the body — an un-drained Response deadlocks the DO's fetch pool
    throw new AgentSessionError("TTS_UPSTREAM", `ElevenLabs returned ${res.status}`, 502);
  }
  const reader = res.body.getReader();
  // try/finally so a consumer that breaks early (barge-in abort cancels the for-await) releases the underlying
  // body via reader.cancel() — otherwise the abandoned TTS Response leaks and deadlocks the DO's fetch pool.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Upmix a streaming MONO 16-bit-LE PCM stream into STEREO interleaved (L=R) — the format CF Realtime buffer-mode
 * ingest requires (48 kHz / 16-bit / stereo). Each mono sample (2 bytes) becomes 4 bytes: [lo, hi, lo, hi].
 *
 * STATEFUL across chunks: a streamed chunk can split a 16-bit sample on an odd byte boundary, so we CARRY the
 * dangling low byte into the next chunk rather than dropping or misaligning it (a single dropped byte would shift
 * every subsequent sample's endianness → white noise). At most one byte is ever carried. A final dangling byte at
 * stream end (no pair) is silently dropped — it is at most 1 byte of half a sample at end-of-utterance, inaudible.
 */
export async function* upmixMonoToStereo16LE(
  mono: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  let carry: number | null = null; // pending low byte of a sample split across a chunk boundary
  for await (const chunk of mono) {
    if (chunk.length === 0) continue;
    const total = (carry === null ? 0 : 1) + chunk.length;
    const samples = total >> 1; // complete 16-bit samples we can emit now
    if (samples === 0) {
      carry = chunk[0]!; // a lone byte with no carry → hold it for the next chunk
      continue;
    }
    const out = new Uint8Array(samples * 4);
    let i = 0;
    let o = 0;
    for (let s = 0; s < samples; s++) {
      let lo: number;
      let hi: number;
      if (carry !== null) {
        lo = carry;
        carry = null;
        hi = chunk[i++]!;
      } else {
        lo = chunk[i++]!;
        hi = chunk[i++]!;
      }
      out[o++] = lo; // L
      out[o++] = hi;
      out[o++] = lo; // R
      out[o++] = hi;
    }
    if (i < chunk.length) carry = chunk[i]!; // odd trailing byte → carry into the next chunk
    yield out;
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
export async function transcribeViaProvider(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  org: string,
  base: string,
  token: string,
  pcm: Uint8Array,
): Promise<SttResult> {
  const origin = base.replace(/\/+$/, "");
  // STT is reached via the gateway's INTERNAL route (/v1/internal/transcribe — service-token gated). The
  // org is asserted via x-wave-org so the gateway attributes the transcribe minutes to the right tenant.
  const rawPath = env.VOICE_AGENT_STT_PATH ?? "/v1/internal/transcribe";
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const engine = env.VOICE_AGENT_STT_ENGINE ?? "auto";
  const wav = pcmToWav(pcm); // 48k/16-bit/stereo PCM → WAV container (the spoke engines need a container)
  const headers: Record<string, string> = {
    "content-type": WAV_MIME,
    authorization: `Bearer ${token}`, // gateway internal service token — never logged
  };
  if (org) headers["x-wave-org"] = org; // tenant attribution for gateway metering
  const res = await fetchImpl(`${origin}${path}?engine=${encodeURIComponent(engine)}`, {
    method: "POST",
    headers,
    body: wav,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {}); // release the body — an un-drained Response deadlocks the DO's fetch pool
    throw new AgentSessionError("STT_UPSTREAM", `STT returned ${res.status}`, 502);
  }
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
