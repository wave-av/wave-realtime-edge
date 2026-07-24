/// <reference types="@cloudflare/workers-types" />
/**
 * #88 M2 — Zoom RTMS → WAVE room MEDIA bridge, pure core (the outbound half).
 *
 * The control plane (webhook verify + ack) lives in zoom-rtms-bridge.ts and hands a
 * verified `rtms_started` to a seam. THIS module is the media half that seam drives: a
 * pure, I/O-free state machine that dials Zoom's RTMS native-WebSocket legs, answers the
 * handshakes + keepalives, and pumps each MEDIA_DATA_AUDIO frame through `rtmsAudioToSfuPcm`
 * into the SAME CF Realtime ingest-publish path AgentSessionDO already proves (createIngest
 * adapter → the SFU dials our ingest WS → we send `encodeIngestFrame` PCM → a new room track).
 *
 * ── TWO ZOOM LEGS (rtms-protocol.ts header) ────────────────────────────────────────────────
 *   serverUrls → SIGNALING socket: send SIGNALING_HAND_SHAKE_REQ(1, signature); recv
 *     SIGNALING_HAND_SHAKE_RESP(2) carrying the media-server URLs.
 *   media url  → MEDIA socket: send DATA_HAND_SHAKE_REQ(3, AUDIO); recv DATA_HAND_SHAKE_RESP(4),
 *     then MEDIA_DATA_AUDIO(14) frames (PCM s16le/16k/mono). Answer KEEP_ALIVE_REQ(12) on BOTH
 *     legs with KEEP_ALIVE_RESP(13) to hold the stream.
 *
 * ── WHAT IS VERIFIED vs WHAT THE LIVE MEETING MUST CONFIRM ──────────────────────────────────
 *   VERIFIED here (unit tests, mock sockets): the full control sequence — signature, handshake
 *   ordering, keepalive echo on both legs, and that one audio frame transcodes to the exact
 *   48k-stereo PCM `encodeIngestFrame` wire bytes on the ingest socket. The protocol/audio/auth
 *   primitives it calls are each independently vector-pinned (#145).
 *   UNVERIFIED until a live Zoom meeting (the ◆ crossing): that Zoom's real servers accept our
 *   handshake and that the SFU actually pulls our ingest endpoint — the same class of live-spike
 *   gap AgentSessionDO documents. The outbound dial + the SFU ingest connect are INJECTED seams,
 *   so this core is fully testable now with zero live exposure.
 *
 * No crypto/network/room state here: signatures come from rtms-auth.ts, framing/parse from
 * rtms-protocol.ts, transcode from rtms-audio.ts, the ingest wire from agent-ingest-adapter.ts.
 */
import {
  RTMS_MEDIA_TYPE,
  signalingHandshakeReq,
  dataHandshakeReq,
  keepAliveResp,
  parseRtmsMessage,
  RtmsProtocolError,
} from "./rtms-protocol.js";
import { rtmsHandshakeSignature } from "./rtms-auth.js";
import { rtmsAudioToSfuPcm, int16ToPcmS16Le } from "./rtms-audio.js";
import { rtmsVideoToSfuJpeg } from "./rtms-video.js";
import {
  encodeIngestFrame,
  chunkPcm,
  type IngestAdapterTrack,
  type IngestFraming,
  type CreateIngestAdapterResult,
} from "./agent-ingest-adapter.js";
import type { IngestSocket } from "./agent-session.js";
import type { RtmsStartedEvent } from "./zoom-rtms-bridge.js";

/** A minimal duplex text socket to one Zoom RTMS leg. The live DO wraps a real accepted
 *  WebSocket; tests pass a fake whose pushed frames drive the state machine. */
export interface RtmsSocket {
  send(data: string): void;
  close(): void;
}

/**
 * Dial ONE Zoom RTMS leg. `onMessage` receives each inbound text frame; `onClose` fires when the
 * leg drops. Returns the send/close handle. The live DO implements this as
 * `fetch(url,{headers:{Upgrade:"websocket"}})` → `resp.webSocket.accept()`; tests inject a fake.
 */
export type RtmsConnect = (
  url: string,
  onMessage: (text: string) => void | Promise<void>,
  onClose?: () => void,
) => Promise<RtmsSocket>;

/** Injected media seam — keeps RtmsBridgeCore pure + unit-testable (no live Zoom/SFU needed). */
export interface RtmsBridgeDeps {
  /** Dial an outbound Zoom RTMS WebSocket leg (signaling, then media). */
  connect: RtmsConnect;
  /** Create the CF Realtime INGEST adapter so the SFU publishes a room track from the PCM we send. */
  createIngest(tracks: IngestAdapterTrack[]): Promise<CreateIngestAdapterResult>;
  /** The DO-held socket the SFU dialed IN on to pull our PCM (null until it connects → frames drop). */
  ingestSocket(): IngestSocket | null;
  /** #88 WAVE_RTMS_VIDEO — the DO-held socket the SFU dialed IN on to pull our video JPEG stills (null
   *  until it connects → frames drop). Optional: only meaningful when config.videoEnabled is true; the
   *  live DO does not yet wire a real video-ingest-sink socket (◆ follow-up slice), so this stays
   *  undefined in production today and pumpVideo drops every frame — inert, never a fabricated push. */
  videoIngestSocket?(): IngestSocket | null;
  /** #RTMS-fanout WAVE_RTMS_PER_PARTICIPANT — resolve the fan-out sinks for one participant (a sanitized
   *  userId, or null for the mixed/unknown-speaker bucket). Only consulted when config.perParticipantEnabled
   *  is true AND a valid userId was parsed off the frame; called lazily, once per newly-seen participant
   *  (the result is cached — see the per-participant map in pumpAudio/pumpVideo). The live DO's
   *  implementation is responsible for minting/caching the per-participant CF-SFU track (named
   *  `zoom-${meetingUuid}-${userId}`) and wrapping it as a ParticipantSink; that wiring is a ◆ follow-up
   *  slice and is NOT provided by this spike — optional/absent so existing call sites stay byte-identical. */
  sinks?(userId: string | null): ParticipantSink[];
  /** Wall clock (ms) — injectable so any timing instrumentation is deterministic in tests. */
  now(): number;
  /** Structured log sink (JSON line) — injectable so tests can assert emitted instrumentation. */
  log(msg: string, fields: Record<string, unknown>): void;
}

/**
 * #RTMS-fanout — one fan-out destination for a single participant's demuxed media. The existing CF-SFU
 * ingest-socket path becomes ONE implementation of this interface (see the DO's `sinks()` wiring); NDI
 * and MoQ are additional (currently INERT-stub) implementations. `video` is optional — an audio-only sink
 * (e.g. a future transcription tee) never needs it. Fail-safe by contract: RtmsBridgeCore swallows/logs
 * any throw from a sink call so one bad sink never drops frames for the others.
 */
export interface ParticipantSink {
  audio(frame: Uint8Array): void;
  video?(frame: Uint8Array): void;
  close(): void;
}

/** #314 Slice 1 — the multiplexed per-meeting transport MoqTrackSink writes through, injected by the DO layer
 *  (encoders/moq-forward-target.ts's MoqForwardTarget implements this) so THIS core file never imports a CF
 *  container API directly. Defined here (not there) so MoqTrackSink's constructor type doesn't pull in
 *  `@cloudflare/containers` at all. */
export type MoqFrameKind = "audio" | "video";
export interface MoqForwardWriter {
  writeFrame(uid: string, kind: MoqFrameKind, ts: number, payload: Uint8Array): void;
  close(): void;
}

/**
 * ◆ follow-up slice: real impl crosses into wave-moq-edge (a separate container/service) — publishing a
 * MoQ track is out of scope for this Worker. WITHOUT an injected `writer` this stays the INERT forwarder
 * stub it always was: logs one structured line per call and does nothing else — no socket, no buffering,
 * no network; byte-identical to before #314. A caller (the DO's `sinks()`, per #314 Slice 1) opts in by
 * injecting a `MoqForwardWriter` (the DO constructs one ONLY when WAVE_RTMS_PER_PARTICIPANT is on AND its
 * MOQ_PUBLISH container binding exists — see zoom-rtms-bridge-do.ts) — every audio()/video() call is then
 * forwarded through it instead of logged. Fail-safe either way: a throwing writer is caught + logged, never
 * thrown up into pumpAudio/pumpVideo's fan-out loop.
 */
export class MoqTrackSink implements ParticipantSink {
  constructor(
    private readonly log: (msg: string, fields: Record<string, unknown>) => void,
    private readonly userId: string,
    private readonly writer?: MoqForwardWriter,
    private readonly now: () => number = () => Date.now(),
  ) {}
  audio(frame: Uint8Array): void {
    if (this.writer) {
      this.forward("audio", frame);
      return;
    }
    this.log("rtms-bridge-moq-sink-stub", { userId: this.userId, kind: "audio", bytes: frame.byteLength });
  }
  video(frame: Uint8Array): void {
    if (this.writer) {
      this.forward("video", frame);
      return;
    }
    this.log("rtms-bridge-moq-sink-stub", { userId: this.userId, kind: "video", bytes: frame.byteLength });
  }
  private forward(kind: MoqFrameKind, frame: Uint8Array): void {
    try {
      this.writer!.writeFrame(this.userId, kind, this.now(), frame);
    } catch (e) {
      this.log("rtms-bridge-moq-sink-error", { userId: this.userId, kind, message: (e as Error)?.message ?? "unknown" });
    }
  }
  close(): void {
    if (!this.writer) return; // inert stub — no socket to close (byte-identical to before #314)
    try {
      this.writer.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * ◆ follow-up slice: real impl crosses into wave-bridge-edge (a separate container running Zoom's native
 * NDI-HX SDK) — NDI is NEVER emitted from this Worker (no such SDK/runtime here). This is an INERT
 * forwarder stub only: logs one structured line per call, no-ops otherwise. Never constructed by default.
 */
export class NdiHxForwardSink implements ParticipantSink {
  constructor(
    private readonly log: (msg: string, fields: Record<string, unknown>) => void,
    private readonly userId: string,
  ) {}
  audio(frame: Uint8Array): void {
    this.log("rtms-bridge-ndi-sink-stub", { userId: this.userId, kind: "audio", bytes: frame.byteLength });
  }
  close(): void {
    /* inert — no socket to close */
  }
}

/** #RTMS-fanout — allowlist for a Zoom RTMS userId before it's used as a track-name/map-key segment
 *  (Corridor guardrail: never let an untrusted upstream value drive a resource name unsanitized). */
const SAFE_RTMS_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** #RTMS-fanout — cap on distinct per-participant tracks/maps per meeting, so a spoofed/rotating stream
 *  of userIds can't grow this Worker's per-DO memory unbounded (a cheap DoS otherwise). Overflow participants
 *  are routed to the mixed track (never dropped silently, never an unbounded map). */
export const MAX_RTMS_PARTICIPANTS = 50;

/** Sanitize a raw RTMS `content.user_id` for use as a track-name/map-key segment. Anything not matching
 *  the allowlist (including absent) → null, so the caller falls back to the mixed track — never throws,
 *  never lets an unsanitized value reach a track name. */
function sanitizeRtmsUserId(userId: number | string | undefined): string | null {
  if (userId === undefined || userId === null) return null;
  const s = String(userId);
  return SAFE_RTMS_USER_ID.test(s) ? s : null;
}

/** Where the tapped Zoom audio is published: a session in the target wave room + the SFU creds. */
export interface BridgeTarget {
  /** CF Realtime SFU app id (createIngestAdapter). */
  appId: string;
  /** CF Realtime SFU app bearer — never logged/returned. */
  bearer: string;
  /** The SFU session (in the target wave room) the new Zoom track is published against. */
  sessionId: string;
  /** The track name the Zoom audio is published as (e.g. `zoom-${meetingUuid}`). */
  trackName: string;
  /** wss:// our ingest route the SFU dials to pull our PCM (bound to org/session/track). */
  endpoint: string;
  /** #88 WAVE_RTMS_VIDEO — the video-track name (e.g. `zoom-${meetingUuid}-video`). Only used when the
   *  flag is on AND both video fields are set; absent → no video track is requested (inert). */
  videoTrackName?: string;
  /** #88 WAVE_RTMS_VIDEO — wss:// ingest route the SFU dials to pull our JPEG stills. Same gating as
   *  videoTrackName. The live DO does not mint this yet (◆ follow-up slice); a caller (or a test) that
   *  sets it is opting into the video track-push path. */
  videoEndpoint?: string;
}

/** Per-bridge config: the Zoom app creds that sign the handshake + the publish target. */
export interface RtmsBridgeConfig {
  /** ZOOM_APPS_CLIENT_ID — the General-app Client ID (the RTMS handshake `clientId`). */
  clientId: string;
  /** ZOOM_APPS_CLIENT_SECRET — signs the handshake; never logged. */
  clientSecret: string;
  /** The wave-room publish target (resolved from the meeting→room mapping by the DO). */
  target: BridgeTarget;
  /** Ingest send-side framing; "packet" (default, modeled) | "raw" (a live spike may select). */
  framing?: IngestFraming;
  /** #88 WAVE_RTMS_VIDEO — default OFF/false. On: the media handshake also subscribes to VIDEO and
   *  inbound MEDIA_DATA_VIDEO frames are mapped + pushed (see pumpVideo). Off (the default): identical
   *  to the audio-only bridge — no video subscription, no video track, no video code path entered. */
  videoEnabled?: boolean;
  /** #RTMS-fanout WAVE_RTMS_PER_PARTICIPANT — default OFF/false. On: a frame carrying a valid userId is
   *  demuxed to a per-participant seq + `deps.sinks(userId)` fan-out instead of the single mixed track.
   *  Off (the default), or the userId is absent/invalid/over the MAX_RTMS_PARTICIPANTS cap: byte-identical
   *  to today — one mixed track, one outSeq/outVideoSeq counter, deps.ingestSocket()/videoIngestSocket(). */
  perParticipantEnabled?: boolean;
}

/**
 * Choose the media-server URL from a SIGNALING_HAND_SHAKE_RESP's server-URL map. Zoom keys these
 * by media kind (e.g. `audio`, `all`); prefer the audio leg, then a combined `all`, then any URL.
 */
export function pickMediaUrl(urls: Record<string, string>): string | null {
  return urls["audio"] ?? urls["all"] ?? Object.values(urls).find((u) => typeof u === "string") ?? null;
}

/**
 * RtmsBridgeCore — the pure state machine for one Zoom meeting's audio → one wave-room track.
 * `start()` opens the ingest adapter + dials the signaling leg; inbound frames advance it through
 * media handshake → keepalive → audio pump. Every media op is fail-safe: a transcode/send error is
 * logged, never thrown up the socket path (media safety > one dropped frame).
 */
export class RtmsBridgeCore {
  private sig: RtmsSocket | null = null;
  private media: RtmsSocket | null = null;
  private signature = "";
  private outSeq = 0;
  private outVideoSeq = 0; // #88 WAVE_RTMS_VIDEO — independent sequence counter, separate socket/track
  private started = false;
  private closed = false;
  private readonly framing: IngestFraming;
  private readonly videoEnabled: boolean;
  private readonly perParticipantEnabled: boolean; // #RTMS-fanout WAVE_RTMS_PER_PARTICIPANT
  private meetingUuid = ""; // set in start() — only used to log/derive per-participant track names
  // #RTMS-fanout — per-userId demux state, populated lazily on first valid frame from that participant.
  // Each entry owns its OWN seq/videoSeq (independent of outSeq/outVideoSeq, which stay mixed-track-only)
  // and the resolved sink fan-out (deps.sinks(userId), called once and cached here).
  private readonly participants = new Map<string, { seq: number; videoSeq: number; sinks: ParticipantSink[] }>();

  constructor(
    private readonly deps: RtmsBridgeDeps,
    private readonly config: RtmsBridgeConfig,
  ) {
    // DEFAULT "packet" — symmetric with the verified egress decoder; a live spike may flip to "raw".
    this.framing = config.framing ?? "packet";
    // DEFAULT false — WAVE_RTMS_VIDEO off is byte-identical to the pre-video audio-only bridge.
    this.videoEnabled = config.videoEnabled ?? false;
    // DEFAULT false — WAVE_RTMS_PER_PARTICIPANT off is byte-identical to today's single-mixed-track bridge.
    this.perParticipantEnabled = config.perParticipantEnabled ?? false;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Begin bridging: create the SFU ingest adapter (so the SFU dials our endpoint), compute the
   * handshake signature, and dial + handshake the Zoom signaling leg. Idempotent — a second call
   * for an already-started bridge is a no-op. The media leg is opened on the signaling ack.
   */
  async start(event: RtmsStartedEvent): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.meetingUuid = event.meetingUuid;
    const t = this.config.target;
    // Tell the SFU to publish a NEW room track sourced from the PCM we send on t.endpoint. mode:"buffer"
    // is REQUIRED for the SFU to actually establish the pull (agent-ingest-adapter.ts §mode).
    const tracks: IngestAdapterTrack[] = [
      { location: "local", sessionId: t.sessionId, trackName: t.trackName, endpoint: t.endpoint, inputCodec: "pcm", mode: "buffer" },
    ];
    // #88 WAVE_RTMS_VIDEO — only requests a second (video) track when armed AND the target actually
    // carries video fields (the live DO does not mint these yet — see BridgeTarget doc). Off/unset →
    // this block never runs, so createIngest's payload is byte-identical to the audio-only bridge.
    if (this.videoEnabled && t.videoTrackName && t.videoEndpoint) {
      tracks.push({ location: "local", sessionId: t.sessionId, trackName: t.videoTrackName, endpoint: t.videoEndpoint, inputCodec: "jpeg", mode: "buffer" });
    }
    await this.deps.createIngest(tracks);
    this.signature = await rtmsHandshakeSignature(
      this.config.clientId,
      event.meetingUuid,
      event.rtmsStreamId,
      this.config.clientSecret,
    );
    this.sig = await this.deps.connect(
      event.serverUrls,
      (text) => this.onSignaling(event, text),
      () => this.onLegClose("signaling"),
    );
    this.sig.send(signalingHandshakeReq(event.meetingUuid, event.rtmsStreamId, this.signature));
    this.deps.log("rtms-bridge-signaling-open", { meetingUuid: event.meetingUuid, room: t.sessionId, track: t.trackName });
  }

  /** Inbound signaling-leg frame: on the ack open the media leg; answer keepalives. */
  private async onSignaling(event: RtmsStartedEvent, text: string): Promise<void> {
    const msg = this.parse(text);
    if (!msg) return;
    if (msg.kind === "signaling_ack") {
      if (msg.statusCode !== 0) {
        this.deps.log("rtms-bridge-signaling-nack", { meetingUuid: event.meetingUuid, statusCode: msg.statusCode });
        return;
      }
      const mediaUrl = pickMediaUrl(msg.mediaServerUrls);
      if (!mediaUrl) {
        this.deps.log("rtms-bridge-no-media-url", { meetingUuid: event.meetingUuid });
        return;
      }
      this.media = await this.deps.connect(
        mediaUrl,
        (t) => this.onMedia(event, t),
        () => this.onLegClose("media"),
      );
      // #88 WAVE_RTMS_VIDEO — off (default): AUDIO only, byte-identical to the pre-video bitmask. On:
      // also subscribes to VIDEO so Zoom starts sending MEDIA_DATA_VIDEO(15) frames on this leg.
      const mediaType = this.videoEnabled ? RTMS_MEDIA_TYPE.AUDIO | RTMS_MEDIA_TYPE.VIDEO : RTMS_MEDIA_TYPE.AUDIO;
      this.media.send(dataHandshakeReq(event.meetingUuid, event.rtmsStreamId, this.signature, mediaType));
      this.deps.log("rtms-bridge-media-open", { meetingUuid: event.meetingUuid });
    } else if (msg.kind === "keepalive_req") {
      this.sig?.send(keepAliveResp(msg.timestamp));
    }
  }

  /** Inbound media-leg frame: pump audio to the ingest socket; answer keepalives; log a nack. */
  private onMedia(event: RtmsStartedEvent, text: string): void {
    const msg = this.parse(text);
    if (!msg) return;
    switch (msg.kind) {
      case "audio":
        this.pumpAudio(msg.payload, msg.userId);
        break;
      case "video":
        this.pumpVideo(msg.payload, msg.userId);
        break;
      case "keepalive_req":
        this.media?.send(keepAliveResp(msg.timestamp));
        break;
      case "data_ack":
        if (msg.statusCode !== 0) {
          this.deps.log("rtms-bridge-data-nack", { meetingUuid: event.meetingUuid, statusCode: msg.statusCode });
        }
        break;
      default:
        break;
    }
  }

  /**
   * One RTMS audio frame (PCM s16le 16k mono) → 48k-stereo PCM → ≤32KB ingest frames. #RTMS-fanout
   * WAVE_RTMS_PER_PARTICIPANT: off (default), or the frame's userId is absent/invalid/over the
   * MAX_RTMS_PARTICIPANTS cap → byte-identical to today (pumpAudioMixed, one outSeq, deps.ingestSocket()).
   * On + a valid, in-budget userId → demuxed to that participant's own seq + sink fan-out (pumpAudioParticipant).
   */
  private pumpAudio(rtmsPcm: Uint8Array, userId?: number): void {
    if (this.perParticipantEnabled) {
      const safeId = sanitizeRtmsUserId(userId);
      if (safeId) {
        const p = this.getOrCreateParticipant(safeId);
        if (p) {
          this.pumpAudioParticipant(rtmsPcm, safeId, p);
          return;
        }
        // over MAX_RTMS_PARTICIPANTS → fall through to the mixed track (cap already logged)
      }
    }
    this.pumpAudioMixed(rtmsPcm);
  }

  /** The pre-fanout behavior, byte-identical: single outSeq, single deps.ingestSocket(). */
  private pumpAudioMixed(rtmsPcm: Uint8Array): void {
    const sock = this.deps.ingestSocket();
    if (!sock) return; // ingest not connected yet → drop
    try {
      const bytes = int16ToPcmS16Le(rtmsAudioToSfuPcm(rtmsPcm));
      // Zoom audio frames carry no adapter timestamp; 0 mirrors the ingest producers in agent-turn.ts.
      for (const chunk of chunkPcm(bytes)) {
        sock.send(encodeIngestFrame(chunk, { sequenceNumber: this.outSeq++, timestamp: 0 }, this.framing));
      }
    } catch (e) {
      this.deps.log("rtms-bridge-audio-error", { message: (e as Error)?.message ?? "unknown" });
    }
  }

  /** #RTMS-fanout — one participant's audio: transcode once, encode once per chunk with THAT participant's
   *  own seq, then tee the identical frame bytes to every resolved sink. A throwing sink is logged and
   *  skipped — never blocks the other sinks (fan-out fail-safety mirrors pumpAudioMixed's transcode guard). */
  private pumpAudioParticipant(
    rtmsPcm: Uint8Array,
    userId: string,
    p: { seq: number; videoSeq: number; sinks: ParticipantSink[] },
  ): void {
    if (p.sinks.length === 0) return; // no sinks resolved yet → drop, fail-safe (mirrors the null-socket drop)
    try {
      const bytes = int16ToPcmS16Le(rtmsAudioToSfuPcm(rtmsPcm));
      for (const chunk of chunkPcm(bytes)) {
        const frame = encodeIngestFrame(chunk, { sequenceNumber: p.seq++, timestamp: 0 }, this.framing);
        for (const sink of p.sinks) {
          try {
            sink.audio(frame);
          } catch (e) {
            this.deps.log("rtms-bridge-sink-audio-error", { userId, message: (e as Error)?.message ?? "unknown" });
          }
        }
      }
    } catch (e) {
      this.deps.log("rtms-bridge-audio-error", { userId, message: (e as Error)?.message ?? "unknown" });
    }
  }

  /**
   * Resolve (or lazily create) a participant's demux state. Caps distinct participants at
   * MAX_RTMS_PARTICIPANTS to bound this map's memory against a spoofed/rotating stream of userIds — over
   * the cap logs "rtms-participant-cap" and returns null (caller falls back to the mixed track, never an
   * unbounded map, never a silently dropped participant).
   */
  private getOrCreateParticipant(userId: string): { seq: number; videoSeq: number; sinks: ParticipantSink[] } | null {
    const existing = this.participants.get(userId);
    if (existing) return existing;
    if (this.participants.size >= MAX_RTMS_PARTICIPANTS) {
      this.deps.log("rtms-participant-cap", { meetingUuid: this.meetingUuid, userId, max: MAX_RTMS_PARTICIPANTS });
      return null;
    }
    const trackName = `zoom-${this.meetingUuid}-${userId}`;
    const sinks = this.deps.sinks?.(userId) ?? [];
    const p = { seq: 0, videoSeq: 0, sinks };
    this.participants.set(userId, p);
    this.deps.log("rtms-bridge-participant-open", { meetingUuid: this.meetingUuid, userId, trackName, sinks: sinks.length });
    return p;
  }

  /**
   * One RTMS video frame (a JPEG still) → the SFU video-ingest socket, behind WAVE_RTMS_VIDEO. Mirrors
   * pumpAudio's fail-safe contract: dropped (not buffered) until the SFU has dialed the video ingest
   * endpoint, and a transcode/send error is logged + swallowed, never thrown up the socket path. Sent as
   * ONE ingest Packet per still (no chunking) — symmetric with the egress decode side, which treats one
   * decoded Packet payload as one whole JPEG (encoders/container-adapter.ts).
   *
   * #147 NOTE: pushing this frame into a room track is the INGEST leg only. Whether that track can be
   * recorded/perceived downstream is a separate, already-known CF-platform block (issue #147) — this
   * method proves nothing about that and never claims to.
   */
  private pumpVideo(rtmsJpeg: Uint8Array, userId?: number): void {
    if (!this.videoEnabled) return; // defensive — the handshake never subscribes to VIDEO when off
    if (this.perParticipantEnabled) {
      const safeId = sanitizeRtmsUserId(userId);
      if (safeId) {
        const p = this.getOrCreateParticipant(safeId);
        if (p) {
          this.pumpVideoParticipant(rtmsJpeg, safeId, p);
          return;
        }
        // over MAX_RTMS_PARTICIPANTS → fall through to the mixed track (cap already logged)
      }
    }
    this.pumpVideoMixed(rtmsJpeg);
  }

  /** The pre-fanout behavior, byte-identical: single outVideoSeq, single deps.videoIngestSocket(). */
  private pumpVideoMixed(rtmsJpeg: Uint8Array): void {
    const sock = this.deps.videoIngestSocket?.();
    if (!sock) return; // video ingest not connected yet (or the DO never wired one) → drop
    try {
      const jpeg = rtmsVideoToSfuJpeg(rtmsJpeg);
      sock.send(encodeIngestFrame(jpeg, { sequenceNumber: this.outVideoSeq++, timestamp: 0 }, this.framing));
    } catch (e) {
      this.deps.log("rtms-bridge-video-error", { message: (e as Error)?.message ?? "unknown" });
    }
  }

  /** #RTMS-fanout — one participant's video still: transcode once, encode once with THAT participant's own
   *  videoSeq, tee the identical frame bytes to every sink that implements the optional `video()` member. */
  private pumpVideoParticipant(
    rtmsJpeg: Uint8Array,
    userId: string,
    p: { seq: number; videoSeq: number; sinks: ParticipantSink[] },
  ): void {
    if (p.sinks.length === 0) return; // no sinks resolved yet → drop, fail-safe
    try {
      const jpeg = rtmsVideoToSfuJpeg(rtmsJpeg);
      const frame = encodeIngestFrame(jpeg, { sequenceNumber: p.videoSeq++, timestamp: 0 }, this.framing);
      for (const sink of p.sinks) {
        if (!sink.video) continue;
        try {
          sink.video(frame);
        } catch (e) {
          this.deps.log("rtms-bridge-sink-video-error", { userId, message: (e as Error)?.message ?? "unknown" });
        }
      }
    } catch (e) {
      this.deps.log("rtms-bridge-video-error", { userId, message: (e as Error)?.message ?? "unknown" });
    }
  }

  private onLegClose(leg: "signaling" | "media"): void {
    this.deps.log("rtms-bridge-leg-close", { leg });
    // If either leg drops the stream is over — tear the whole bridge down (best-effort, idempotent).
    this.stop();
  }

  /** Parse one inbound frame, swallowing malformed JSON (logged) — never throws up the socket path. */
  private parse(text: string): ReturnType<typeof parseRtmsMessage> | null {
    try {
      return parseRtmsMessage(text);
    } catch (e) {
      if (e instanceof RtmsProtocolError) this.deps.log("rtms-bridge-parse-error", { message: e.message });
      return null;
    }
  }

  /** Close both Zoom legs. Best-effort, idempotent, never throws. The ingest socket is owned by the DO. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of [this.sig, this.media]) {
      try {
        s?.close();
      } catch {
        /* best-effort */
      }
    }
    this.sig = null;
    this.media = null;
    // #RTMS-fanout — best-effort close every participant sink (mirrors the leg-close contract above); the
    // mixed-track ingest/videoIngest sockets are DO-owned and unaffected (same as before this change).
    for (const p of this.participants.values()) {
      for (const sink of p.sinks) {
        try {
          sink.close();
        } catch {
          /* best-effort */
        }
      }
    }
    this.participants.clear();
    this.deps.log("rtms-bridge-stop", {});
  }
}
