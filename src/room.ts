// P5.1 — Room Durable Object skeleton (per-room state, no signaling/auth).
//
// One Durable Object instance per room. Single source of truth for room state:
//   • participant set (org-scoped — a room is bound to ONE org)
//   • published/subscribed track registry keyed by CF Realtime track ids
//   • per-participant permissions (grants)
//   • join/leave handlers + a room TTL
//   • registry reconcile against CF Realtime's 30s inactivity GC (design §4)
//   • admission policy per room type (knock/auto, lock, capacity, waiting room, safety ops) — P5.2-auth
//
// Signaling and auth are DELIBERATELY OUT (P5.2). This file exposes a typed *internal API* the future
// signaling layer will call (joinRoom / leaveRoom / register tracks / reconcile). The DO holds state;
// it does not talk to the SFU or the network here. Tests inject the storage, so no live DO runtime is
// needed (the class is also wired as a real DurableObject for when bindings land).

import { SfuClient, SfuError } from "./sfu.js";
import type { SessionDescription } from "./sfu.js";
import { Signaling } from "./signaling.js";
import type { SignalContext, PublishTrack } from "./signaling.js";
import type { ParticipantSessionUsage, MeterEmitEnv } from "./metering.js";

/** CF Realtime GCs a track after 30s of inactivity (design §4). Registry reconcile uses this. */
export const TRACK_GC_MS = 30_000;
/** Default room lifetime once empty/idle, after which the room is considered expired. */
export const DEFAULT_ROOM_TTL_MS = 30 * 60_000; // 30 min

export type Role = "host" | "speaker" | "viewer";

// ── P5.2-auth: per-room-type admission policy ────────────────────────────────────────────────────

export type RoomType = "meeting" | "webinar" | "event" | "breakout";

export interface AdmissionPolicy {
  /** "knock" → all non-host joiners wait for approval; "auto" → admitted immediately. */
  mode: "knock" | "auto";
  /** When true, new joins are refused with 423 ROOM_LOCKED until unlock(). */
  locked: boolean;
  /** Maximum participant count; null = unlimited. Excess joins → 429 ROOM_FULL. */
  capacity: number | null;
  /** Role assigned when no explicit role is requested. */
  defaultRole: Role;
  /** Whether anonymous (no WAVE account) participants are allowed. */
  allowAnonymous: boolean;
}

const POLICY_DEFAULTS: Record<RoomType, AdmissionPolicy> = {
  meeting:  { mode: "knock", locked: false, capacity: null,  defaultRole: "speaker", allowAnonymous: false },
  webinar:  { mode: "auto",  locked: false, capacity: null,  defaultRole: "viewer",  allowAnonymous: true  },
  event:    { mode: "auto",  locked: false, capacity: 10000, defaultRole: "viewer",  allowAnonymous: true  },
  breakout: { mode: "auto",  locked: false, capacity: null,  defaultRole: "viewer",  allowAnonymous: false },
};

/** A participant waiting for admission (knock rooms). No SFU session is minted yet. */
export interface WaitingEntry {
  participantId: string;
  role: Role;
  requestedAt: number;
}

/** Sentinel returned by joinRoom when the participant is placed in the waiting room. */
export interface WaitingResult {
  waiting: true;
  participantId: string;
}

/** Per-participant grants. Kept minimal here; auth/scope enforcement is P5.2. */
export interface Permissions {
  canPublish: boolean;
  canSubscribe: boolean;
}

export interface Participant {
  participantId: string;
  /** CF Realtime SFU session id for this participant (opaque). */
  sessionId: string;
  role: Role;
  permissions: Permissions;
  joinedAt: number;
  /** Sticky: set true the first time the participant publishes an AUDIO track (P5.3 metering tier). */
  publishedAudio?: boolean;
  /** Sticky: set true the first time the participant publishes a VIDEO track (P5.3 metering tier). */
  publishedVideo?: boolean;
}

export type TrackKind = "audio" | "video";

/** A track in the room registry, keyed by CF Realtime trackName, owned by a participant's session. */
export interface RoomTrack {
  trackName: string;
  sessionId: string;
  participantId: string;
  kind: TrackKind;
  /** Last time the publisher was seen active; reconcile() GCs tracks idle > TRACK_GC_MS. */
  lastSeenAt: number;
}

/** Immutable room binding. `org` binds the room to a single org (invariant: per-org isolation). */
export interface RoomConfig {
  roomId: string;
  org: string;
  ttlMs?: number;
  /** Optional room type — sets the admission policy on first bind. */
  type?: RoomType;
}

export interface RoomState {
  config: RoomConfig | null;
  participants: Record<string, Participant>;
  tracks: Record<string, RoomTrack>;
  /** Set when the room becomes empty; room expires at emptyAt + ttl. Null while occupied. */
  emptyAt: number | null;
  // ── P5.2-auth admission fields ──────────────────────────────────────────────────────────────
  /** Active admission policy. Null until ensureRoom sets it (no type → no policy enforcement). */
  policy: AdmissionPolicy | null;
  /** Participants waiting for admission (knock mode). Keyed by participantId. */
  waiting: Record<string, WaitingEntry>;
  /** Permanently banned participant ids. A banned pid is denied immediately on join. */
  banned: string[];
}

/** Minimal storage surface (subset of DurableObjectStorage) — injectable for tests. */
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const STATE_KEY = "room:state";
const ROLE_DEFAULT_PERMS: Record<Role, Permissions> = {
  host: { canPublish: true, canSubscribe: true },
  speaker: { canPublish: true, canSubscribe: true },
  viewer: { canPublish: false, canSubscribe: true },
};

function emptyState(): RoomState {
  return { config: null, participants: {}, tracks: {}, emptyAt: Date.now(), policy: null, waiting: {}, banned: [] };
}

/**
 * RoomCore — the testable state machine, decoupled from the DO runtime. The DurableObject wrapper
 * (below) delegates to this. All mutations persist through the injected storage. `now()` is injectable
 * so GC/TTL transitions are deterministic in tests.
 */
export class RoomCore {
  private state: RoomState | null = null;

  constructor(
    private readonly storage: RoomStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<RoomState> {
    if (this.state) return this.state;
    this.state = (await this.storage.get<RoomState>(STATE_KEY)) ?? emptyState();
    return this.state;
  }

  private async save(s: RoomState): Promise<void> {
    this.state = s;
    await this.storage.put(STATE_KEY, s);
  }

  /** Bind the room to an org on first use. Idempotent for the SAME (roomId, org); rejects a mismatch.
   *  If `type` is provided and no policy is set yet, applies the corresponding POLICY_DEFAULTS entry. */
  async ensureRoom(config: RoomConfig): Promise<RoomConfig> {
    const s = await this.load();
    if (s.config) {
      if (s.config.org !== config.org || s.config.roomId !== config.roomId) {
        // Per-org isolation invariant: a room bound to org A can never be reused for org B.
        throw new SfuError("ROOM_ORG_MISMATCH", "room is bound to a different org/room", 409);
      }
      // Apply policy if a type was given and no policy has been set yet.
      if (config.type && !s.policy) {
        s.policy = { ...POLICY_DEFAULTS[config.type] };
        await this.save(s);
      }
      return s.config;
    }
    s.config = { roomId: config.roomId, org: config.org, ttlMs: config.ttlMs ?? DEFAULT_ROOM_TTL_MS };
    if (config.type) s.policy = { ...POLICY_DEFAULTS[config.type] };
    await this.save(s);
    return s.config;
  }

  /**
   * Join a participant. The room MUST already be bound to `org` (ensureRoom) and the join's org must
   * match — a token for org A can never join org B's room (design §4 isolation invariant).
   *
   * When an AdmissionPolicy is active:
   *   • banned participant  → throws 403 PARTICIPANT_BANNED
   *   • locked room         → throws 423 ROOM_LOCKED
   *   • at capacity         → throws 429 ROOM_FULL
   *   • mode "knock"        → places participant in waiting room + returns WaitingResult (no sessionId needed)
   *   • mode "auto"         → joins immediately (existing behaviour, requires sessionId)
   */
  async joinRoom(
    org: string,
    p: { participantId: string; sessionId: string; role?: Role; permissions?: Permissions },
  ): Promise<Participant> {
    const s = await this.load();
    if (!s.config) throw new SfuError("ROOM_NOT_BOUND", "room is not bound to an org", 409);
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org may not join this room", 403);
    if (!p.participantId || !p.sessionId) throw new SfuError("BAD_REQUEST", "participantId and sessionId are required", 400);

    // ── Admission policy checks (capacity, lock, ban) are run even on auto/no-policy path ────
    if (s.policy) {
      if (s.banned.includes(p.participantId)) {
        throw new SfuError("PARTICIPANT_BANNED", "participant is banned from this room", 403);
      }
      if (s.policy.locked) {
        throw new SfuError("ROOM_LOCKED", "room is locked — no new participants allowed", 423);
      }
      const occupancy = Object.keys(s.participants).length;
      if (s.policy.capacity !== null && occupancy >= s.policy.capacity) {
        throw new SfuError("ROOM_FULL", "room has reached its participant capacity", 429);
      }
    }

    const role: Role = p.role ?? (s.policy?.defaultRole ?? "speaker");
    const participant: Participant = {
      participantId: p.participantId,
      sessionId: p.sessionId,
      role,
      permissions: p.permissions ?? ROLE_DEFAULT_PERMS[role],
      joinedAt: this.now(),
    };
    s.participants[p.participantId] = participant;
    // If they were in the waiting room (admitted), remove them from there.
    delete s.waiting[p.participantId];
    s.emptyAt = null; // occupied
    await this.save(s);
    return participant;
  }

  /**
   * Admission pre-check: enforces ban/lock/capacity/knock WITHOUT requiring a SFU session.
   * In knock mode, places the participant in the waiting room and returns `{ waiting: true }`.
   * In auto/no-policy mode (or after being admitted), returns null to signal "proceed to joinRoom".
   * The signaling layer calls this BEFORE minting an SFU session.
   */
  async admissionCheck(
    org: string,
    p: { participantId: string; role?: Role },
  ): Promise<WaitingResult | null> {
    const s = await this.load();
    if (!s.config) throw new SfuError("ROOM_NOT_BOUND", "room is not bound to an org", 409);
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org may not join this room", 403);
    if (!s.policy) return null; // no policy → proceed

    if (s.banned.includes(p.participantId)) {
      throw new SfuError("PARTICIPANT_BANNED", "participant is banned from this room", 403);
    }
    if (s.policy.locked) {
      throw new SfuError("ROOM_LOCKED", "room is locked — no new participants allowed", 423);
    }
    const occupancy = Object.keys(s.participants).length;
    if (s.policy.capacity !== null && occupancy >= s.policy.capacity) {
      throw new SfuError("ROOM_FULL", "room has reached its participant capacity", 429);
    }
    if (s.policy.mode === "knock") {
      const role: Role = p.role ?? s.policy.defaultRole;
      s.waiting[p.participantId] = { participantId: p.participantId, role, requestedAt: this.now() };
      await this.save(s);
      return { waiting: true, participantId: p.participantId };
    }
    return null; // auto → proceed to joinRoom
  }

  // ── P5.2-auth: admission + safety operations ─────────────────────────────────────────────────

  /**
   * Admit a waiting participant: promotes them from the waiting room so the signaling layer
   * can mint an SFU session and call joinRoom normally.  Returns the WaitingEntry (role etc.)
   * so the caller knows which role was requested; throws if not found.
   */
  async admit(participantId: string): Promise<WaitingEntry> {
    const s = await this.load();
    const entry = s.waiting[participantId];
    if (!entry) throw new SfuError("PARTICIPANT_NOT_WAITING", "participant is not in the waiting room", 404);
    // Remove from waiting — signaling will call joinRoom to actually seat them.
    delete s.waiting[participantId];
    await this.save(s);
    return entry;
  }

  /** Deny and remove a participant from the waiting room. No-op if they are not waiting. */
  async deny(participantId: string): Promise<void> {
    const s = await this.load();
    if (!s.waiting[participantId]) return;
    delete s.waiting[participantId];
    await this.save(s);
  }

  /** Lock the room: new joins are refused with 423 until unlock(). */
  async lock(): Promise<void> {
    const s = await this.load();
    if (!s.policy) return;
    s.policy.locked = true;
    await this.save(s);
  }

  /** Unlock the room, allowing new joins again. */
  async unlock(): Promise<void> {
    const s = await this.load();
    if (!s.policy) return;
    s.policy.locked = false;
    await this.save(s);
  }

  /** Update the participant capacity limit. null = unlimited. */
  async setCapacity(n: number | null): Promise<void> {
    const s = await this.load();
    if (!s.policy) return;
    s.policy.capacity = n;
    await this.save(s);
  }

  /**
   * Eject a participant: removes them from the room + GCs their tracks. Returns their sessionId
   * so the caller can close the SFU session, or null if they were not present.
   */
  async eject(participantId: string): Promise<string | null> {
    const s = await this.load();
    const participant = s.participants[participantId];
    if (!participant) return null;
    const sessionId = participant.sessionId;
    delete s.participants[participantId];
    for (const [name, t] of Object.entries(s.tracks)) {
      if (t.sessionId === sessionId) delete s.tracks[name];
    }
    if (Object.keys(s.participants).length === 0) s.emptyAt = this.now();
    await this.save(s);
    return sessionId;
  }

  /**
   * Ban a participant: ejects them (if present) and persists a deny record so future join
   * attempts are immediately refused. Returns the ejected sessionId or null.
   */
  async ban(participantId: string): Promise<string | null> {
    const s = await this.load();
    if (!s.banned.includes(participantId)) {
      s.banned.push(participantId);
    }
    // Also eject from waiting if present.
    delete s.waiting[participantId];
    await this.save(s);
    // Eject is a separate operation that re-loads; call it after persisting the ban.
    return this.eject(participantId);
  }

  /**
   * End the room: evict every participant (GC tracks). Returns the list of evicted sessionIds
   * so the caller can close their SFU sessions.
   */
  async endRoom(): Promise<string[]> {
    const s = await this.load();
    const sessionIds = Object.values(s.participants).map((p) => p.sessionId);
    s.participants = {};
    s.tracks = {};
    s.waiting = {};
    s.emptyAt = this.now();
    await this.save(s);
    return sessionIds;
  }

  /** Read the current waiting room entries. */
  async listWaiting(): Promise<WaitingEntry[]> {
    return Object.values((await this.load()).waiting);
  }

  /**
   * Leave a participant: remove them and GC every track owned by their session. Returns a
   * ParticipantSessionUsage snapshot (join→leave window + which kinds they published) for the P5.3
   * metering tap to emit, or null on an idempotent/no-op leave (already gone, or room not bound). The
   * caller emits best-effort AFTER the state is committed — a metering failure must never block the leave.
   */
  async leaveRoom(org: string, participantId: string): Promise<ParticipantSessionUsage | null> {
    const s = await this.load();
    if (!s.config) return null; // nothing to leave
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org mismatch", 403);
    const participant = s.participants[participantId];
    if (!participant) return null; // idempotent leave
    delete s.participants[participantId];
    for (const [name, t] of Object.entries(s.tracks)) {
      if (t.sessionId === participant.sessionId) delete s.tracks[name];
    }
    if (Object.keys(s.participants).length === 0) s.emptyAt = this.now();
    await this.save(s);
    return {
      org: s.config.org,
      room: s.config.roomId,
      participantId: participant.participantId,
      sessionId: participant.sessionId,
      joinedAt: participant.joinedAt,
      leftAt: this.now(),
      publishedAudio: participant.publishedAudio === true,
      publishedVideo: participant.publishedVideo === true,
    };
  }

  /** Register a published track in the room registry (called after a successful SFU pushTracks). */
  async registerTrack(org: string, t: { trackName: string; sessionId: string; participantId: string; kind: TrackKind }): Promise<RoomTrack> {
    const s = await this.load();
    if (!s.config) throw new SfuError("ROOM_NOT_BOUND", "room is not bound to an org", 409);
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org mismatch", 403);
    if (!s.participants[t.participantId]) throw new SfuError("PARTICIPANT_NOT_IN_ROOM", "participant has not joined", 409);
    if (!t.trackName) throw new SfuError("BAD_REQUEST", "trackName is required", 400);
    const track: RoomTrack = { ...t, lastSeenAt: this.now() };
    s.tracks[t.trackName] = track;
    // Sticky per-tier publish flags for P5.3 metering: once a participant publishes a track of a kind,
    // they accrue that meter for the session (kept sticky so a momentary unpublish/GC doesn't zero it).
    const owner = s.participants[t.participantId];
    if (owner) {
      if (t.kind === "audio") owner.publishedAudio = true;
      if (t.kind === "video") owner.publishedVideo = true;
    }
    await this.save(s);
    return track;
  }

  /** Mark a track active (heartbeat) so reconcile() does not GC it. No-op for an unknown track. */
  async touchTrack(trackName: string): Promise<void> {
    const s = await this.load();
    const t = s.tracks[trackName];
    if (!t) return;
    t.lastSeenAt = this.now();
    await this.save(s);
  }

  /** Explicitly unregister a track (called after a successful SFU closeTracks). Idempotent. */
  async unregisterTrack(trackName: string): Promise<void> {
    const s = await this.load();
    if (!s.tracks[trackName]) return;
    delete s.tracks[trackName];
    await this.save(s);
  }

  /**
   * Reconcile the registry against CF Realtime's 30s inactivity GC: any track not seen within
   * TRACK_GC_MS is dropped (the SFU has already GC'd it; we stop tracking/accruing on it). Returns the
   * removed track names. Pure-by-clock via the injected `now`.
   */
  async reconcileTracks(): Promise<string[]> {
    const s = await this.load();
    const cutoff = this.now() - TRACK_GC_MS;
    const removed: string[] = [];
    for (const [name, t] of Object.entries(s.tracks)) {
      if (t.lastSeenAt < cutoff) {
        delete s.tracks[name];
        removed.push(name);
      }
    }
    if (removed.length) await this.save(s);
    return removed;
  }

  /** True once the room is empty AND past its TTL — caller may then dispose the DO. */
  async isExpired(): Promise<boolean> {
    const s = await this.load();
    if (!s.config || s.emptyAt == null) return false;
    if (Object.keys(s.participants).length > 0) return false;
    return this.now() >= s.emptyAt + (s.config.ttlMs ?? DEFAULT_ROOM_TTL_MS);
  }

  /** Read-only snapshot for the signaling layer / tests. */
  async snapshot(): Promise<RoomState> {
    return structuredClone(await this.load());
  }

  async listParticipants(): Promise<Participant[]> {
    return Object.values((await this.load()).participants);
  }

  async listTracks(): Promise<RoomTrack[]> {
    return Object.values((await this.load()).tracks);
  }
}

/** Minimal DO runtime shape (avoids a hard dependency on cloudflare:workers in this skeleton). */
interface DurableObjectStateLike {
  storage: RoomStorage;
}

/**
 * Env the RoomDO reads to build its SFU client + metering tap (referenced, never valued here):
 *   • CF_CALLS_APP_ID / CF_CALLS_APP_SECRET — CF Realtime SFU app creds (sfu.ts). Unset → join fails
 *     closed 503 REALTIME_NOT_CONFIGURED (preserving the /rtk surface).
 *   • GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN — metering tap (metering.ts). Both unset → emit is INERT.
 * __sfuFetch / __meterFetch are TEST-ONLY injectables (no live network in tests); production leaves them
 * undefined so the real `fetch` is used.
 */
export interface RoomDOEnv {
  CF_CALLS_APP_ID?: string;
  CF_CALLS_APP_SECRET?: string;
  GATEWAY_BASE_URL?: string;
  WAVE_SERVICE_TOKEN?: string;
  /** test-only: injected SFU HTTP client (defaults to global fetch). The metering tap uses global fetch. */
  __sfuFetch?: typeof fetch;
}

/** The realtime intents the worker entry forwards to the DO's fetch() (last path segment). */
type RoomIntent = "join" | "publish" | "subscribe" | "renegotiate" | "leave";

/**
 * RoomDO — the Durable Object wrapper. Holds a RoomCore over the DO's own storage and exposes BOTH the
 * typed internal API (used by tests) AND a fetch() control-plane surface (P5.2): the worker entry routes
 * each realtime intent to fetch(), which runs the Signaling orchestration (signaling.ts) over THIS room's
 * RoomCore + an SfuClient built from env, and meters on leave. Running Signaling INSIDE the DO is what
 * gives per-room serialized state + per-org isolation (the DO id is keyed `${org}:${room}` by the worker).
 * Registered in wrangler config (ROOM binding + v1 migration).
 */
export class RoomDO {
  private readonly core: RoomCore;
  private readonly env: RoomDOEnv;

  constructor(state: DurableObjectStateLike, env?: RoomDOEnv) {
    this.core = new RoomCore(state.storage);
    this.env = env ?? {};
  }

  ensureRoom(config: RoomConfig) { return this.core.ensureRoom(config); }
  joinRoom(org: string, p: Parameters<RoomCore["joinRoom"]>[1]) { return this.core.joinRoom(org, p); }
  leaveRoom(org: string, participantId: string) { return this.core.leaveRoom(org, participantId); }
  registerTrack(org: string, t: Parameters<RoomCore["registerTrack"]>[1]) { return this.core.registerTrack(org, t); }
  unregisterTrack(trackName: string) { return this.core.unregisterTrack(trackName); }
  touchTrack(trackName: string) { return this.core.touchTrack(trackName); }
  reconcileTracks() { return this.core.reconcileTracks(); }
  isExpired() { return this.core.isExpired(); }
  snapshot() { return this.core.snapshot(); }
  admissionCheck(org: string, p: Parameters<RoomCore["admissionCheck"]>[1]) { return this.core.admissionCheck(org, p); }
  admit(participantId: string) { return this.core.admit(participantId); }
  deny(participantId: string) { return this.core.deny(participantId); }
  lock() { return this.core.lock(); }
  unlock() { return this.core.unlock(); }
  setCapacity(n: number | null) { return this.core.setCapacity(n); }
  eject(participantId: string) { return this.core.eject(participantId); }
  ban(participantId: string) { return this.core.ban(participantId); }
  endRoom() { return this.core.endRoom(); }
  listWaiting() { return this.core.listWaiting(); }

  /**
   * Control-plane surface. The worker forwards `POST .../<intent>` here with a JSON body carrying the
   * already-validated context (org/room/participantId) + the intent payload. Builds the SfuClient lazily
   * (so an unconfigured app fails closed only when an intent actually needs the SFU), runs Signaling, and
   * maps SfuError/SignalError to the spoke's normalized {error,message} envelope. Metering fires on leave
   * (fail-open inside metering.ts). The DO never holds media — only state + orchestration.
   */
  async fetch(request: Request): Promise<Response> {
    const intent = new URL(request.url).pathname.replace(/^\/+/, "") as RoomIntent;
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const ctx = body.ctx as SignalContext | undefined;

    try {
      const signaling = new Signaling(this.core, this.buildSfu(), this.meterEnv());
      switch (intent) {
        case "join":
          return Response.json(
            await signaling.join(ctx!, { role: body.role as Role | undefined, offer: body.offer as SessionDescription | undefined }),
            { status: 200 },
          );
        case "publish":
          return Response.json(
            await signaling.publishTrack(ctx!, { tracks: body.tracks as PublishTrack[], offer: body.offer as SessionDescription }),
            { status: 200 },
          );
        case "subscribe":
          return Response.json(
            await signaling.subscribeTrack(ctx!, { trackName: String(body.trackName ?? "") }),
            { status: 200 },
          );
        case "renegotiate":
          return Response.json(
            await signaling.renegotiate(ctx!, { answer: body.answer as SessionDescription }),
            { status: 200 },
          );
        case "leave":
          await signaling.leave(ctx!);
          return Response.json({ ok: true }, { status: 200 });
        default:
          return Response.json({ error: "BAD_REQUEST", message: `unknown realtime intent: ${intent}` }, { status: 400 });
      }
    } catch (e) {
      // SfuError + SignalError both carry {code,status}; anything else → 500.
      const code = (e as { code?: string })?.code ?? "REALTIME_ERROR";
      const status = (e as { status?: number })?.status ?? 500;
      const message = (e as Error)?.message ?? "unexpected error";
      return Response.json({ error: code, message }, { status });
    }
  }

  /** Build the SFU client from env; throws SfuError 503 NOT_CONFIGURED when app creds are unset. */
  private buildSfu(): SfuClient {
    return new SfuClient(
      { appId: this.env.CF_CALLS_APP_ID ?? "", appSecret: this.env.CF_CALLS_APP_SECRET ?? "" },
      this.env.__sfuFetch ?? fetch,
    );
  }

  /** Metering env for the leave-time tap. INERT until GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN are set. */
  private meterEnv(): MeterEmitEnv {
    return { GATEWAY_BASE_URL: this.env.GATEWAY_BASE_URL, WAVE_SERVICE_TOKEN: this.env.WAVE_SERVICE_TOKEN };
  }
}
