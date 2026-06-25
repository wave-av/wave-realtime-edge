/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b), build-order step 3 — TURN-TAKING v1.
 *
 * Replaces the step-2 echo loop as the ARMED behavior with a real conversational turn, while keeping the
 * skeleton's whole philosophy: an injectable-deps seam (every external call is fakeable → zero live network in
 * unit tests), fail-safe media ops (any STT/LLM/TTS error is LOGGED, never thrown up the media path, never
 * crashes the DO), typed `AgentSessionError`, secrets referenced-never-valued, and fully INERT without the flag.
 *
 * ── THE TURN PIPELINE (all via injected deps) ───────────────────────────────────────────────────────────────
 *   PCM in (decodePacket — the PROVEN egress decoder)
 *        │  accumulate participant PCM
 *        ▼
 *   STT  (injected `transcribe`): accumulated PCM → { partial | FINAL } transcript. v1 endpointing is
 *        final-transcript-driven (the simple, correct v1). A partial does NOT fire a turn. The VAD / barge-in
 *        interrupt controller is STEP 4 — NOT built here, but NOT architected out: `onUserSpeech()` is the
 *        documented seam a step-4 controller will call to abort an in-flight turn.
 *        ▼  (final transcript = end of user turn)
 *   LLM  (injected `complete`) = Claude Opus/Sonnet via the WAVE gateway, ALWAYS (design §L1 LOCKED — never a
 *        direct vendor call). The core holds the conversation history (system + alternating user/assistant) and
 *        STREAMS the assistant text out of `complete`.
 *        ▼  assistant text (streamed)
 *   TTS  (injected `synthesize`) = ElevenLabs streaming, output pcm_48000 (zero transcode — matches ingest).
 *        Each streamed PCM chunk → `chunkPcm` → `encodeIngestFrame` → the ingest socket — the EXACT send path
 *        `echoFrame` uses. The agent track is now the synthesized reply, not the looped-back human.
 *
 * ── METERING (honest seams, step 7) ─────────────────────────────────────────────────────────────────────────
 *  `voice_agent_minutes` + LLM tokens + ElevenLabs chars are emitted to the gateway in STEP 7. Here we only
 *  STRUCTURED-LOG the counts we actually have (assistant chars, pcm bytes out, turn wall-ms). No fake meter
 *  emit (config-no-silent-noop / proven-live-or-not-done).
 *
 * ── INERT WITHOUT THE FLAG ──────────────────────────────────────────────────────────────────────────────────
 *  Nothing here runs unless `voiceAgentEnabled(env)` (VOICE_AGENT_PROVIDER==="wave"); the DO arms this core
 *  only behind that gate. `buildTurnDeps()` wires the LIVE deps from env (creds referenced, never logged).
 */
import {
  AgentSessionError,
  type AgentMediaDeps,
  type IngestSocket,
  type AgentSessionEnv,
} from "./agent-session.js";
import { decodePacket } from "./encoders/container-adapter.js";
import { chunkPcm, encodeIngestFrame, type IngestFraming } from "./agent-ingest-adapter.js";
import { Vad, vadConfigFromEnv, type VadConfig, type VadEnv } from "./agent-vad.js";

// ── Public contracts (the injectable-deps seam) ──────────────────────────────────────────────────────────────

/** One STT result for the accumulated PCM. `isFinal` = end-of-user-turn (the v1 endpointing signal). */
export interface SttResult {
  isFinal: boolean;
  /** The (partial or final) transcript text. Empty string = silence/no speech. */
  transcript: string;
}

/** One LLM chat message — the gateway/Claude message shape (system + alternating user/assistant). */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
   * LLM via the WAVE gateway (Claude Opus/Sonnet, ALWAYS). Stream the assistant text given the full message
   * history (system + alternating user/assistant). An async generator so the assistant text is streamed to TTS
   * incrementally (and is cancellable in step 4). Fail-safe: a throw is caught (logged stage="llm").
   */
  complete(messages: LlmMessage[]): AsyncIterable<string>;
  /**
   * TTS = ElevenLabs streaming → pcm_48000 chunks (16-bit LE, 48 kHz — matches the ingest path, zero transcode).
   * An async generator so audio streams out as it's synthesized. Fail-safe: a throw is caught (logged stage="tts").
   */
  synthesize(text: string): AsyncIterable<Uint8Array>;
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
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, concise WAVE voice agent. Reply in short, natural spoken sentences.";

/** The configured persona, or the default. Pure → unit-testable. */
export function buildTurnSystemPrompt(config: Pick<TurnTakingConfig, "systemPrompt">): string {
  const p = (config.systemPrompt ?? "").trim();
  return p.length > 0 ? p : DEFAULT_SYSTEM_PROMPT;
}

/**
 * TurnTakingCore — the pure, testable turn state machine for one agent session. Accumulates participant PCM,
 * runs STT → (on final) LLM via the gateway → ElevenLabs TTS → publishes PCM out the ingest socket. Holds the
 * conversation history. Persists nothing itself (the DO wrapper owns DO storage). Every stage is fail-safe: an
 * error is logged via the injected `log` and the turn is abandoned — it is NEVER thrown up the media path.
 */
export class TurnTakingCore {
  private readonly deps: AgentTurnDeps & AgentMediaDeps;
  private readonly config: TurnTakingConfig;
  private readonly framing: IngestFraming;
  private readonly messages: LlmMessage[];
  /** PCM accumulated since the last FINAL transcript (the current user utterance). */
  private utterance: Uint8Array[] = [];
  private outSeq = 0;
  /** Guards against re-entrant turns (a turn is in flight while we await STT/LLM/TTS). */
  private turnInFlight = false;
  /** Set by the step-4 interrupt controller (onUserSpeech / VAD barge-in) to cancel an in-flight turn. */
  private aborted = false;
  /** Step-4 VAD: detects user speech ONSET on every frame → drives true barge-in while the agent talks. */
  private readonly vad: Vad;
  /** Frame counter (since the in-flight turn started) used to instrument barge-in detection→abort latency. */
  private framesThisTurn = 0;

  constructor(
    deps: AgentTurnDeps & AgentMediaDeps,
    config: TurnTakingConfig,
    opts?: { framing?: IngestFraming; vad?: Partial<VadConfig> },
  ) {
    this.deps = deps;
    this.config = config;
    this.framing = opts?.framing ?? "packet";
    this.messages = [{ role: "system", content: buildTurnSystemPrompt(config) }];
    this.vad = new Vad(opts?.vad);
  }

  /** A copy of the conversation history (system + alternating user/assistant). For tests + DO snapshotting. */
  history(): readonly LlmMessage[] {
    return this.messages.slice();
  }

  /**
   * Feed ONE raw egress WS binary frame (one Packet): decode → accumulate PCM → STT → (on FINAL) run the turn.
   * Fail-safe: ANY error at any stage is logged and swallowed (never breaks the live media the SFU pushes).
   * Final-transcript-driven endpointing (v1). A partial transcript only accumulates; no turn fires.
   */
  async onFrame(frame: Uint8Array): Promise<void> {
    let stage = "decode";
    try {
      const pkt = decodePacket(frame);
      if (pkt.payload.length === 0) return; // keep-alive / empty
      // VAD runs on EVERY decoded frame (design §L2.1) — it's the barge-in trigger AND the silence sensor.
      stage = "vad";
      const vadEvent = this.vad.feed(pkt.payload);
      this.utterance.push(pkt.payload);
      if (this.turnInFlight) {
        // Agent is speaking. A sustained speech ONSET = the user barged in → abort the in-flight turn NOW so the
        // agent goes silent immediately. The interrupting PCM is already accumulating (pushed above) → it becomes
        // the next utterance. This is the real barge-in wiring (onUserSpeech was only an external seam in step 3).
        this.framesThisTurn += 1;
        if (vadEvent === "speech-start") this.bargeIn();
        return; // while a turn is in flight we never start STT — accumulate + (maybe) interrupt
      }
      if (vadEvent === "speech-end") {
        // VAD endpointing SEAM (design §L2.2): a real silence-hangover ended the user's speech. v1 endpointing
        // stays final-transcript-driven below (STT decides the turn) so we never cut the user off on energy alone;
        // this transition is observed for the future semantic+silence endpointing refinement.
        // TODO(#81 step 4 follow-up): complement final-transcript endpointing with this silence signal once the
        //                             streaming-STT contract lands (pin debounce so a hard-silence ends the turn
        //                             faster without truncating slow speakers). Barge-in is the must-ship here.
        this.deps.log("agent-vad-endpoint", { ...this.idFields(), rms: Math.round(this.vad.lastFrameRms) });
      }
      stage = "stt";
      const pcm = concat(this.utterance);
      const stt = await this.deps.transcribe(pcm);
      if (!stt.isFinal) return; // partial — keep accumulating (v1 endpointing is final-driven)
      const userText = stt.transcript.trim();
      this.utterance = []; // consume the utterance now that it's final
      if (userText.length === 0) return; // final-but-empty (silence) → no turn
      await this.runTurn(userText);
    } catch (e) {
      this.deps.log("agent-turn-error", { stage, message: (e as Error)?.message ?? "unknown" });
    }
  }

  /**
   * Run ONE turn for a final user transcript: append to history → stream the LLM → stream TTS → publish PCM out.
   * Each external is its own fail-safe stage so one stage's failure is logged with WHERE it failed and the turn
   * is abandoned cleanly (history is only committed for stages that actually produced output).
   */
  private async runTurn(userText: string): Promise<void> {
    this.turnInFlight = true;
    this.aborted = false;
    this.framesThisTurn = 0;
    // The user's final utterance was just consumed → reset the VAD to silence so the FIRST sustained speech onset
    // while the agent talks is detected cleanly as a fresh barge-in (not contaminated by the prior episode's run).
    this.vad.reset();
    const startMs = this.deps.now();
    let stage = "llm";
    try {
      // Build the request history WITHOUT mutating committed state. The user + assistant turns are committed
      // ATOMICALLY only after a successful, non-empty, non-aborted reply (below), so an aborted / empty / failed
      // turn NEVER leaves a dangling user message — which would otherwise produce two consecutive user turns on
      // the NEXT utterance and break the strict user/assistant alternation the gateway/Claude requires.
      const userMsg: LlmMessage = { role: "user", content: userText };
      const reqMessages = [...this.messages, userMsg];

      // LLM (gateway/Claude) — stream the assistant text. Collected for history + fed to TTS. The request list is
      // a fresh snapshot so a long stream can't observe a later mutation + deps serialize a stable history.
      let assistant = "";
      for await (const delta of this.deps.complete(reqMessages)) {
        if (this.aborted) break; // step-4 barge-in seam: cancel the in-flight stream
        assistant += delta;
      }
      if (this.aborted) return;
      assistant = assistant.trim();
      if (assistant.length === 0) {
        this.deps.log("agent-turn-empty-llm", this.idFields());
        return;
      }
      // Commit BOTH turns atomically now that we have a real reply (history stays strictly alternating).
      this.messages.push(userMsg, { role: "assistant", content: assistant });

      // TTS (ElevenLabs streaming pcm_48000) → ingest socket via the EXACT echoFrame send path.
      stage = "tts";
      let pcmBytesOut = 0;
      const sock = this.deps.ingestSocket();
      for await (const pcm of this.deps.synthesize(assistant)) {
        if (this.aborted) break; // barge-in: stop publishing the now-stale reply mid-stream
        if (!sock || pcm.length === 0) continue;
        for (const chunk of chunkPcm(pcm)) {
          const seq = this.outSeq++;
          // timestamp 0: a real source timeline lands with the live ingest wiring slice; the contract field is
          // present + monotonic-by-seq. (proven-live-or-not-done: not claiming a real media timeline yet.)
          const wire = encodeIngestFrame(chunk, { sequenceNumber: seq, timestamp: 0 }, this.framing);
          sock.send(wire);
          pcmBytesOut += chunk.length;
        }
      }

      // Metering seam (step 7): structured-log the honest counts we have. NO fake meter emit.
      this.deps.log("agent-turn-meter", {
        ...this.idFields(),
        userChars: userText.length,
        assistantChars: assistant.length,
        pcmBytesOut,
        turnWallMs: this.deps.now() - startMs,
        // TODO(#81 step 7): emit voice_agent_minutes + llm tokens + elevenlabs chars to the gateway
        //                   (mirror src/metering.ts emitParticipantUsage → POST /v1/internal/usage).
      });
    } catch (e) {
      this.deps.log("agent-turn-error", { stage, ...this.idFields(), message: (e as Error)?.message ?? "unknown" });
    } finally {
      this.turnInFlight = false;
    }
  }

  /**
   * EXTERNAL barge-in seam: an out-of-band controller (e.g. a streaming-STT partial, a UI "stop", or a future
   * semantic endpointer) can also force an interrupt. Same effect as the VAD-driven `bargeIn()`. Kept so the
   * abort path has ONE owner regardless of the trigger source (design §L2.1: abort TTS + cancel LLM).
   */
  onUserSpeech(): void {
    this.bargeIn();
  }

  /**
   * Fire a barge-in: abort the in-flight turn so the LLM stream + TTS publish loops break on their next `aborted`
   * check and the agent goes silent. No-op when no turn is in flight (nothing to interrupt). Latency-instrumented:
   * we LOG the frame count from turn-start → this abort so a LIVE run can later prove the <300ms target — we make
   * NO latency claim here (no live run yet; proven-live-or-not-done). Idempotent within a turn (only the first
   * onset logs/sets; the TTS/LLM loops already broke on the flag).
   */
  private bargeIn(): void {
    if (!this.turnInFlight || this.aborted) return;
    this.aborted = true;
    this.deps.log("agent-turn-interrupt", {
      ...this.idFields(),
      // frames observed between turn-start and the detected onset — the wall-ms is the LIVE-run measurement.
      framesToAbort: this.framesThisTurn,
      onsetRms: Math.round(this.vad.lastFrameRms),
      // TODO(#81 step 4 LIVE-spike): on the Jake-named edge deploy, derive wall-ms from frame source timestamps
      //                              (FrameTiming) to PROVE detected-onset→silence < ~300ms end-to-end.
    });
  }

  private idFields(): Record<string, unknown> {
    return { org: this.config.org, room: this.config.roomId, agentId: this.config.agentId };
  }
}

/** Concatenate PCM chunks into one buffer (the accumulated utterance handed to STT). */
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── Live deps wiring (env → real STT / WAVE-gateway / ElevenLabs). Creds referenced, NEVER logged/returned. ──

/**
 * Env the turn-taking LIVE deps read. All step-3 creds are added here as HONEST names — real values come from
 * Doppler at deploy. INERT until provisioned: a missing cred fails its stage CLOSED (logged, turn abandoned),
 * it never crashes the DO. Extends AgentSessionEnv so the DO env is one shape.
 */
export interface AgentTurnEnv extends AgentSessionEnv, VadEnv {
  /** WAVE gateway origin for the LLM proxy (var; not a secret). e.g. https://api.wave.online */
  WAVE_GATEWAY_BASE?: string;
  /** Internal service-to-service bearer for the gateway LLM proxy (secret; deploy-time, never logged). */
  WAVE_GATEWAY_TOKEN?: string;
  /** Claude model id routed through the gateway (Opus/Sonnet per design). Defaults to a sensible Sonnet. */
  VOICE_AGENT_LLM_MODEL?: string;
  /** ElevenLabs API key (secret; server-side ONLY, never client, never logged). */
  ELEVENLABS_API_KEY?: string;
  /** ElevenLabs voice id for the agent persona (var). */
  ELEVENLABS_VOICE_ID?: string;
  /** Streaming STT provider base (var). The concrete provider is wired in the live builder. */
  VOICE_AGENT_STT_BASE?: string;
  /** Streaming STT provider key (secret; never logged). */
  VOICE_AGENT_STT_KEY?: string;
}

/** Default Claude model routed through the gateway. Sonnet = the sensible voice default (latency/cost); Opus is
 *  selectable via VOICE_AGENT_LLM_MODEL per the design's Opus/Sonnet choice. */
export const DEFAULT_VOICE_LLM_MODEL = "claude-sonnet-4-6";
/** ElevenLabs streaming output format — pcm_48000 = 16-bit LE PCM @ 48 kHz, exactly the ingest path's codec. */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_48000";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Build the LIVE turn-taking deps from env. Wires:
 *   • transcribe → the streaming STT provider (TODO #81 step 3 finalize: the in-repo #43 captions/STT spoke is
 *     the intended source — until that streaming contract is pinned, this fails CLOSED when STT creds are unset
 *     rather than faking a transcript. It is a documented honest gap, NOT a silent no-op).
 *   • complete   → the WAVE gateway LLM proxy (Claude Opus/Sonnet), streamed (SSE/NDJSON), Bearer service token.
 *   • synthesize → ElevenLabs streaming TTS, pcm_48000, key server-side only.
 * Tests pass fakes instead of calling this. The DO calls this ONLY behind voiceAgentEnabled(env).
 */
export function buildTurnDeps(
  env: AgentTurnEnv,
  media: AgentMediaDeps,
  fetchImpl: FetchLike = fetch,
): AgentTurnDeps & AgentMediaDeps {
  return {
    ...media,
    async transcribe(pcm: Uint8Array): Promise<SttResult> {
      if (!env.VOICE_AGENT_STT_BASE || !env.VOICE_AGENT_STT_KEY) {
        // Fail CLOSED + loud — not provisioned yet (the #43 streaming-STT contract lands this step's finalize).
        throw new AgentSessionError("STT_NOT_CONFIGURED", "streaming STT base/key not provisioned", 503);
      }
      return transcribeViaProvider(fetchImpl, env, pcm);
    },
    async *complete(messages: LlmMessage[]): AsyncIterable<string> {
      if (!env.WAVE_GATEWAY_BASE || !env.WAVE_GATEWAY_TOKEN) {
        throw new AgentSessionError("LLM_NOT_CONFIGURED", "WAVE gateway base/token not provisioned", 503);
      }
      yield* streamGatewayLlm(fetchImpl, env, messages);
    },
    async *synthesize(text: string): AsyncIterable<Uint8Array> {
      if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
        throw new AgentSessionError("TTS_NOT_CONFIGURED", "ElevenLabs key/voice not provisioned", 503);
      }
      yield* streamElevenLabs(fetchImpl, env, text);
    },
  };
}

/**
 * Stream the LLM via the WAVE gateway (Claude Opus/Sonnet), ALWAYS through the gateway (design §L1 LOCKED — the
 * gateway is the metering + auth authority; never a direct Anthropic call). Posts the messages to the gateway's
 * Anthropic-compatible streaming endpoint with the internal Bearer; yields each assistant text delta. The exact
 * gateway path + stream envelope is pinned with the gateway side this step (TODO #81): the gateway already
 * proxies Claude (design §L2) — this consumes Anthropic-style SSE `content_block_delta` text deltas.
 */
async function* streamGatewayLlm(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  messages: LlmMessage[],
): AsyncIterable<string> {
  const base = env.WAVE_GATEWAY_BASE!.replace(/\/+$/, "");
  const model = env.VOICE_AGENT_LLM_MODEL ?? DEFAULT_VOICE_LLM_MODEL;
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages.filter((m) => m.role !== "system");
  const res = await fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.WAVE_GATEWAY_TOKEN}`, // gateway service token — never logged
      accept: "text/event-stream",
    },
    body: JSON.stringify({ model, max_tokens: 1024, stream: true, system, messages: turns }),
  });
  if (!res.ok || !res.body) {
    throw new AgentSessionError("LLM_UPSTREAM", `gateway LLM returned ${res.status}`, 502);
  }
  for await (const evt of sseEvents(res.body)) {
    // Anthropic SSE: { type:"content_block_delta", delta:{ type:"text_delta", text } }
    const text = (evt as { delta?: { text?: string } })?.delta?.text;
    if (typeof text === "string" && text.length > 0) yield text;
  }
}

/**
 * Stream ElevenLabs TTS → pcm_48000 chunks (16-bit LE @ 48 kHz, zero transcode for the ingest path). Key is
 * server-side ONLY (xi-api-key header), never logged, never returned. The HTTP streaming endpoint returns the
 * raw PCM body in chunks; we yield each chunk straight to the caller for just-in-time publish (tight barge-in).
 */
async function* streamElevenLabs(
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
    throw new AgentSessionError("TTS_UPSTREAM", `ElevenLabs returned ${res.status}`, 502);
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) yield value;
  }
}

/**
 * Streaming STT via the configured provider. The concrete request shape is pinned alongside the #43 captions/STT
 * streaming spoke (TODO #81 step-3 finalize): this single round-trip variant posts the accumulated PCM and reads
 * one {isFinal,transcript} result. A truly STREAMING (per-partial) STT replaces this behind the SAME `transcribe`
 * seam with no change to TurnTakingCore. It is NOT a fake — it makes a real call when creds exist and fails
 * CLOSED (caller logs + abandons the turn) when the provider errors.
 */
async function transcribeViaProvider(
  fetchImpl: FetchLike,
  env: AgentTurnEnv,
  pcm: Uint8Array,
): Promise<SttResult> {
  const base = env.VOICE_AGENT_STT_BASE!.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/v1/transcribe/stream`, {
    method: "POST",
    headers: {
      "content-type": "audio/pcm",
      authorization: `Bearer ${env.VOICE_AGENT_STT_KEY}`, // STT key — never logged
    },
    body: pcm,
  });
  if (!res.ok) throw new AgentSessionError("STT_UPSTREAM", `STT returned ${res.status}`, 502);
  const json = (await res.json().catch(() => ({}))) as { isFinal?: unknown; transcript?: unknown };
  return {
    isFinal: json.isFinal === true,
    transcript: typeof json.transcript === "string" ? json.transcript : "",
  };
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
}

/** Re-export for callers that need it next to the turn module. */
export type { IngestSocket };
