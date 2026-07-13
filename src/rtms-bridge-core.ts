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
  /** Wall clock (ms) — injectable so any timing instrumentation is deterministic in tests. */
  now(): number;
  /** Structured log sink (JSON line) — injectable so tests can assert emitted instrumentation. */
  log(msg: string, fields: Record<string, unknown>): void;
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

  constructor(
    private readonly deps: RtmsBridgeDeps,
    private readonly config: RtmsBridgeConfig,
  ) {
    // DEFAULT "packet" — symmetric with the verified egress decoder; a live spike may flip to "raw".
    this.framing = config.framing ?? "packet";
    // DEFAULT false — WAVE_RTMS_VIDEO off is byte-identical to the pre-video audio-only bridge.
    this.videoEnabled = config.videoEnabled ?? false;
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
        this.pumpAudio(msg.payload);
        break;
      case "video":
        this.pumpVideo(msg.payload);
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
   * One RTMS audio frame (PCM s16le 16k mono) → 48k-stereo PCM → ≤32KB ingest frames on the SFU
   * socket. Dropped (not buffered) until the SFU has dialed in (the SFU re-sends continuous audio).
   * Fail-safe: a transcode/send error is logged and swallowed.
   */
  private pumpAudio(rtmsPcm: Uint8Array): void {
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
  private pumpVideo(rtmsJpeg: Uint8Array): void {
    if (!this.videoEnabled) return; // defensive — the handshake never subscribes to VIDEO when off
    const sock = this.deps.videoIngestSocket?.();
    if (!sock) return; // video ingest not connected yet (or the DO never wired one) → drop
    try {
      const jpeg = rtmsVideoToSfuJpeg(rtmsJpeg);
      sock.send(encodeIngestFrame(jpeg, { sequenceNumber: this.outVideoSeq++, timestamp: 0 }, this.framing));
    } catch (e) {
      this.deps.log("rtms-bridge-video-error", { message: (e as Error)?.message ?? "unknown" });
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
    this.deps.log("rtms-bridge-stop", {});
  }
}
