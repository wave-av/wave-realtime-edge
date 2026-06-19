// P5.2 — signaling layer (join / leave / publish-track / subscribe-track / renegotiate).
//
// The orchestration glue between client intents, the Room DO state machine (RoomCore, src/room.ts),
// and the CF Realtime SFU media client (SfuClient, src/sfu.ts). A client connects → joins a room
// (Room DO records the participant + their SFU session) → publishes tracks (SFU push → registry) →
// other participants subscribe (SFU pull from the publisher's session) → leaves (cleanup). The
// signaling layer NEVER holds media; it only translates intents into Room-DO state transitions and
// SFU calls, in the right order, with media-safety > metering (design §4).
//
// AUTH IS DELIBERATELY OUT (P5.2-auth, a separate change via the gateway). Every method receives an
// ALREADY-VALIDATED context `{ org, room, participantId }` — this layer assumes the caller (gateway)
// has authenticated + scoped the request and minted/verified the WAVE room token. It enforces only
// the in-room invariants the Room DO owns (per-org isolation, participant presence, publish grants).
//
// No live network in tests: the SfuClient's HTTP is injectable and RoomCore's storage is injectable.

import { RoomCore, Role, RoomType, TrackKind, WaitingResult } from "./room.js";
import { SfuClient, SessionDescription, LocalTrack } from "./sfu.js";
import { emitParticipantUsage, MeterEmitEnv } from "./metering.js";

/** A validated request context. AUTH is upstream (gateway) — see file header. */
export interface SignalContext {
  org: string;
  room: string;
  participantId: string;
  /** Role stamped by the gateway (from a WRT or an operator call). Optional — falls back to policy default. */
  role?: Role;
  /** Room type forwarded by the worker; used to set the admission policy on first bind. */
  type?: RoomType;
}

/** A track the client wants to publish: a transceiver mid + a CF Realtime track name + its kind. */
export interface PublishTrack {
  mid: string;
  trackName: string;
  kind: TrackKind;
}

export interface JoinResult {
  participantId: string;
  /** The CF Realtime SFU session id minted for this participant. */
  sessionId: string;
  /** The SFU's SDP answer, when the join carried a client offer. */
  sessionDescription?: SessionDescription;
}

/** Returned by join() when the room is in knock mode and the participant is placed in the waiting room. */
export type JoinOrWaiting = JoinResult | WaitingResult;

export interface NegotiateResult {
  /** Per-track status echoed by the SFU (empty for renegotiate). */
  tracks: { mid?: string; trackName: string; sessionId?: string }[];
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
}

/**
 * Boundary error for the signaling layer → normalized {error,message,status} by the worker. Mirrors
 * SfuError/RtkError so the spoke has ONE error contract. SFU/Room errors carrying `code`+`status`
 * propagate as-is; this type covers signaling-specific cases (forbidden, track-not-found).
 */
export class SignalError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "SignalError";
  }
}

/**
 * Signaling — constructed per request with a RoomCore (this room's DO state) + an SfuClient (SFU media
 * client built from env). Stateless beyond those two collaborators.
 */
export class Signaling {
  constructor(
    private readonly room: RoomCore,
    private readonly sfu: SfuClient,
    /** P5.3 metering env (gateway URL + service token). Optional → emit is INERT until provisioned. */
    private readonly meterEnv: MeterEmitEnv = {},
  ) {}

  /**
   * JOIN: bind the room to the org (idempotent), run the admission pre-check, then (if admitted)
   * mint an SFU session and record the participant in the Room DO.
   *
   * When the room is in "knock" mode the participant is placed in the waiting room and a
   * `{ waiting: true, participantId }` sentinel is returned WITHOUT minting an SFU session —
   * the host calls admit() and the participant retries.
   *
   * Role precedence: ctx.role (gateway-stamped) → opts.role → policy default → "speaker".
   */
  async join(ctx: SignalContext, opts: { role?: Role; offer?: SessionDescription } = {}): Promise<JoinOrWaiting> {
    this.assertCtx(ctx);
    const role: Role | undefined = ctx.role ?? opts.role;
    await this.room.ensureRoom({ roomId: ctx.room, org: ctx.org, type: ctx.type });

    // Admission pre-check: enforces ban/lock/capacity/knock before we spend a SFU session.
    // Returns { waiting: true } for knock rooms, null to proceed for auto/no-policy.
    const waiting = await this.room.admissionCheck(ctx.org, { participantId: ctx.participantId, role });
    if (waiting) return waiting; // knocking — no SFU session minted

    // Auto/no-policy: mint SFU session, then record in room state.
    const session = await this.sfu.newSession(opts.offer);
    const participant = await this.room.joinRoom(ctx.org, {
      participantId: ctx.participantId,
      sessionId: session.sessionId,
      role,
    });
    return {
      participantId: participant.participantId,
      sessionId: session.sessionId,
      sessionDescription: session.sessionDescription,
    };
  }

  /**
   * PUBLISH: push the participant's local tracks into THEIR SFU session, then register each in the room
   * registry so other participants can discover + pull them. Publish grant is enforced here.
   */
  async publishTrack(ctx: SignalContext, req: { tracks: PublishTrack[]; offer: SessionDescription }): Promise<NegotiateResult> {
    this.assertCtx(ctx);
    if (!Array.isArray(req.tracks) || req.tracks.length === 0) {
      throw new SignalError("BAD_REQUEST", "at least one track is required to publish", 400);
    }
    const participant = await this.requireParticipant(ctx);
    if (!participant.permissions.canPublish) {
      throw new SignalError("FORBIDDEN", "participant may not publish", 403);
    }
    const local: LocalTrack[] = req.tracks.map((t) => ({ location: "local", mid: t.mid, trackName: t.trackName }));
    const result = await this.sfu.pushTracks(participant.sessionId, local, req.offer);
    // Media is live on the SFU now — register in the DO so subscribers can find these tracks.
    for (const t of req.tracks) {
      await this.room.registerTrack(ctx.org, {
        trackName: t.trackName,
        sessionId: participant.sessionId,
        participantId: ctx.participantId,
        kind: t.kind,
      });
    }
    return result;
  }

  /**
   * SUBSCRIBE: resolve a published track in the room registry, then PULL it from the PUBLISHER's SFU
   * session into THIS participant's session. Subscribe grant is enforced. The SFU may return an offer
   * with `requiresImmediateRenegotiation` — the client answers it via renegotiate().
   */
  async subscribeTrack(ctx: SignalContext, req: { trackName: string }): Promise<NegotiateResult> {
    this.assertCtx(ctx);
    const subscriber = await this.requireParticipant(ctx);
    if (!subscriber.permissions.canSubscribe) {
      throw new SignalError("FORBIDDEN", "participant may not subscribe", 403);
    }
    const tracks = await this.room.listTracks();
    const published = tracks.find((t) => t.trackName === req.trackName);
    if (!published) {
      throw new SignalError("TRACK_NOT_FOUND", `no published track named ${req.trackName}`, 404);
    }
    return this.sfu.pullTracks(subscriber.sessionId, [
      { location: "remote", sessionId: published.sessionId, trackName: published.trackName },
    ]);
  }

  /**
   * RENEGOTIATE: forward a client SDP (an answer to the SFU's pull-offer, or a fresh client offer) to
   * the participant's SFU session so the PeerConnection re-syncs.
   */
  async renegotiate(ctx: SignalContext, req: { answer: SessionDescription }): Promise<NegotiateResult> {
    this.assertCtx(ctx);
    const participant = await this.requireParticipant(ctx);
    return this.sfu.renegotiate(participant.sessionId, req.answer);
  }

  /**
   * LEAVE: remove the participant from the Room DO, which GCs every track owned by their session. The
   * SFU session is left to CF Realtime's 30s inactivity GC (no media held here). Idempotent.
   */
  async leave(ctx: SignalContext): Promise<void> {
    this.assertCtx(ctx);
    // Commit the leave FIRST (state of record), then meter best-effort. P5.3: the leaveRoom snapshot
    // carries the join→leave window + which tiers (audio/video) this participant published; the tap
    // computes participant-minutes + overage-only egress and flushes to the gateway. A metering failure
    // must NEVER affect the leave (media-safety > metering, design §4) — emitParticipantUsage is fail-open.
    const usage = await this.room.leaveRoom(ctx.org, ctx.participantId);
    if (usage) await emitParticipantUsage(this.meterEnv, usage);
  }

  private assertCtx(ctx: SignalContext): void {
    if (!ctx || !ctx.org || !ctx.room || !ctx.participantId) {
      throw new SignalError("BAD_REQUEST", "org, room and participantId are required", 400);
    }
  }

  private async requireParticipant(ctx: SignalContext) {
    const list = await this.room.listParticipants();
    const p = list.find((x) => x.participantId === ctx.participantId);
    if (!p) {
      throw new SignalError("PARTICIPANT_NOT_IN_ROOM", "participant has not joined the room", 409);
    }
    return p;
  }
}
