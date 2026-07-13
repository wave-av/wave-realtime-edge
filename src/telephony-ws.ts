/// <reference types="@cloudflare/workers-types" />
/**
 * #76 — Twilio Media-Stream ↔ WAVE room WebSocket GLUE (the bridge that consumes the two proven
 * primitives: telephony-codec.ts transcode + twilio-mediastream.ts parse/build).
 *
 * When Twilio's `<Connect><Stream url="wss://rt.wave.online/?room=<id>">` bridges a PSTN call, Twilio
 * opens a WebSocket and streams base64 G.711 μ-law (8 kHz mono) JSON frames. This module accepts that
 * socket and drives a pure state machine that:
 *   • INBOUND  (caller → room): parseTwilioFrame → twilioMuLawToSfuPcm (→48k stereo PCM) → the CF Realtime
 *     ingest-publish path — createIngestAdapter(location:"local") tells the SFU to PUBLISH a new room track
 *     sourced from the encodeIngestFrame PCM we send on the SFU-dialed ingest socket. This is the SAME
 *     inject mechanism AgentSessionDO + RtmsBridgeCore already use; this bridge is its telephony sibling.
 *   • OUTBOUND (room → caller): room 48k-stereo PCM → sfuPcmToTwilioMuLaw → twilioMediaFrame → sent back
 *     over the same Twilio WebSocket.
 *
 * ── INERT: FULLY GATED behind WAVE_TELEPHONY_STREAM ([vars], default OFF) ─────────────────────────────
 * When the flag is falsy/absent, maybeHandleTelephonyStream returns null and the request falls through to
 * the 501 catch-all — the route is NOT registered and NOTHING changes. Arming it in any live env is a ◆.
 *
 * ── WHAT IS VERIFIED vs WHAT THE LIVE SPIKE MUST CONFIRM ──────────────────────────────────────────────
 * VERIFIED here (unit tests): the full parse → decode → ingest-frame inbound transcode and the room-PCM →
 * μ-law → twilioMediaFrame outbound transcode, byte-for-byte against the two pinned primitives.
 * UNVERIFIED (the ◆ live spike, a real inbound phone call): (1) the ingest SEND-side framing — "packet" vs
 * "raw" — is inherited from agent-ingest-adapter.ts and is NOT yet proven against a live RoomDO inject
 * (marked at the exact call site below); and (2) resolving the room's SFU session + minting the ingest
 * endpoint (so the SFU actually dials our ingest socket) is DO-held live wiring the spike lands. Until
 * then the target is null → the bridge accepts the call and transcodes, but drops frames at the inject
 * seam (exactly RtmsBridgeCore's "drop until the SFU connects" contract) — inert, never a fabricated push.
 *
 * No crypto/room state here: transcode from telephony-codec.ts, parse/build from twilio-mediastream.ts,
 * the ingest wire from agent-ingest-adapter.ts. The socket I/O is an injected seam → pure + unit-testable.
 */
import {
  parseTwilioFrame,
  twilioMediaFrame,
  TwilioProtocolError,
  type TwilioInboundEvent,
} from "./twilio-mediastream.js";
import { twilioMuLawToSfuPcm, sfuPcmToTwilioMuLaw } from "./telephony-codec.js";
import { int16ToPcmS16Le } from "./rtms-audio.js";
import {
  chunkPcm,
  encodeIngestFrame,
  type IngestAdapterTrack,
  type IngestFraming,
  type CreateIngestAdapterResult,
} from "./agent-ingest-adapter.js";
import type { IngestSocket } from "./agent-session.js";
import { SAFE_SEGMENT, telephonyStreamEnabled, type Env } from "./dispatch-helpers.js";

/** The resolved SFU publish target for one bridged call (room session + creds + ingest endpoint). Null
 *  until the live spike wires room→session resolution + endpoint minting (see module header, gap 2). */
export interface TelephonyTarget {
  /** CF Realtime SFU app id (createIngestAdapter). */
  appId: string;
  /** CF Realtime SFU app bearer — never logged/returned. */
  bearer: string;
  /** The SFU session (in the target wave room) the new telephony track is published against. */
  sessionId: string;
  /** The track name the caller's audio is published as (e.g. `tel-${streamSid}`). */
  trackName: string;
  /** wss:// our ingest route the SFU dials to pull our PCM (bound to org/session/track). */
  endpoint: string;
}

/** Injected I/O seam — keeps TelephonyBridgeCore pure + unit-testable (no live Twilio/SFU needed). */
export interface TelephonyBridgeDeps {
  /** Create the CF Realtime INGEST adapter so the SFU publishes a room track from the PCM we send. */
  createIngest(tracks: IngestAdapterTrack[]): Promise<CreateIngestAdapterResult>;
  /** The DO-held socket the SFU dialed IN on to pull our PCM (null until it connects → frames drop). */
  ingestSocket(): IngestSocket | null;
  /** Send one text frame back to Twilio over the caller's Media-Stream WebSocket. */
  twilioSend(text: string): void;
  /** Wall clock (ms) — injectable so any timing instrumentation is deterministic in tests. */
  now(): number;
  /** Structured log sink (JSON line) — injectable so tests can assert emitted instrumentation. */
  log(msg: string, fields: Record<string, unknown>): void;
}

/** Per-bridge config: the resolved publish target (or null until the spike resolves it) + framing. */
export interface TelephonyBridgeConfig {
  /** The wave-room publish target; null → transcode runs but nothing is published (inert, drops frames). */
  target: TelephonyTarget | null;
  /** Ingest send-side framing; "packet" (default, modeled) | "raw" (a live spike may select). */
  framing?: IngestFraming;
}

/**
 * TelephonyBridgeCore — the pure state machine for one Twilio call ↔ one wave-room track. `onTwilioFrame`
 * advances it: `start` opens the ingest adapter (when a target is resolved) and captures the streamSid;
 * each `media` frame transcodes μ-law → 48k-stereo PCM and pushes it as ingest frames. Every media op is
 * fail-safe: a transcode/parse/send error is logged, never thrown up the socket path (media safety > one
 * dropped frame). `pushRoomAudio` is the symmetric OUTBOUND seam (room PCM → μ-law back to the caller).
 */
export class TelephonyBridgeCore {
  private streamSid: string | null = null;
  private outSeq = 0;
  private started = false;
  private closed = false;
  private readonly framing: IngestFraming;

  constructor(
    private readonly deps: TelephonyBridgeDeps,
    private readonly config: TelephonyBridgeConfig,
  ) {
    // DEFAULT "packet" — symmetric with the verified egress decoder; a live spike may flip to "raw"
    // (agent-ingest-adapter.ts §Send-side framing). Mirrors RtmsBridgeCore / AgentSessionDO.
    this.framing = config.framing ?? "packet";
  }

  get isStarted(): boolean {
    return this.started;
  }

  get currentStreamSid(): string | null {
    return this.streamSid;
  }

  /**
   * Drive one inbound Twilio Media-Stream text frame. Parse errors are swallowed (logged) — a malformed
   * frame never throws up the socket path. Unknown/handled event kinds are logged and ignored.
   */
  async onTwilioFrame(text: string): Promise<void> {
    let evt: TwilioInboundEvent;
    try {
      evt = parseTwilioFrame(text);
    } catch (e) {
      if (e instanceof TwilioProtocolError) this.deps.log("telephony-parse-error", { message: e.message });
      return;
    }
    switch (evt.event) {
      case "connected":
        this.deps.log("telephony-connected", { protocol: evt.protocol, version: evt.version });
        break;
      case "start":
        await this.onStart(evt.streamSid, evt.callSid);
        break;
      case "media":
        this.onMedia(evt.payload);
        break;
      case "dtmf":
        this.deps.log("telephony-dtmf", { streamSid: evt.streamSid, digit: evt.digit });
        break;
      case "mark":
        this.deps.log("telephony-mark", { streamSid: evt.streamSid, name: evt.name });
        break;
      case "stop":
        this.deps.log("telephony-stop", { streamSid: evt.streamSid });
        this.close();
        break;
      default:
        break;
    }
  }

  /** Twilio `start`: capture the streamSid and, when a target is resolved, tell the SFU to publish a new
   *  room track sourced from the PCM we will send. Idempotent — a second start is a no-op. */
  private async onStart(streamSid: string, callSid: string): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.streamSid = streamSid;
    const t = this.config.target;
    if (!t) {
      // No resolved SFU target yet (the live-spike wires room→session resolution + endpoint minting).
      // Honest INERT: we accept + transcode the call, but publish nothing. NOT a silent drop of a
      // resolvable target — there is none to publish to here.
      this.deps.log("telephony-target-pending", { streamSid, callSid });
      return;
    }
    // Tell the SFU to publish a NEW room track sourced from the PCM we send on t.endpoint. mode:"buffer"
    // is REQUIRED for the SFU to actually establish the pull (agent-ingest-adapter.ts §mode).
    const tracks: IngestAdapterTrack[] = [
      { location: "local", sessionId: t.sessionId, trackName: t.trackName, endpoint: t.endpoint, inputCodec: "pcm", mode: "buffer" },
    ];
    try {
      await this.deps.createIngest(tracks);
      this.deps.log("telephony-ingest-open", { streamSid, callSid, session: t.sessionId, track: t.trackName });
    } catch (e) {
      this.deps.log("telephony-ingest-error", { streamSid, message: (e as Error)?.message ?? "unknown" });
    }
  }

  /**
   * One inbound Twilio media frame (base64-decoded μ-law 8k mono) → 48k-stereo PCM → ≤32KB ingest frames
   * on the SFU-dialed ingest socket. Dropped (not buffered) until the SFU has dialed in — Twilio re-sends
   * continuous audio. Fail-safe: a transcode/send error is logged and swallowed.
   */
  private onMedia(muLaw: Uint8Array): void {
    const sock = this.deps.ingestSocket();
    if (!sock) return; // SFU ingest not connected yet → drop (see module header, live-spike gap 2)
    try {
      const bytes = int16ToPcmS16Le(twilioMuLawToSfuPcm(muLaw));
      for (const chunk of chunkPcm(bytes)) {
        // TODO(live-spike): confirm Packet-wrap vs raw framing against a live RoomDO inject. `this.framing`
        // defaults to "packet" — the symmetric-with-the-verified-egress-decoder default every local-inject
        // caller uses (agent-ingest-adapter.ts §Send-side framing; followed here from rtms-bridge-core.ts).
        // The live two-way phone-call spike may flip it to "raw"; that flip is one config line, not a rewrite.
        // Twilio media carries no adapter timestamp; 0 mirrors the other ingest producers (rtms-bridge-core.ts).
        sock.send(encodeIngestFrame(chunk, { sequenceNumber: this.outSeq++, timestamp: 0 }, this.framing));
      }
    } catch (e) {
      this.deps.log("telephony-media-error", { message: (e as Error)?.message ?? "unknown" });
    }
  }

  /**
   * OUTBOUND: one chunk of room audio (48k-stereo Int16 PCM) → μ-law 8k mono → a Twilio `media` frame sent
   * back over the caller's WebSocket. No-op before `start` (no streamSid to address). Fail-safe like onMedia.
   */
  pushRoomAudio(pcm48kStereo: Int16Array): void {
    if (!this.streamSid || this.closed) return;
    try {
      const muLaw = sfuPcmToTwilioMuLaw(pcm48kStereo);
      this.deps.twilioSend(twilioMediaFrame(this.streamSid, muLaw));
    } catch (e) {
      this.deps.log("telephony-outbound-error", { message: (e as Error)?.message ?? "unknown" });
    }
  }

  /** Best-effort, idempotent teardown. The ingest socket is owned by the DO, not closed here. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.log("telephony-close", { streamSid: this.streamSid ?? "" });
  }
}

/**
 * Route handler for the Twilio Media-Stream inbound socket: `wss://rt.wave.online/?room=<id>`. Returns a
 * Response when it OWNS the request, or null to let the caller fall through (INERT when the flag is off, or
 * when the path/method is not ours). FULLY GATED: when WAVE_TELEPHONY_STREAM is falsy/absent this returns
 * null immediately and nothing is registered.
 *
 * Twilio dials in directly and cannot send the x-wave-internal seal, so this route is NOT behind
 * gatewayGate; the room is a query param and the caller identity/authorization (a signed stream token)
 * is part of the live-spike wiring — until armed, the flag itself is the only gate and it is OFF.
 */
export async function maybeHandleTelephonyStream(
  request: Request,
  env: Env,
  _ctx: ExecutionContext | undefined,
): Promise<Response | null> {
  if (!telephonyStreamEnabled(env)) return null; // INERT — not registered; falls through to the 501 catch-all
  const url = new URL(request.url);
  if (url.pathname !== "/") return null; // only the root Media-Stream socket is ours
  const room = url.searchParams.get("room") ?? "";
  if (!room) return null; // no ?room → not a telephony stream; let the caller fall through
  if (!SAFE_SEGMENT.test(room)) {
    return Response.json({ error: "BAD_REQUEST", message: "invalid room" }, { status: 400 });
  }
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return Response.json(
      { error: "UPGRADE_REQUIRED", message: "telephony route requires a WebSocket upgrade" },
      { status: 426 },
    );
  }
  // WebSocketPair is a Workers-runtime global; referenced off globalThis so unit tests can stub it.
  const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
  if (!WSP) {
    return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
  }
  const pair = new WSP();
  const client = (pair as unknown as Record<string, WebSocket>)[0];
  const server = (pair as unknown as Record<string, WebSocket>)[1];
  server.accept();

  const core = new TelephonyBridgeCore(
    {
      // TODO(live-spike): resolve the room's SFU session + mint the ingest endpoint so createIngest can
      // publish a real track and the SFU dials our ingest socket. Until then target is null → the bridge
      // transcodes but publishes nothing (drops at the inject seam), and ingestSocket() is null.
      createIngest: (tracks) =>
        createIngestAdapterForRoom(env, tracks),
      ingestSocket: () => null,
      twilioSend: (text) => {
        try {
          server.send(text);
        } catch {
          /* socket may have closed — outbound is best-effort */
        }
      },
      now: () => Date.now(),
      log: (msg, fields) => console.log(JSON.stringify({ msg, room, ...fields })),
    },
    { target: null },
  );

  server.addEventListener("message", (ev: MessageEvent) => {
    // Twilio Media-Stream frames are JSON TEXT; ignore any binary (Twilio does not send binary frames).
    if (typeof ev.data !== "string") return;
    void core.onTwilioFrame(ev.data);
  });
  server.addEventListener("close", () => core.close());

  // Workers accepts a 101 + webSocket ResponseInit (the WS-upgrade idiom). Some non-Workers runtimes
  // (e.g. the Node test env) reject status 101 in the Response ctor — guard so the handler never throws.
  try {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  } catch {
    return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }
}

/**
 * Live createIngest wiring: create a CF Realtime INGEST adapter for the given tracks using the SFU app
 * creds from env. Kept as a thin seam so the route body stays declarative and the core stays pure.
 *
 * TODO(live-spike): the tracks passed here today are always empty (target is null until the spike resolves
 * the room→session + endpoint). This proves the wiring compiles + is reachable; the real payload lands
 * with the two-way phone-call spike.
 */
async function createIngestAdapterForRoom(
  env: Env,
  tracks: IngestAdapterTrack[],
): Promise<CreateIngestAdapterResult> {
  const { createIngestAdapter } = await import("./agent-ingest-adapter.js");
  const e = env as unknown as { CF_CALLS_APP_ID?: string; CF_CALLS_APP_SECRET?: string };
  return createIngestAdapter(
    { fetchImpl: (input, init) => fetch(input, init) },
    { appId: e.CF_CALLS_APP_ID ?? "", bearer: e.CF_CALLS_APP_SECRET ?? "", tracks },
  );
}
