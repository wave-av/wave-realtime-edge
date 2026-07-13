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
import { parseSdpTracks, buildWhipTrackName } from "./whip-room.js";
import { emitParticipantUsage, MeterEmitEnv } from "./metering.js";
import {
  EventEmitEnv,
  emitEvent,
  buildRoomStarted,
  buildRoomFinished,
  buildParticipantJoined,
  buildParticipantLeft,
  buildTrackPublished,
  buildSessionEnded,
} from "./event-emitter.js";

/** A validated request context. AUTH is upstream (gateway) — see file header. */
export interface SignalContext {
  org: string;
  room: string;
  participantId: string;
  /** Role stamped by the gateway (from a WRT or an operator call). Optional — falls back to policy default. */
  role?: Role;
  /** Room type forwarded by the worker; used to set the admission policy on first bind. */
  type?: RoomType;
  /**
   * Whether this joiner is anonymous (no authenticated WAVE account). Stamped by the worker from the
   * gateway's `x-wave-anon` marker. Enforced against policy.allowAnonymous in admissionCheck.
   */
  anon?: boolean;
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
/**
 * RT-R9 — the recording orchestration hook the signaling layer drives. publishTrack → onPublish (best-effort,
 * NEVER blocks publish); leave/endRoom → finalize AFTER the leave is committed. DORMANT when the encoder is
 * disarmed/managed. Injected by the RoomDO; absent in pure-signaling tests → recording is a no-op.
 */
export interface RecordingHook {
  onPublish(org: string, sessionId: string, room: string, trackName: string, kind: TrackKind): Promise<void>;
  finalize(sessionId: string): Promise<void>;
}

export class Signaling {
  constructor(
    private readonly room: RoomCore,
    private readonly sfu: SfuClient,
    /** P5.3 metering env (gateway URL + service token). Optional → emit is INERT until provisioned. */
    private readonly meterEnv: MeterEmitEnv = {},
    /** RT-R9 recording hook. Optional → recording is a no-op (pure-signaling tests, or no recorder bound). */
    private readonly recording?: RecordingHook,
    /**
     * LK-rip #46 event-emitter env (flag + shared HMAC secret + ingest URL). Optional → DORMANT: the SFU
     * emits NO room/session lifecycle events to the WSC Argus ingest until WAVE_REALTIME_EVENTS_EMIT="1"
     * AND the secret are provisioned (the Jake-named cutover). Every emit is fail-open (never blocks media).
     */
    private readonly eventEnv: EventEmitEnv = {},
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
    const waiting = await this.room.admissionCheck(ctx.org, { participantId: ctx.participantId, role, anon: ctx.anon });
    if (waiting) return waiting; // knocking — no SFU session minted

    // Auto/no-policy: mint SFU session, then record in room state. Snapshot occupancy BEFORE seating so we
    // can detect the room's FIRST participant → room.started (LK-rip #46). The DO serializes join, so this
    // read→join is race-free per room.
    const wasEmpty = (await this.room.listParticipants()).length === 0;
    const session = await this.sfu.newSession(opts.offer);
    const participant = await this.room.joinRoom(ctx.org, {
      participantId: ctx.participantId,
      sessionId: session.sessionId,
      role,
    });
    // LK-rip #46: emit lifecycle events to the WSC Argus ingest (DORMANT until armed; fail-open — an emit
    // failure never affects the join). State of record is committed first, then observability fans out.
    if (wasEmpty) await emitEvent(this.eventEnv, buildRoomStarted({ org: ctx.org, room: ctx.room }));
    await emitEvent(this.eventEnv, buildParticipantJoined({ org: ctx.org, room: ctx.room }, ctx.participantId));
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
      // LK-rip #46: emit track.published to the WSC Argus ingest (DORMANT until armed; fail-open).
      await emitEvent(this.eventEnv, buildTrackPublished({ org: ctx.org, room: ctx.room }, ctx.participantId, { name: t.trackName, kind: t.kind }));
      // RT-R9: arm/forward to the raw-SFU recorder (best-effort). A recording error must NEVER block the
      // publish (media-safety > recording, design §4) — the hook is internally fail-open, and this is wrapped
      // again defensively so even a thrown hook can't fail the registered publish.
      if (this.recording) {
        try {
          await this.recording.onPublish(ctx.org, participant.sessionId, ctx.room, t.trackName, t.kind);
        } catch {
          /* fail-open — recording never blocks publish */
        }
      }
    }
    return result;
  }

  /**
   * WHIP-PUBLISH (#144 / #91-B): the ingress equivalent of join+publish, run INSIDE the RoomDO so the room
   * owns the single-writer recorder + capability negotiation for a direct-WHIP publish (which the bare
   * `sfu.newSession(offer)` in whip.ts bypasses). WHIP carries no explicit track list, so the tracks are
   * SERVER-derived from the OFFER's media sections.
   *
   * #146 — uses CF's STANDARD local-publish handshake so track-naming is ATOMIC with transport establishment:
   *   1. ensureRoom + newSession() → an EMPTY session id (no offer consumed yet).
   *   2. parse the OFFER m-lines → (mid, kind); assign each a deterministic trackName.
   *   3. pushTracks(local tracks, OFFER) — ONE tracks/new that BOTH establishes the transport (the offer is the
   *      client's SDP) AND names the tracks; CF returns the answer (the WHIP 201 body). The tracks exist the
   *      instant we return the answer.
   *   4. seat the publisher (registerTrack's presence invariant) and, per named track, register + arm the
   *      recorder (onPublish — the SAME arm the room `publish` intent uses).
   *
   * Why not newSession(offer) + tracks/new(no-offer) (the prior shape)? That 425s "Too Early": the WHIP client
   * only applies the answer AFTER our 201 returns, so a no-offer tracks/new races ahead of the client's DTLS
   * and CF has no established transport to name a local track against. Carrying the offer IN tracks/new makes
   * the offer itself the establishing SDP, so naming never races the (still-connecting) client.
   * RECORDING IS FAIL-OPEN: a register/record error never fails the publish (media-safety > recording).
   */
  async whipPublish(ctx: SignalContext, opts: { offer: SessionDescription }): Promise<{
    sessionId: string;
    sessionDescription: SessionDescription;
    tracks: { mid: string; trackName: string; kind: TrackKind }[];
  }> {
    this.assertCtx(ctx);
    if (!opts.offer || opts.offer.type !== "offer" || !opts.offer.sdp) {
      throw new SignalError("BAD_REQUEST", "whip-publish requires an SDP offer", 400);
    }
    await this.room.ensureRoom({ roomId: ctx.room, org: ctx.org, type: ctx.type });
    // Empty session first (no offer) — the offer rides the tracks/new below so naming is atomic with transport.
    const { sessionId } = await this.sfu.newSession();
    // Derive the tracks from the OFFER's media sections (the answer isn't back yet) and assign url-safe names.
    const parsed = parseSdpTracks(opts.offer.sdp);
    if (parsed.length === 0) {
      throw new SignalError("BAD_REQUEST", "WHIP offer carries no audio/video media sections", 400);
    }
    const named = parsed.map((t) => ({
      mid: t.mid,
      trackName: buildWhipTrackName(sessionId, t.mid),
      kind: t.kind as TrackKind,
    }));
    const local: LocalTrack[] = named.map((n) => ({ location: "local", mid: n.mid, trackName: n.trackName }));
    // ONE tracks/new carrying the OFFER: establishes transport + names every local track; returns the answer.
    const pushed = await this.sfu.pushTracks(sessionId, local, opts.offer);
    const answer = pushed.sessionDescription;
    if (!answer || answer.type !== "answer" || !answer.sdp) {
      throw new SignalError("REALTIME_UPSTREAM", "SFU did not return an SDP answer for the WHIP publish", 502);
    }
    // Seat the ingress publisher (speaker) so the room's registry/recorder can attribute their tracks.
    await this.room.joinRoom(ctx.org, { participantId: ctx.participantId, sessionId, role: ctx.role ?? "speaker" });
    for (const n of named) {
      // Register in the room + arm the recorder. The track is already NAMED on the SFU (step 3), so the
      // recorder's create-adapter rides out only the media-FLOW race (its designed budget) — never a
      // never-named track. Each step fail-open: recording/registry never blocks the WHIP publish.
      try {
        await this.room.registerTrack(ctx.org, {
          trackName: n.trackName,
          sessionId,
          participantId: ctx.participantId,
          kind: n.kind,
        });
        await emitEvent(this.eventEnv, buildTrackPublished({ org: ctx.org, room: ctx.room }, ctx.participantId, { name: n.trackName, kind: n.kind }));
        if (this.recording) await this.recording.onPublish(ctx.org, sessionId, ctx.room, n.trackName, n.kind);
      } catch {
        /* fail-open — recording/registry never blocks the WHIP publish */
      }
    }
    return { sessionId, sessionDescription: answer, tracks: named };
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
    // LK-rip #46: emit participant.left + the BILLABLE session.ended (carries session_minutes + org_id; the
    // ingest meters wave_realtime_{video,audio}_minutes off it) to the WSC Argus ingest, then room.finished
    // when this leave emptied the room. DORMANT until armed; fail-open — an emit never affects the leave.
    if (usage) {
      await emitEvent(this.eventEnv, buildParticipantLeft(usage));
      await emitEvent(this.eventEnv, buildSessionEnded(usage));
      if ((await this.room.listParticipants()).length === 0) {
        await emitEvent(this.eventEnv, buildRoomFinished({ org: ctx.org, room: ctx.room }));
      }
    }
    // RT-R9: finalize the raw-SFU recording AFTER the leave is committed (state of record first). Best-effort:
    // a finalize-throw is swallowed so the leave still succeeds (media-safety > recording, design §4).
    if (usage && this.recording) {
      try {
        await this.recording.finalize(usage.sessionId);
      } catch {
        /* fail-open — a recorder finalize error never fails the leave */
      }
    }
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
