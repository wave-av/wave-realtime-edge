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
import { TurnTakingCore, buildTurnDeps, toolAllowlistFromEnv, ttsLeadMsFromEnv, type AgentTurnEnv } from "./agent-turn.js";
import { toolCatalogFromGateway } from "./agent-tools.js";
import { vadConfigFromEnv } from "./agent-vad.js";
import { voiceCogsRatesFromEnv } from "./voice-cogs.js";
import { spectrumLogMagnitude, cepstrumPitch } from "./fft.js";
import { mintRecorderToken } from "./encoders/recorder-auth.js";

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
  /** Headless mode: a non-browser client (CLI / on-prem / cloud) drives the turn over the audio-in + TTS
   *  WS instead of the SFU egress/ingest. Skips the SFU adapter create (no real SFU session) — the DO still
   *  arms the turn core and mints the audio-in + TTS capability tokens. */
  headless?: boolean;
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
  /** Sleep `ms`. Injectable so TTS real-time pacing (barge-in) is deterministic in tests. Optional → setTimeout. */
  delay?(ms: number): Promise<void>;
  /** Structured log sink (JSON line). Injectable so tests can assert on emitted instrumentation. */
  log(msg: string, fields: Record<string, unknown>): void;
}

/** The public wss base the SFU dials back to (our edge). Used to build adapter endpoints. */
export interface AgentEndpoints {
  /** e.g. wss://rt.wave.online — the agent egress route + ingest route hang off this. */
  baseWss: string;
  /** Capability token (?t=) for the EGRESS endpoint — bound to (org, participantSessionId, participantTrackName).
   *  The SFU can't send x-wave-internal, so without this its dial-in 401s and CF returns
   *  "create websocket adapter returned 503" (websocket_handshake_failed). */
  egressToken?: string;
  /** Capability token (?t=) for the INGEST endpoint — bound to (org, participantSessionId, agentTrackName).
   *  MUST be a SEPARATE token from egressToken: the route verifies it against the AGENT track name, not the
   *  participant's, so one token cannot authorize both endpoints. */
  ingestToken?: string;
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
    // Per-endpoint capability tokens — egress binds the PARTICIPANT track, ingest binds the AGENT track, so
    // they MUST differ (each route verifies the token against its own trackName segment). A missing/mismatched
    // token makes the SFU's WS dial-in 401 → CF reports websocket_handshake_failed → "returned 503".
    const egTokenQs = endpoints.egressToken ? `?t=${encodeURIComponent(endpoints.egressToken)}` : "";
    const inTokenQs = endpoints.ingestToken ? `?t=${encodeURIComponent(endpoints.ingestToken)}` : "";
    const egressEndpoint =
      `${endpoints.baseWss.replace(/\/+$/, "")}/v1/realtime/agents/egress/` +
      `${encodeURIComponent(c.org)}/${encodeURIComponent(c.roomId)}/${encodeURIComponent(c.participantSessionId)}/${encodeURIComponent(c.participantTrackName)}${egTokenQs}`;
    const ingestEndpoint =
      `${endpoints.baseWss.replace(/\/+$/, "")}/v1/realtime/agents/ingest/` +
      `${encodeURIComponent(c.org)}/${encodeURIComponent(c.roomId)}/${encodeURIComponent(c.participantSessionId)}/${encodeURIComponent(c.agentTrackName!)}${inTokenQs}`;

    this.egress = await this.deps.createEgress([
      { location: "remote", sessionId: c.participantSessionId, trackName: c.participantTrackName, endpoint: egressEndpoint, outputCodec: "pcm" },
    ]);
    this.ingest = await this.deps.createIngest([
      { location: "local", sessionId: c.participantSessionId, trackName: c.agentTrackName!, endpoint: ingestEndpoint, inputCodec: "pcm", mode: "buffer" },
    ]);
    this.deps.log("agent-adapters-open", {
      org: c.org, room: c.roomId, agentId: c.agentId,
      egressAdapterId: this.egress.adapterId, ingestAdapterId: this.ingest.adapterId,
      // The SESSION the agent track was actually published on (CF's own, NOT the participant's) — consumers pull
      // agentTrackName from here. Logged so the mismatch is visible (#29). Falls back to participant if absent.
      agentSessionId: this.ingest.publishedSessionId ?? c.participantSessionId,
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
  /** Native hibernation-safe WS acceptance (the CF reference + room.ts use this; the stateless WebSocketPair
   *  does NOT survive a DO eviction or register the socket with the runtime). Optional so tests can omit it. */
  acceptWebSocket?(ws: WebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): WebSocket[];
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
  /** flow-tap (signal-flow E1): when "true"/"1", emit the observer transition records on the voice-agent flow. */
  AGENT_FLOW_TAP?: string;
  /** FFT tap (audio-signal-plane E1): when "true"/"1", emit the live egress spectrum (node "fft", evt "spectrum"). */
  AGENT_FFT_TAP?: string;
  /** Echo-mute grace after a turn (ms) — drops the mic during the reverberation tail (default 400; 0 disables). */
  AGENT_ECHO_MUTE_MS?: string;
  /** Step-4 barge-in: TTS send-ahead lead (ms) for real-time pacing → interruptible playout (default 150). */
  AGENT_TTS_LEAD_MS?: string | number;
  /** ElevenLabs optimize_streaming_latency (0-4): higher = lower first-audio latency. Default 3. */
  VOICE_AGENT_TTS_LATENCY?: string;
  /** Step-3: the agent persona / system prompt for turn-taking (var; default in buildTurnSystemPrompt). */
  VOICE_AGENT_SYSTEM_PROMPT?: string;
  /** test-only: injected adapter-create fetch (defaults to global fetch). Never a wire input. */
  __agentFetch?: typeof fetch;
  /** R2 bucket for the session transcript (recorded on read so every offered transcript is also retained). */
  RT_RECORDINGS?: R2Bucket;
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
  private readonly state: DurableObjectStateLike;
  private ingest: IngestSocket | null = null;
  /** FFT-tap frame counter (decimation for the live spectrum — see the echo-frame handler). */
  private fftTapFrame = 0;
  /** Latest computed spectrum (the FFT tap's output) — served by the spectrum endpoint for the dashboard. */
  private latestSpectrum: { bins: number[]; at: number } | null = null;
  /** Muted (voice-control-deck E1): when true the egress audio is dropped (no STT/turn/FFT). */
  private muted = false;
  /** Direct-playback client sockets: the browser dials the TTS route and we fan speak() PCM out to each. */
  private ttsClients: WebSocket[] = [];
  /** Audio-in sockets (the headless "mic"): the runtime delivers their frames to webSocketMessage(). */
  private audioInSockets = new Set<WebSocket>();
  /** Step-3 turn-taking core, armed on bind when the provider is WAVE (replaces echo as the live behavior). */
  private turn: TurnTakingCore | null = null;

  constructor(_state: DurableObjectStateLike, env?: AgentTurnEnv) {
    this.state = _state;
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
        // MUTED (voice-control-deck E1): drop the egress audio entirely — no STT, no turn, no FFT. The agent
        // listens again only on unmute. Fail-closed: nothing leaks while muted.
        if (this.muted) return new Response(null, { status: 204 });
        const buf = new Uint8Array(await request.arrayBuffer());
        // FFT tap (wave-audio-signal-plane E1): flag-gated live spectrum of the egress PCM — the Fourier truth
        // the audio.wave.online dashboard renders. Decimated to every 4th frame (≈12.5 fps) to keep it cheap.
        if ((this.env.AGENT_FFT_TAP === "true" || this.env.AGENT_FFT_TAP === "1") && (this.fftTapFrame = (this.fftTapFrame + 1) & 3) === 0) {
          try {
            const bins = spectrumLogMagnitude(buf, 64);
            const pitch = cepstrumPitch(buf); // cepstral pitch (Bogert–Healy–Tukey) — 0 when unvoiced
            this.latestSpectrum = { bins, at: Date.now() };
            console.log(JSON.stringify({ flow: "voice-agent", node: "fft", evt: "spectrum", bins, pitch }));
            // Transport the spectrum to the audio showcase (fire-and-forget — never blocks the media path).
            fetch("https://audio.wave.online/v1/audio/taps/ingest", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ bins, pitch, at: this.latestSpectrum.at }),
            }).catch(() => {});
          } catch {
            /* a tap must never break the live media path */
          }
        }
        // Step 3: once a turn-taking core is armed (bound under VOICE_AGENT_PROVIDER=wave) frames drive a real
        // conversational turn; until armed (or if turn-taking is unwired) we fall back to the echo harness.
        if (buf.length > 0) {
          await (this.turn ? this.turn.onFrame(buf) : this.core.echoFrame(buf));
          // A stop word muted the agent (voice-control-deck E1.P1) — the core set muteRequested; honor it here.
          if (this.turn?.muteRequested) {
            this.turn.muteRequested = false;
            this.muted = true;
          }
        }
      } catch {
        /* fail-open */
      }
      return new Response(null, { status: 204 });
    }
    // The agent INGEST WS: the SFU dials IN to PULL the agent's published audio (createIngestAdapter
    // location:"local"). We perform the upgrade HERE so THIS DO owns the live socket — buildMediaDeps()
    // .ingestSocket() reads `this.ingest`, so both the echo core and the turn-taking core publish the agent's
    // PCM through this same socket. Without this leg the agent could hear the room (egress) but never speak
    // back (every outbound frame was dropped at AgentSessionCore.echoFrame's `if (!sock) return`).
    if (path === "ingest" && (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
      if (!WSP) {
        return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
      }
      const pair = new WSP();
      const client = (pair as unknown as Record<string, WebSocket>)[0];
      const server = (pair as unknown as Record<string, WebSocket>)[1];
      // Native hibernation-safe acceptance (the CF reference + room.ts path): registers the socket with the
      // DO runtime so it survives eviction + the SFU's dial-in stays bound. Falls back to the stateless
      // WebSocketPair.accept() only when the DO runtime is absent (unit tests) — never in prod.
      if (this.state.acceptWebSocket) {
        this.state.acceptWebSocket(server);
      } else {
        server.accept();
      }
      try {
        (server as unknown as { binaryType?: string }).binaryType = "arraybuffer";
      } catch {
        /* binaryType not settable on some runtimes — we only SEND on this socket, so it's non-fatal */
      }
      // Hold the live socket as the ingest sink. Null it on close/error so a dropped SFU connection stops sends
      // cleanly; the SFU re-dials on reconnect → a fresh upgrade installs a new sink (the `===` guard means a
      // late close event from an old socket can't clear a newer one).
      const sink: IngestSocket = {
        send: (d) => server.send(d),
        close: () => {
          try {
            server.close();
          } catch {
            /* best-effort */
          }
        },
      };
      this.ingest = sink;
      const clear = (): void => {
        if (this.ingest === sink) this.ingest = null;
        // Session-end recording (E1 close-hook): when the SFU drops the ingest sink, the room's media
        // is over — persist the transcript so a session that is never read still records. Overwrite-safe
        // (same `transcript:{org}:{room}:{session}.json` key) and best-effort (never fails the close path).
        void this.persistTranscript();
      };
      server.addEventListener("close", clear);
      server.addEventListener("error", clear);
      console.log(JSON.stringify({ msg: "agent-ingest-open", bound: this.core.bound?.roomId ?? null }));
      try {
        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      } catch {
        return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      }
    }
    // The agent TTS playout WS: the CLIENT dials IN to receive the agent's TTS PCM directly (the direct-playback
    // path — bypasses the broken SFU ingest). We accept the socket here (native hibernation-safe) + add it to the
    // broadcast sink set so speak() fans the TTS PCM to it. One socket = one listener; removed on close/error.
    if (path === "tts" && (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
      if (!WSP) {
        return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
      }
      const pair = new WSP();
      const client = (pair as unknown as Record<string, WebSocket>)[0];
      const server = (pair as unknown as Record<string, WebSocket>)[1];
      if (this.state.acceptWebSocket) {
        this.state.acceptWebSocket(server);
      } else {
        server.accept();
      }
      try {
        (server as unknown as { binaryType?: string }).binaryType = "arraybuffer";
      } catch {
        /* binaryType not settable on some runtimes — we only SEND on this socket, so it's non-fatal */
      }
      this.ttsClients.push(server);
      const remove = (): void => {
        const i = this.ttsClients.indexOf(server);
        if (i >= 0) this.ttsClients.splice(i, 1);
      };
      server.addEventListener("close", remove);
      server.addEventListener("error", remove);
      console.log(JSON.stringify({ msg: "agent-tts-open", bound: this.core.bound?.roomId ?? null, clients: this.ttsClients.length }));
      try {
        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      } catch {
        return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      }
    }
    // The agent audio-IN WS: a NON-browser client (local CLI / on-prem / cloud) dials IN to STREAM the
    // participant's PCM — the headless "mic" that replaces the SFU egress leg. Each binary frame is fed into
    // the turn loop (onFrame / echoFrame) exactly as the echo-frame POST path does. Native hibernation-safe.
    if (path === "audio-in" && (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
      if (!WSP) {
        return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
      }
      const pair = new WSP();
      const client = (pair as unknown as Record<string, WebSocket>)[0];
      const server = (pair as unknown as Record<string, WebSocket>)[1];
      if (this.state.acceptWebSocket) {
        this.state.acceptWebSocket(server);
      } else {
        server.accept();
      }
      try {
        (server as unknown as { binaryType?: string }).binaryType = "arraybuffer";
      } catch {
        /* binaryType not settable on some runtimes — non-fatal (we only RECEIVE; the runtime handles binary) */
      }
      // Hibernation: the runtime delivers this socket's frames to webSocketMessage(), NOT addEventListener("message")
      // (which is a no-op on an acceptWebSocket'd socket). Track it so webSocketMessage can route the frames.
      this.audioInSockets.add(server);
      console.log(JSON.stringify({ msg: "agent-audio-in-open", bound: this.core.bound?.roomId ?? null }));
      try {
        return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      } catch {
        return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
      }
    }
    try {
      if (path === "bind" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { config?: AgentSessionConfig };
        if (!body.config) throw new AgentSessionError("BAD_REQUEST", "config is required", 400);
        const bound = this.core.bind(body.config);
        const baseWss = this.env.AGENT_PUBLIC_WSS ?? "wss://rt.wave.online";
        // Mint the per-endpoint capability tokens the SFU appends as ?t= on its dial-in (it can't send
        // x-wave-internal). Egress binds the participant track; ingest binds the agent track. Without these
        // the SFU handshake 401s → CF returns "create websocket adapter returned 503" (the live-spike bug).
        const secret = this.env.WAVE_INTERNAL_SECRET;
        const egressToken = secret
          ? await mintRecorderToken(secret, bound.org, bound.participantSessionId, bound.participantTrackName)
          : undefined;
        const ingestToken = secret
          ? await mintRecorderToken(secret, bound.org, bound.participantSessionId, bound.agentTrackName!)
          : undefined;
        // The TTS-playback token the CLIENT carries on its direct-playback dial (a browser can't send
        // x-wave-internal). Bound to the AGENT track (same as ingest) so the TTS route verifies it consistently.
        const ttsToken = secret
          ? await mintRecorderToken(secret, bound.org, bound.participantSessionId, bound.agentTrackName!)
          : undefined;
        const ttsEndpoint = ttsToken
          ? `${baseWss.replace(/\/+$/, "")}/v1/realtime/agents/tts/${encodeURIComponent(bound.org)}/${encodeURIComponent(bound.roomId)}/${encodeURIComponent(bound.participantSessionId)}/${encodeURIComponent(bound.agentTrackName!)}?t=${encodeURIComponent(ttsToken)}`
          : undefined;
        // The audio-IN endpoint the CLIENT dials to STREAM the participant's PCM to the agent (the headless
        // "mic" — a non-browser client replaces the SFU egress leg). Bound to the PARTICIPANT track.
        const audioInToken = secret
          ? await mintRecorderToken(secret, bound.org, bound.participantSessionId, bound.participantTrackName)
          : undefined;
        const audioInEndpoint = audioInToken
          ? `${baseWss.replace(/\/+$/, "")}/v1/realtime/agents/audio-in/${encodeURIComponent(bound.org)}/${encodeURIComponent(bound.roomId)}/${encodeURIComponent(bound.participantSessionId)}/${encodeURIComponent(bound.participantTrackName)}?t=${encodeURIComponent(audioInToken)}`
          : undefined;
        // Headless: a non-browser client (CLI / on-prem / cloud) drives the turn over the audio-in + TTS WS,
        // so the SFU adapters are SKIPPED (no real SFU session). The browser path still opens them.
        const adapters = bound.headless
          ? { egress: undefined, ingest: undefined }
          : await this.core.openAdapters({ baseWss, egressToken, ingestToken });
        await this.armTurnTaking(bound); // step 3: arm the turn core for this binding (replaces echo on frames)
        return Response.json(
          {
            ok: true,
            bound,
            egressAdapterId: adapters.egress?.adapterId,
            ingestAdapterId: adapters.ingest?.adapterId,
            // The session the agent track is published on (CF's own, returned by the ingest adapter) — a consumer
            // (the room participant / harness) pulls `agentTrackName` from HERE, not participantSessionId (#29).
            agentSessionId: adapters.ingest?.publishedSessionId ?? bound.participantSessionId,
            // The direct-playback endpoint the CLIENT dials to receive the agent's TTS PCM (bypasses the broken
            // SFU ingest). Pre-built with the capability token so the browser needs no other auth.
            ttsEndpoint,
            // The audio-IN endpoint a NON-browser client dials to STREAM the participant's PCM (headless mic).
            audioInEndpoint,
          },
          { status: 200 },
        );
      }
      if (path === "info" && request.method === "GET") {
        return Response.json({ bound: this.core.bound, timings: this.core.timingSamples(), muted: this.muted }, { status: 200 });
      }
      if (path === "mute" && request.method === "POST") {
        // voice-control-deck E1: mute = drop the egress audio (the "turn off the mic" intent). Idempotent.
        this.muted = true;
        return Response.json({ muted: true }, { status: 200 });
      }
      if (path === "unmute" && request.method === "POST") {
        // "turn on the mic": resume listening.
        this.muted = false;
        return Response.json({ muted: false }, { status: 200 });
      }
      if (path === "spectrum" && request.method === "GET") {
        // The latest FFT spectrum (the audio-signal-plane tap output) — CORS-open so the audio.wave.online
        // dashboard can poll it. Returns null when no frame has been tapped yet (no live session).
        return Response.json(this.latestSpectrum ?? { bins: null, at: 0 }, {
          status: 200,
          headers: { "access-control-allow-origin": "*" },
        });
      }
      if (path === "history" && request.method === "GET") {
        // The conversation transcript (system + alternating user/assistant). A core product surface:
        // every voice-agent session must OFFER its transcript, not just speak it. `this.turn` is null
        // until armed, so an unarmed/echo session honestly returns an empty history. Returns the SAME
        // TranscriptResult shape the R2 retention uses and the console's getTranscript expects.
        const bound = this.core.bound;
        const history = this.turn ? this.turn.history() : [];
        void this.persistTranscript(); // record on read (best-effort; the read never blocks on the write)
        return Response.json(
          {
            org: bound?.org ?? "",
            roomId: bound?.roomId ?? "",
            sessionId: bound?.participantSessionId ?? "",
            recordedAt: Date.now(),
            messages: history,
          },
          { status: 200 },
        );
      }
      if (path === "finalize" && request.method === "POST") {
        // Persist the transcript at SESSION END (the worker calls this when the room/session closes), so
        // every recorded session is retained even if its history was never explicitly read. Returns whether
        // a non-empty transcript was actually written.
        const recorded = await this.persistTranscript();
        return Response.json({ ok: true, recorded }, { status: 200 });
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

  /** Hibernation handler — the runtime calls this per inbound frame on an accepted socket. The audio-in WS
   *  is the only socket that RECEIVES (the ingest + TTS sockets are send-only), so every binary frame here is
   *  a headless-mic PCM frame. Fail-safe: a defect must never crash the socket. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (!this.audioInSockets.has(ws) || typeof message === "string") return;
    try {
      const buf = new Uint8Array(message);
      if (buf.length === 0) return;
      const r = this.turn ? this.turn.onFrame(buf) : this.core.echoFrame(buf);
      if (r && typeof (r as Promise<void>).then === "function") void (r as Promise<void>).catch(() => {});
    } catch {
      /* fail-safe — a decode/turn defect must never crash the socket */
    }
  }

  /** Hibernation handler — drop a closed audio-in socket from the tracked set. */
  webSocketClose(ws: WebSocket): void {
    this.audioInSockets.delete(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.audioInSockets.delete(ws);
  }

  /**
   * Persist the session transcript to R2 (`transcript:{org}:{room}:{session}.json`). Best-effort — a bucket
   * write never fails the caller. Returns true only when a non-empty transcript was actually written.
   */
  private persistTranscript(): Promise<boolean> {
    const bound = this.core.bound;
    const history = this.turn ? this.turn.history() : [];
    if (!this.env.RT_RECORDINGS || !bound || history.length === 0) return Promise.resolve(false);
    const key = `transcript:${bound.org}:${bound.roomId}:${bound.participantSessionId}.json`;
    return this.env.RT_RECORDINGS.put(
      key,
      JSON.stringify({
        org: bound.org,
        roomId: bound.roomId,
        sessionId: bound.participantSessionId,
        recordedAt: Date.now(),
        messages: history,
      }),
    )
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Arm the step-3 turn-taking core for a binding. INERT unless VOICE_AGENT_PROVIDER=wave. Lazily imported so
   * the skeleton's binding/migration deploy is unaffected. Wires LIVE STT/gateway-LLM/ElevenLabs deps from env
   * (creds referenced, never logged) over the same media deps the echo core uses. Fail-soft: if arming throws,
   * the DO keeps the echo fallback (media safety > agent) — never crashes the bind.
   */
  private async armTurnTaking(bound: AgentSessionConfig): Promise<void> {
    if (!voiceAgentEnabled(this.env)) return;
    try {
      const media = this.buildMediaDeps();
      const deps = buildTurnDeps(this.env, media, this.env.__agentFetch ?? fetch, bound.org, bound.agentId);
      // step 5: the DYNAMIC catalog (voice-control-deck E0) first, the hardcoded env allowlist as the fallback —
      // so a tool added on the gateway becomes voice-callable with no edge redeploy.
      const tools = (await toolCatalogFromGateway(this.env)) ?? toolAllowlistFromEnv(this.env);
      this.turn = new TurnTakingCore(deps, { ...bound, systemPrompt: this.env.VOICE_AGENT_SYSTEM_PROMPT }, {
        framing: this.env.AGENT_INGEST_FRAMING,
        vad: vadConfigFromEnv(this.env), // step 4: barge-in VAD thresholds (env-overridable, sensible defaults)
        ttsLeadMs: ttsLeadMsFromEnv(this.env), // step 4: real-time TTS pacing → interruptible playout (barge-in)
        tools, // step 5: only these tools are advertised to the model + executable (others refused)
        cogsRates: voiceCogsRatesFromEnv(this.env), // E0-P2: vendor COGS rates (absent ⇒ reported unpriced)
        echoMuteMs: parseInt(this.env.AGENT_ECHO_MUTE_MS ?? "400", 10), // echo-mute grace after a turn
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
      // The egress subscribe races the client's publish: the "mic" track may not be registered on the SFU
      // session yet when the bind fires, so createWebsocketAdapter would return not_found_track_error on its
      // single attempt and 502 the whole bind. Retry on that signal (trackNotReady) until the track appears —
      // the adapter's own retry path, only armed here (default maxAttempts=1 = no retry).
      createEgress: (tracks) => createWebsocketAdapter({ fetchImpl, retry: { maxAttempts: 12, delayMs: (a) => Math.min(500 * a, 2000) } }, { appId, bearer, tracks }),
      createIngest: (tracks) => createIngestAdapter({ fetchImpl }, { appId, bearer, tracks }),
      ingestSocket: () => this.broadcastSink(),
      now: () => Date.now(),
      delay: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
    };
  }

  /**
   * The publish sink speak() sends the agent's TTS PCM through: fans out to the SFU ingest socket (if the SFU
   * ever connects) AND to every connected direct-playback client socket (the TTS route). Reads the current socket
   * set at SEND time so a client that connects mid-turn is picked up. Returns null only when NO sink exists
   * (nothing to play to) — the speak() no-ingest observability then still fires correctly.
   */
  private broadcastSink(): IngestSocket | null {
    if (!this.ingest && this.ttsClients.length === 0) return null;
    const self = this;
    return {
      send: (d) => {
        const ing = self.ingest;
        if (ing) {
          try {
            ing.send(d);
          } catch {
            /* media safety — a dead SFU socket is cleared on its close event */
          }
        }
        for (const c of self.ttsClients) {
          try {
            c.send(d);
          } catch {
            /* a dead client socket is removed on its close event */
          }
        }
      },
      close: () => {
        try {
          self.ingest?.close?.();
        } catch {
          /* best-effort */
        }
      },
    };
  }
}
