/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b), build-order step 2 — AgentSessionDO: the per-room voice-agent session
 * Durable Object skeleton + the deployable live-spike echo harness.
 *
 * ONE DO instance == ONE agent in ONE room/call (design §L1: per-room agent-session DO). For THIS step the
 * DO does the media plumbing ONLY — bind to a room, open TWO co-existing CF Realtime WS media-transport
 * adapters on one DO, and echo received PCM back out — to prove the media path end-to-end before STT/LLM/TTS
 * land on top. It does NOT do STT/LLM/TTS/VAD/Twilio/metering (later steps; honest TODOs link #81).
 *
 * ── THE TWO ADAPTERS, CO-EXISTENT ON ONE DO ────────────────────────────────────────────────────────────
 *  • EGRESS (subscribe): `createWebsocketAdapter` (location:"remote", outputCodec:"pcm") tells the SFU to
 *    dial OUT to our egress WS route and PUSH a participant's audio as decoded 16-bit LE PCM 48k stereo
 *    frames. We decode each frame with the PROVEN `decodePacket` (container-adapter.ts) → PCM in.
 *  • INGEST (publish): `createIngestAdapter` (location:"local") tells the SFU to PUBLISH a NEW track sourced
 *    from PCM we SEND over a second WS. We frame PCM with `encodeIngestFrame` → PCM out.
 *  Both adapters belong to ONE AgentSessionDO so a single DO owns the full duplex audio loop for its room.
 *  The DO holds NO sockets in this skeleton's pure core — the WS lifecycle is injected (a seam), so the core
 *  is unit-testable with a mock WS and the live DO supplies the real WebSocketPair / outbound connect.
 *
 * ── ECHO HARNESS ───────────────────────────────────────────────────────────────────────────────────────
 *  Every PCM frame received on egress is immediately re-sent on ingest (`echoFrame`). This is the live-spike
 *  payload: a real room participant should HEAR their own audio looped back through the agent — proving (a)
 *  egress decode works, (b) ingest publish-back works, and (c) two adapters co-exist on one DO. No STT/LLM/
 *  TTS is involved; the agent track is literally the human's PCM re-published.
 *
 * ── INERT WITHOUT THE FLAG ──────────────────────────────────────────────────────────────────────────────
 *  Nothing here runs unless `VOICE_AGENT_PROVIDER==="wave"`. `voiceAgentEnabled(env)` is the single gate the
 *  dispatch route + the egress WS route check; the DO class export merely resolves the wrangler binding.
 *
 * ── TIMING INSTRUMENTATION ──────────────────────────────────────────────────────────────────────────────
 *  Each received/echoed frame is timestamped (injectable `now`) so a later LIVE run can measure
 *  stop-sending→silence latency for barge-in. We LOG timestamps only — NO latency/perf claim is made here
 *  (no live run yet; proven-live-or-not-done).
 */
import {
  createWebsocketAdapter,
  decodePacket,
  type WsAdapterTrack,
  type CreateAdapterResult,
} from "./encoders/container-adapter.js";
import {
  createIngestAdapter,
  encodeIngestFrame,
  chunkPcm,
  type IngestAdapterTrack,
  type IngestFraming,
  type CreateIngestAdapterResult,
} from "./agent-ingest-adapter.js";
import { TurnTakingCore, buildTurnDeps, type AgentTurnEnv } from "./agent-turn.js";
import { vadConfigFromEnv } from "./agent-vad.js";

/** The flag value that arms the WAVE voice agent. Anything else → fully inert. */
export const VOICE_AGENT_PROVIDER_WAVE = "wave";

/** True ONLY when the WAVE voice-agent provider is selected. The one gate every new route/DO behavior checks. */
export function voiceAgentEnabled(env: { VOICE_AGENT_PROVIDER?: string }): boolean {
  return env.VOICE_AGENT_PROVIDER === VOICE_AGENT_PROVIDER_WAVE;
}

/** Config to bind an AgentSessionDO to a room + the participant track it agents. Validated before use. */
export interface AgentSessionConfig {
  roomId: string;
  org: string;
  agentId: string;
  /** The SFU session id of the human participant whose audio we subscribe to (egress). */
  participantSessionId: string;
  /** The participant track name to subscribe to (egress). */
  participantTrackName: string;
  /** The track name the agent publishes back (ingest). Defaults to `agent-${agentId}`. */
  agentTrackName?: string;
}

const SAFE = /^[A-Za-z0-9_:.-]{1,128}$/;
const SESSIONID = /^[0-9a-zA-Z_-]{8,128}$/;

/** A minimal outbound WS the ingest side sends on (the live DO supplies a real socket; tests a mock). */
export interface IngestSocket {
  send(data: ArrayBufferView | ArrayBuffer): void;
  close?(): void;
}

/**
 * Injectable media seam — the live DO wires these to real CF Realtime adapters + sockets; tests pass fakes.
 * This is what keeps AgentSessionCore pure + unit-testable (no live SFU/WS needed).
 */
export interface AgentMediaDeps {
  /** Create the EGRESS (subscribe) adapter so the SFU dials our egress endpoint and pushes participant PCM. */
  createEgress(tracks: WsAdapterTrack[]): Promise<CreateAdapterResult>;
  /** Create the INGEST (publish) adapter so the SFU publishes a track from the PCM we send. */
  createIngest(tracks: IngestAdapterTrack[]): Promise<CreateIngestAdapterResult>;
  /** Obtain the outbound ingest socket once the ingest adapter has connected (live DO holds the server WS). */
  ingestSocket(): IngestSocket | null;
  /** Wall clock (ms). Injectable so timing instrumentation is deterministic in tests. */
  now(): number;
  /** Structured log sink (JSON line). Injectable so tests can assert on emitted instrumentation. */
  log(msg: string, fields: Record<string, unknown>): void;
}

/** The public wss base the SFU dials back to (our edge). Used to build adapter endpoints. */
export interface AgentEndpoints {
  /** e.g. wss://rt.wave.online — the agent egress route + ingest route hang off this. */
  baseWss: string;
  /** Capability token appended as ?t= to the egress endpoint (SFU can't send x-wave-internal). */
  egressToken?: string;
}

/** One timing sample for the barge-in measurement a LIVE run will later analyze (logged, never claimed). */
export interface FrameTiming {
  direction: "in" | "out";
  sequenceNumber: number;
  /** Packet source timestamp (units UNKNOWN until the live spike — see contract). */
  sourceTs: number;
  /** Our wall-clock receive/send time (ms). */
  wallMs: number;
}

/**
 * AgentSessionCore — the pure, testable state machine for one agent session. Holds the bind config + the
 * adapter handles + the echo loop; persists nothing itself (the DO wrapper owns DO storage). Every media op
 * is fail-safe: an echo/send error is logged, never thrown up the WS message path (media-safety > agent).
 */
export class AgentSessionCore {
  private config: AgentSessionConfig | null = null;
  private egress: CreateAdapterResult | null = null;
  private ingest: CreateIngestAdapterResult | null = null;
  private outSeq = 0;
  private framing: IngestFraming;
  /** Bounded ring of recent timing samples for the live barge-in measurement (logged, not retained forever). */
  private readonly timings: FrameTiming[] = [];
  private static readonly MAX_TIMINGS = 512;

  constructor(
    private readonly deps: AgentMediaDeps,
    opts?: { framing?: IngestFraming },
  ) {
    // DEFAULT "packet" — modeled symmetric to the verified egress decoder; the live spike may flip to "raw".
    this.framing = opts?.framing ?? "packet";
  }

  get bound(): AgentSessionConfig | null {
    return this.config;
  }

  /** Validate + record the room/track binding. Idempotent for the same config; rejects a conflicting rebind. */
  bind(config: AgentSessionConfig): AgentSessionConfig {
    for (const [k, v] of Object.entries({
      roomId: config.roomId,
      org: config.org,
      agentId: config.agentId,
      participantTrackName: config.participantTrackName,
    })) {
      if (!SAFE.test(String(v ?? ""))) throw new AgentSessionError("BAD_CONFIG", `invalid ${k}`, 400);
    }
    if (!SESSIONID.test(config.participantSessionId || "")) {
      throw new AgentSessionError("BAD_CONFIG", "invalid participantSessionId", 400);
    }
    if (this.config) {
      if (this.config.roomId !== config.roomId || this.config.org !== config.org) {
        throw new AgentSessionError("ALREADY_BOUND", "agent session is bound to a different room/org", 409);
      }
      return this.config;
    }
    this.config = { agentTrackName: `agent-${config.agentId}`, ...config };
    return this.config;
  }

  /**
   * Open BOTH adapters for the bound session: egress (subscribe to the participant's PCM) + ingest (publish
   * the agent's PCM track). This is the "two adapters co-exist on one DO" proof. Returns the two adapter
   * results. Must be bound first. The actual SFU dial-back / socket connect is the injected media seam.
   */
  async openAdapters(endpoints: AgentEndpoints): Promise<{ egress: CreateAdapterResult; ingest: CreateIngestAdapterResult }> {
    const c = this.requireBound();
    if (!/^wss:\/\//.test(endpoints.baseWss || "")) {
      throw new AgentSessionError("BAD_ENDPOINT", "baseWss must be a wss:// URL", 400);
    }
    const tokenQs = endpoints.egressToken ? `?t=${encodeURIComponent(endpoints.egressToken)}` : "";
    const egressEndpoint =
      `${endpoints.baseWss.replace(/\/+$/, "")}/v1/realtime/agents/egress/` +
      `${encodeURIComponent(c.org)}/${encodeURIComponent(c.roomId)}/${encodeURIComponent(c.participantSessionId)}/${encodeURIComponent(c.participantTrackName)}${tokenQs}`;
    const ingestEndpoint =
      `${endpoints.baseWss.replace(/\/+$/, "")}/v1/realtime/agents/ingest/` +
      `${encodeURIComponent(c.org)}/${encodeURIComponent(c.roomId)}/${encodeURIComponent(c.participantSessionId)}/${encodeURIComponent(c.agentTrackName!)}${tokenQs}`;

    this.egress = await this.deps.createEgress([
      { location: "remote", sessionId: c.participantSessionId, trackName: c.participantTrackName, endpoint: egressEndpoint, outputCodec: "pcm" },
    ]);
    this.ingest = await this.deps.createIngest([
      { location: "local", sessionId: c.participantSessionId, trackName: c.agentTrackName!, endpoint: ingestEndpoint, inputCodec: "pcm" },
    ]);
    this.deps.log("agent-adapters-open", {
      org: c.org, room: c.roomId, agentId: c.agentId,
      egressAdapterId: this.egress.adapterId, ingestAdapterId: this.ingest.adapterId,
    });
    return { egress: this.egress, ingest: this.ingest };
  }

  /**
   * ECHO HARNESS — feed ONE raw egress WS binary frame (one Packet): decode → PCM in → re-send the SAME PCM
   * out the ingest socket. This is the live-spike payload (the agent track == the human's looped-back audio).
   * Fail-safe: any decode/send error is logged and swallowed (never breaks the live media the SFU pushes).
   * Records IN + OUT timing samples for the later barge-in latency measurement.
   */
  async echoFrame(frame: Uint8Array): Promise<void> {
    try {
      const pkt = decodePacket(frame);
      if (pkt.payload.length === 0) return; // keep-alive / empty
      this.record({ direction: "in", sequenceNumber: pkt.sequenceNumber, sourceTs: pkt.timestamp, wallMs: this.deps.now() });
      const sock = this.deps.ingestSocket();
      if (!sock) return; // ingest not connected yet → drop (the SFU re-sends continuous audio)
      // Just-in-time send (keeps the send-ahead buffer minimal → tight barge-in, per the spike's risk note).
      // Chunk to the ≤32KB ceiling defensively though one egress frame is already ≤32KB.
      for (const chunk of chunkPcm(pkt.payload)) {
        const seq = this.outSeq++;
        const wire = encodeIngestFrame(chunk, { sequenceNumber: seq, timestamp: pkt.timestamp }, this.framing);
        sock.send(wire);
        this.record({ direction: "out", sequenceNumber: seq, sourceTs: pkt.timestamp, wallMs: this.deps.now() });
      }
    } catch (e) {
      this.deps.log("agent-echo-error", { message: (e as Error)?.message ?? "unknown" });
    }
  }

  /** Snapshot of the most recent timing samples — a LIVE run analyzes these for stop→silence latency. */
  timingSamples(): readonly FrameTiming[] {
    return this.timings;
  }

  /** Close both adapters' send side + log. Best-effort, never throws. */
  close(): void {
    try {
      this.deps.ingestSocket()?.close?.();
    } catch {
      /* best-effort */
    }
    this.deps.log("agent-session-close", { org: this.config?.org, room: this.config?.roomId, agentId: this.config?.agentId });
  }

  private record(t: FrameTiming): void {
    this.timings.push(t);
    if (this.timings.length > AgentSessionCore.MAX_TIMINGS) this.timings.shift();
  }

  private requireBound(): AgentSessionConfig {
    if (!this.config) throw new AgentSessionError("NOT_BOUND", "agent session is not bound to a room", 409);
    return this.config;
  }
}

/** Typed boundary error for the agent-session layer (mirrors SfuError/SfuAdapterError envelope). */
export class AgentSessionError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
    this.name = "AgentSessionError";
  }
}

// ── DO runtime shapes (avoid a hard cloudflare:workers dependency in this skeleton; mirrors room.ts) ───────

interface DurableObjectStateLike {
  storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> };
}

/** Env the AgentSessionDO reads. INERT unless VOICE_AGENT_PROVIDER==="wave". All creds referenced, not valued. */
export interface AgentSessionEnv {
  VOICE_AGENT_PROVIDER?: string; // "wave" arms; absent/anything-else → fully inert
  CF_CALLS_APP_ID?: string; // CF Realtime SFU app id (adapter create) — unset → fails closed
  CF_CALLS_APP_SECRET?: string; // CF Realtime SFU app bearer — never logged/returned
  WAVE_INTERNAL_SECRET?: string; // capability-token key for the egress/ingest WS dial-in
  AGENT_PUBLIC_WSS?: string; // our public wss base the SFU dials back to (default rt.wave.online)
  /** Send-side ingest framing override; "packet" (default, modeled) | "raw" (the live spike may select). */
  AGENT_INGEST_FRAMING?: IngestFraming;
  /** Step-3: the agent persona / system prompt for turn-taking (var; default in buildTurnSystemPrompt). */
  VOICE_AGENT_SYSTEM_PROMPT?: string;
  /** test-only: injected adapter-create fetch (defaults to global fetch). Never a wire input. */
  __agentFetch?: typeof fetch;
  // ── HONEST EXTENSION POINTS (later #81 steps — NOT stubbed to pretend they work) ──
  // STT:        streaming STT provider creds (step 3). NOT present → no transcription (echo-only today).
  // LLM:        WAVE gateway base + service token for Opus/Sonnet (step 3, design §L1 LOCKED).
  // TTS:        ELEVENLABS_API_KEY (step 3, design TTS LOCKED). Server-side only.
  // VAD/barge:  interrupt-controller config (step 4).
  // Twilio:     phone-leg bridge (step 6).
  // Metering:   voice_agent_minutes via the gateway (step 7).
}

/**
 * AgentSessionDO — the Durable Object wrapper (mirrors RoomDO). Holds one AgentSessionCore. The worker
 * dispatch route binds it to a room; the agent egress WS route forwards each decoded media frame here via
 * `echoFrame`. Registered in wrangler (AGENT_SESSION binding + migration). INERT: the worker only routes to
 * it when voiceAgentEnabled(env) — this export merely resolves the binding so the migration can deploy.
 *
 * NOTE: the live socket + outbound-connect wiring (the real WebSocketPair for the egress route, and the
 * outbound ingest connection the SFU dials) is supplied by the DO's fetch()/WS handlers in a later wiring
 * slice. This skeleton ships the CORE (bind + two-adapter create + echo + timing) fully tested, plus the DO
 * shell + a typed control-plane fetch() for bind/info, so the binding + migration deploy and the next step
 * only adds socket plumbing — NOT a stub that fakes media.
 */
export class AgentSessionDO {
  private readonly core: AgentSessionCore;
  private readonly env: AgentTurnEnv;
  private ingest: IngestSocket | null = null;
  /** Step-3 turn-taking core, armed on bind when the provider is WAVE (replaces echo as the live behavior). */
  private turn: TurnTakingCore | null = null;

  constructor(_state: DurableObjectStateLike, env?: AgentTurnEnv) {
    this.env = env ?? {};
    this.core = new AgentSessionCore(this.buildMediaDeps(), { framing: this.env.AGENT_INGEST_FRAMING });
  }

  /** Control-plane surface: POST /bind {config} → bind + open adapters; GET /info → bound state + timings. */
  async fetch(request: Request): Promise<Response> {
    if (!voiceAgentEnabled(this.env)) {
      // INERT: the provider isn't WAVE → this DO does nothing (config-no-silent-noop: honest 501, not a fake ok).
      return Response.json({ error: "VOICE_AGENT_NOT_ENABLED", message: "VOICE_AGENT_PROVIDER!=wave" }, { status: 501 });
    }
    const path = new URL(request.url).pathname.replace(/^\/+/, "");
    // The agent egress WS route forwards each decoded frame here as a raw binary POST. Fail-open: always
    // 204, never throws (a recording/echo error must not affect the live media the SFU is also pushing).
    if (path === "echo-frame" && request.method === "POST") {
      try {
        const buf = new Uint8Array(await request.arrayBuffer());
        // Step 3: once a turn-taking core is armed (bound under VOICE_AGENT_PROVIDER=wave) frames drive a real
        // conversational turn; until armed (or if turn-taking is unwired) we fall back to the echo harness.
        if (buf.length > 0) await (this.turn ? this.turn.onFrame(buf) : this.core.echoFrame(buf));
      } catch {
        /* fail-open */
      }
      return new Response(null, { status: 204 });
    }
    try {
      if (path === "bind" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { config?: AgentSessionConfig };
        if (!body.config) throw new AgentSessionError("BAD_REQUEST", "config is required", 400);
        const bound = this.core.bind(body.config);
        const baseWss = this.env.AGENT_PUBLIC_WSS ?? "wss://rt.wave.online";
        const { egress, ingest } = await this.core.openAdapters({ baseWss });
        this.armTurnTaking(bound); // step 3: arm the turn core for this binding (replaces echo on frames)
        return Response.json(
          { ok: true, bound, egressAdapterId: egress.adapterId, ingestAdapterId: ingest.adapterId },
          { status: 200 },
        );
      }
      if (path === "info" && request.method === "GET") {
        return Response.json({ bound: this.core.bound, timings: this.core.timingSamples() }, { status: 200 });
      }
      return Response.json({ error: "BAD_REQUEST", message: `unknown agent intent: ${path}` }, { status: 400 });
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "AGENT_ERROR";
      const status = (e as { status?: number })?.status ?? 500;
      return Response.json({ error: code, message: (e as Error)?.message ?? "unexpected error" }, { status });
    }
  }

  /** Feed one decoded egress WS frame: a real turn when armed (step 3), else the echo harness (fallback). */
  echoFrame(frame: Uint8Array): Promise<void> {
    return this.turn ? this.turn.onFrame(frame) : this.core.echoFrame(frame);
  }

  /**
   * Arm the step-3 turn-taking core for a binding. INERT unless VOICE_AGENT_PROVIDER=wave. Lazily imported so
   * the skeleton's binding/migration deploy is unaffected. Wires LIVE STT/gateway-LLM/ElevenLabs deps from env
   * (creds referenced, never logged) over the same media deps the echo core uses. Fail-soft: if arming throws,
   * the DO keeps the echo fallback (media safety > agent) — never crashes the bind.
   */
  private armTurnTaking(bound: AgentSessionConfig): void {
    if (!voiceAgentEnabled(this.env)) return;
    try {
      const media = this.buildMediaDeps();
      const deps = buildTurnDeps(this.env, media, this.env.__agentFetch ?? fetch);
      this.turn = new TurnTakingCore(deps, { ...bound, systemPrompt: this.env.VOICE_AGENT_SYSTEM_PROMPT }, {
        framing: this.env.AGENT_INGEST_FRAMING,
        vad: vadConfigFromEnv(this.env), // step 4: barge-in VAD thresholds (env-overridable, sensible defaults)
      });
      media.log("agent-turn-armed", { org: bound.org, room: bound.roomId, agentId: bound.agentId });
    } catch (e) {
      this.buildMediaDeps().log("agent-turn-arm-error", { message: (e as Error)?.message ?? "unknown" });
    }
  }

  /** Live media deps: real adapter-create calls + the DO-held ingest socket. SFU bearer from app creds. */
  private buildMediaDeps(): AgentMediaDeps {
    const env = this.env;
    const fetchImpl = env.__agentFetch ?? fetch;
    const bearer = env.CF_CALLS_APP_SECRET ?? "";
    const appId = env.CF_CALLS_APP_ID ?? "";
    return {
      createEgress: (tracks) => createWebsocketAdapter({ fetchImpl }, { appId, bearer, tracks }),
      createIngest: (tracks) => createIngestAdapter({ fetchImpl }, { appId, bearer, tracks }),
      ingestSocket: () => this.ingest,
      now: () => Date.now(),
      log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
    };
  }
}
