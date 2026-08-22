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
 * (AgentSessionError, pcm-wav, gateway-llm-envelope). agent-turn.ts imports the adapters from here; nothing
 * here imports a runtime value from agent-turn.ts.
 *
 * The gateway LLM lane (#81 pinned request envelope + Anthropic-SSE response parser) lives in its own file,
 * ./gateway-llm-envelope.ts, and is re-exported here so `buildTurnDeps`'s import surface is unchanged.
 */
import { AgentSessionError } from "./agent-session.js";
import { pcmToWav, WAV_MIME } from "./pcm-wav.js";
import { flowTap } from "./flow-tap.js";
import type { AgentTurnEnv, SttResult } from "./agent-turn.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// #81 gateway LLM contract — one responsibility, one file (see ./gateway-llm-envelope.ts).
export {
  DEFAULT_VOICE_LLM_MODEL,
  GATEWAY_LLM_MAX_BODY_BYTES,
  GATEWAY_LLM_MAX_TOKENS,
  buildGatewayLlmRequest,
  streamGatewayLlm,
  parseAnthropicStream,
} from "./gateway-llm-envelope.js";
export type { GatewayLlmRequest } from "./gateway-llm-envelope.js";

/** ElevenLabs streaming output format — pcm_48000 = 16-bit LE PCM @ 48 kHz, exactly the ingest path's codec. */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_48000";

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
  // optimize_streaming_latency (0-4, ElevenLabs) trades synthesis quality for first-audio latency — a voice
  // agent wants low latency, so default 3. Env-tunable (VOICE_AGENT_TTS_LATENCY), clamped to 0-4.
  const latency = parseInt(env.VOICE_AGENT_TTS_LATENCY ?? "3", 10);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": env.ELEVENLABS_API_KEY!, // server-side secret — never logged
      accept: "audio/pcm",
    },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", optimize_streaming_latency: Number.isFinite(latency) && latency >= 0 && latency <= 4 ? latency : 3 }),
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {}); // release the body — an un-drained Response deadlocks the DO's fetch pool
    throw new AgentSessionError("TTS_UPSTREAM", `ElevenLabs returned ${res.status}`, 502);
  }
  const reader = res.body.getReader();
  flowTap(env, "tts", "start", { chars: text.length });
  // try/finally so a consumer that breaks early (barge-in abort cancels the for-await) releases the underlying
  // body via reader.cancel() — otherwise the abandoned TTS Response leaks and deadlocks the DO's fetch pool.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        flowTap(env, "tts", "chunk", { bytes: value.length });
        yield value;
      }
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
  flowTap(env, "stt", "result", { chars: text.length });
  return { isFinal: true, transcript: text };
}

