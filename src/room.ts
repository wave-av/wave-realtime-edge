// P5.1 — Room Durable Object. One DO instance per room; SSOT for room state: org-scoped participant
// set, track registry (CF Realtime track ids), per-participant grants, join/leave + TTL, registry
// reconcile vs CF Realtime's 30s inactivity GC (design §4), and admission policy (P5.2-auth).
// Exposes a typed internal API the signaling layer calls (joinRoom/leaveRoom/register/reconcile);
// the DO holds state, not network. Tests inject storage, so no live DO runtime is needed.

import { SfuClient, SfuError } from "./sfu.js";
import type { SessionDescription } from "./sfu.js";
import { Signaling } from "./signaling.js";
import type { SignalContext, PublishTrack } from "./signaling.js";
import type { ParticipantSessionUsage, MeterEmitEnv } from "./metering.js";
import type { EventEmitEnv } from "./event-emitter.js";
import type { EncoderKind, RecordingEncoder } from "./encoders/encoder.js";
import { RoomRecording } from "./room-recording.js";
import {
  acceptPresenceSocket,
  broadcastPresence,
  onPresenceMessage,
  type PresenceDOState,
} from "./presence.js";

/** CF Realtime GCs a track after 30s of inactivity (design §4). Registry reconcile uses this. */
export const TRACK_GC_MS = 30_000;
/** Default room lifetime once empty/idle, after which the room is expired. */ export const DEFAULT_ROOM_TTL_MS = 30 * 60_000; // 30 min

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

/** The set of known room types — used to validate a `type` before it sets a policy (no empty policies). */
export const ROOM_TYPES = Object.keys(POLICY_DEFAULTS) as RoomType[];
export function isRoomType(t: unknown): t is RoomType {
  return typeof t === "string" && (ROOM_TYPES as string[]).includes(t);
}

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
  /**
   * Participants a host has admitted from the waiting room but who have not yet been seated (their
   * retry join is still in flight). An admitted pid bypasses the knock check exactly once — the marker
   * is consumed when joinRoom seats them. Without this, a knock-mode admissionCheck re-queues the SAME
   * admitted participant forever (admit → retry → waiting → …).
   */
  admitted: string[];
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
  return { config: null, participants: {}, tracks: {}, emptyAt: Date.now(), policy: null, waiting: {}, banned: [], admitted: [] };
}

/**
 * Normalize a loaded state record so code added after the original schema can rely on the admission
 * fields being present. Records written before this change lack policy/waiting/banned/admitted; without
 * this, `s.banned.includes(...)` / `delete s.waiting[...]` / `s.admitted.includes(...)` throw. Mutates
 * and returns the same object (so the cached instance is normalized too).
 */
function normalizeState(s: RoomState): RoomState {
  if (s.policy === undefined) s.policy = null;
  if (!s.waiting) s.waiting = {};
  if (!Array.isArray(s.banned)) s.banned = [];
  if (!Array.isArray(s.admitted)) s.admitted = [];
  if (!s.participants) s.participants = {};
  if (!s.tracks) s.tracks = {};
  return s;
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
    this.state = normalizeState((await this.storage.get<RoomState>(STATE_KEY)) ?? emptyState());
    return this.state;
  }

  private async save(s: RoomState): Promise<void> {
    this.state = s;
    await this.storage.put(STATE_KEY, s);
  }

  /** Bind the room to an org on first use. Idempotent for the SAME (roomId, org); rejects a mismatch.
   *  If `type` is provided and no policy is set yet, applies the corresponding POLICY_DEFAULTS entry. */
  async ensureRoom(config: RoomConfig): Promise<RoomConfig> {
    // Validate the room type BEFORE it can set a policy: an unknown type would otherwise index
    // POLICY_DEFAULTS as undefined and produce an empty (truthy) policy missing mode/locked/capacity.
    if (config.type !== undefined && !isRoomType(config.type)) {
      throw new SfuError("BAD_ROOM_TYPE", `unknown room type: ${String(config.type)}`, 400);
    }
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
    // Seated now: clear any waiting entry and consume the admitted marker (one-shot bypass).
    delete s.waiting[p.participantId];
    s.admitted = s.admitted.filter((id) => id !== p.participantId);
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
    p: { participantId: string; role?: Role; anon?: boolean },
  ): Promise<WaitingResult | null> {
    const s = await this.load();
    if (!s.config) throw new SfuError("ROOM_NOT_BOUND", "room is not bound to an org", 409);
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org may not join this room", 403);
    if (!s.policy) return null; // no policy → proceed

    if (s.banned.includes(p.participantId)) {
      throw new SfuError("PARTICIPANT_BANNED", "participant is banned from this room", 403);
    }
    // Enforce allowAnonymous: an anonymous (no WAVE account) joiner is refused before any seat/queue.
    if (p.anon === true && s.policy.allowAnonymous === false) {
      throw new SfuError("ANONYMOUS_FORBIDDEN", "anonymous participants are not allowed in this room", 403);
    }
    if (s.policy.locked) {
      throw new SfuError("ROOM_LOCKED", "room is locked — no new participants allowed", 423);
    }
    const occupancy = Object.keys(s.participants).length;
    if (s.policy.capacity !== null && occupancy >= s.policy.capacity) {
      throw new SfuError("ROOM_FULL", "room has reached its participant capacity", 429);
    }
    const role: Role = p.role ?? s.policy.defaultRole;
    if (s.policy.mode === "knock") {
      // Hosts admit others — they themselves must never wait (a first host would deadlock the room).
      if (role === "host") return null;
      // An already-admitted pid passes through exactly once (the marker is consumed when seated by
      // joinRoom). Without this, admit() → retry join() would re-queue the same participant forever.
      if (s.admitted.includes(p.participantId)) return null;
      s.waiting[p.participantId] = { participantId: p.participantId, role, requestedAt: this.now() };
      s.emptyAt = null; // a pending knock keeps the room active (see isExpired)
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
    // Remove from waiting and mark admitted — signaling will call joinRoom to actually seat them, and
    // the admitted marker lets their retry join() bypass the knock check (consumed on seat).
    delete s.waiting[participantId];
    if (!s.admitted.includes(participantId)) s.admitted.push(participantId);
    s.emptyAt = null; // an admitted-but-not-yet-seated pid keeps the room active (see isExpired)
    await this.save(s);
    return entry;
  }

  /** Deny and remove a participant from the waiting room. No-op if they are not waiting. */
  async deny(participantId: string): Promise<void> {
    const s = await this.load();
    if (!s.waiting[participantId]) return;
    delete s.waiting[participantId];
    s.admitted = s.admitted.filter((id) => id !== participantId);
    // If that was the last reason to keep the room alive, start the TTL clock.
    if (this.isIdle(s) && s.emptyAt == null) s.emptyAt = this.now();
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
    // Reject anything but null or a non-negative safe integer: -1 makes every join look full, and
    // NaN/floats compare inconsistently in the capacity check.
    if (n !== null && (!Number.isSafeInteger(n) || n < 0)) {
      throw new SfuError("BAD_CAPACITY", "capacity must be null or a non-negative integer", 400);
    }
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
    // A room is only "empty" when it has no seated participants AND no pending knocks/admits — a host
    // who steps away while people are knocking must not have the room GC'd out from under them.
    if (!this.isIdle(s)) return false;
    return this.now() >= s.emptyAt + (s.config.ttlMs ?? DEFAULT_ROOM_TTL_MS);
  }

  /** True when the room has no seated participants AND no pending waiting/admitted queues. */
  private isIdle(s: RoomState): boolean {
    return Object.keys(s.participants).length === 0 &&
      Object.keys(s.waiting).length === 0 &&
      s.admitted.length === 0;
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

/** Minimal DO runtime shape (avoids a hard dependency on cloudflare:workers in this skeleton). The
 *  hibernation WebSocket API is OPTIONAL so tests construct a RoomDO with just storage; presence (P4) uses
 *  it only when the live DO runtime provides it, and fails closed (503) otherwise. */
interface DurableObjectStateLike {
  storage: RoomStorage;
  acceptWebSocket?(ws: WebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): WebSocket[];
}

/**
 * Env the RoomDO reads (referenced, never valued here): CF_CALLS_APP_ID/_SECRET = CF Realtime SFU
 * creds (unset → join fails closed 503 REALTIME_NOT_CONFIGURED); GATEWAY_BASE_URL/WAVE_SERVICE_TOKEN
 * = metering tap (both unset → INERT). __sfuFetch/__meterFetch are TEST-ONLY injectables.
 */
export interface RoomDOEnv {
  CF_CALLS_APP_ID?: string;
  CF_CALLS_APP_SECRET?: string;
  GATEWAY_BASE_URL?: string;
  WAVE_SERVICE_TOKEN?: string;
  // ── LK-rip #46 SFU event emitter (DORMANT until cutover). DO forwards to Signaling → WSC Argus
  // ingest ONLY when WAVE_REALTIME_EVENTS_EMIT="1" AND the shared HMAC secret is set (else inert). ──
  WAVE_REALTIME_EVENTS_EMIT?: string; // "1" arms; absent/anything-else → inert
  WAVE_REALTIME_WEBHOOK_SECRET?: string; // shared HMAC secret (Doppler, both sides); absent → inert
  WSC_EVENTS_URL?: string; // ingest URL override (var); default = prod contract URL
  // ── RT-R9 raw-SFU recording (DORMANT until ◆-armed). Encoder built lazily via selectEncoder(env) on
  // first publish; RT_ENCODER stays "managed" → no-op. Only ◆-armed container + RT_RECORD="1" + creds taps. ──
  RT_RECORDINGS?: R2Bucket; // SKIP sink the container tap writes the one canonical object into
  RT_ENCODER?: EncoderKind; // selector; default "managed" (live). "container" = raw-SFU (◆).
  RT_RECORD?: string; // "1" to arm recording at all (default OFF — fully inert)
  CF_API_TOKEN?: string; // managed (C) RTK REST bearer (carried through for selectEncoder)
  RTK_APP_ID?: string; // managed (C) RTK app id
  CF_ACCOUNT_ID?: string; // managed (C) account id
  /** test-only: injected SFU HTTP client (defaults to global fetch). The metering tap uses global fetch. */
  __sfuFetch?: typeof fetch;
  /** test-only: injected recording encoder (defaults to selectEncoder(env)). Lets orchestration tests drive a fake. */
  __recordingEncoder?: RecordingEncoder;
}

/** The realtime intents the worker entry forwards to the DO's fetch() (last path segment). `presence` is a
 *  WebSocket upgrade (E-ROOMS P4), not a JSON intent — it is handled before the JSON body is parsed. */
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
  private readonly recording: RoomRecording;
  private readonly doState: DurableObjectStateLike;
  /** Monotonic presence broadcast version (conflict-free client ordering). Seeded lazily from storage so it
   *  survives a DO eviction; incremented per broadcast. Null until first read. */
  private presenceVer: number | null = null;

  constructor(state: DurableObjectStateLike, env?: RoomDOEnv) {
    this.core = new RoomCore(state.storage);
    this.env = env ?? {};
    this.recording = new RoomRecording(this.env, state.storage);
    this.doState = state;
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
  /** RT-R9: feed ONE decoded WS media frame to the tap for (sessionId, trackName). DORMANT for managed. */
  feedRecorderFrame(sessionId: string, trackName: string, frame: Uint8Array) {
    return this.recording.feedFrame(sessionId, trackName, frame);
  }

  /**
   * Control-plane surface. The worker forwards `POST .../<intent>` here with a JSON body carrying the
   * already-validated context (org/room/participantId) + the intent payload. Builds the SfuClient lazily
   * (so an unconfigured app fails closed only when an intent actually needs the SFU), runs Signaling, and
   * maps SfuError/SignalError to the spoke's normalized {error,message} envelope. Metering fires on leave
   * (fail-open inside metering.ts). The DO never holds media — only state + orchestration.
   */
  async fetch(request: Request): Promise<Response> {
    const intent = new URL(request.url).pathname.replace(/^\/+/, "") as RoomIntent | "recorder-frame" | "presence";
    // RT-R9: the Worker recorder route forwards one decoded WS media frame as a raw binary POST. DORMANT for
    // managed (feedFrame is a no-op when no container tap is held). Fail-open: always 200/204, never throws.
    if (intent === "recorder-frame") {
      try {
        const u = new URL(request.url);
        const sessionId = u.searchParams.get("sessionId") ?? "";
        const trackName = u.searchParams.get("trackName") ?? "";
        const buf = new Uint8Array(await request.arrayBuffer());
        if (sessionId && trackName && buf.length > 0) await this.recording.feedFrame(sessionId, trackName, buf);
      } catch {
        /* fail-open */
      }
      return new Response(null, { status: 204 });
    }
    // E-ROOMS P4 (#73): client presence/state-sync + data channel. The worker forwards the WS upgrade here
    // (identity in the query, gateway-validated) and the DO OWNS the hibernatable socket. Handled before the
    // JSON body parse — an upgrade GET carries no body.
    if (intent === "presence") {
      return this.acceptPresence(request);
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const ctx = body.ctx as SignalContext | undefined;

    try {
      const signaling = new Signaling(this.core, this.buildSfu(), this.meterEnv(), this.recording, this.eventEnv());
      switch (intent) {
        case "join": {
          const res = await signaling.join(ctx!, { role: body.role as Role | undefined, offer: body.offer as SessionDescription | undefined });
          await this.emitPresence();
          return Response.json(res, { status: 200 });
        }
        case "publish": {
          const res = await signaling.publishTrack(ctx!, { tracks: body.tracks as PublishTrack[], offer: body.offer as SessionDescription });
          await this.emitPresence();
          return Response.json(res, { status: 200 });
        }
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
          await this.emitPresence();
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

  // ── E-ROOMS P4 (#73): presence / state-sync / data channel over a hibernatable WebSocket ──

  private static readonly PRESENCE_VER_KEY = "presence:ver";

  /** Complete a presence WS upgrade: the DO owns the hibernatable socket (a broadcast reaches every subscriber
   *  + the socket survives eviction). Fails closed (503) without the hibernation API. Identity is in the
   *  gateway-validated query (participantId + whitelisted role); re-validated here (never trust transport). */
  private async acceptPresence(request: Request): Promise<Response> {
    if (!this.doState.acceptWebSocket || !this.doState.getWebSockets) {
      return Response.json(
        { error: "REALTIME_NOT_CONFIGURED", message: "presence requires a Durable Object runtime" },
        { status: 503 },
      );
    }
    const u = new URL(request.url);
    const participantId = u.searchParams.get("participantId") ?? "";
    if (!participantId) {
      return Response.json({ error: "BAD_REQUEST", message: "presence requires participantId" }, { status: 400 });
    }
    const roleRaw = u.searchParams.get("role") ?? "viewer";
    const role: Role = roleRaw === "host" || roleRaw === "speaker" || roleRaw === "viewer" ? roleRaw : "viewer";
    const snapshot = await this.core.snapshot();
    return acceptPresenceSocket(this.doState as PresenceDOState, { participantId, role }, snapshot, await this.presenceVersion());
  }

  /** Hibernation handler — the runtime calls this per inbound frame on a presence socket. Delegates to the
   *  pure hub (ping→pong, data→fan-out to others, invalid→typed error + abuse guard). Fully guarded: a
   *  handler that throws would error the live socket, so a defect here must never escape. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    try {
      onPresenceMessage(this.doState as PresenceDOState, ws, message);
    } catch {
      /* a presence-message defect must never crash the socket / the live media the DO also serves */
    }
  }

  /** Broadcast the authoritative view to every presence subscriber after a room mutation. No-op when the
   *  runtime has no hibernation API (tests) — presence is purely additive to the existing intents. */
  private async emitPresence(): Promise<void> {
    if (!this.doState.getWebSockets) return;
    const snapshot = await this.core.snapshot();
    broadcastPresence(this.doState as PresenceDOState, snapshot, await this.bumpPresenceVersion());
  }

  /** Seed the version from storage exactly once (survives a DO eviction) — the only await in the version path. */
  private async seedPresenceVersion(): Promise<void> {
    if (this.presenceVer == null) this.presenceVer = (await this.doState.storage.get<number>(RoomDO.PRESENCE_VER_KEY)) ?? 0;
  }

  /** Current monotonic version (welcome uses it as-is). */
  private async presenceVersion(): Promise<number> {
    await this.seedPresenceVersion();
    return this.presenceVer ?? 0;
  }

  /** Increment + persist the version. The read-modify-write is synchronous (no await between read and write),
   *  so two concurrent broadcasts can never collide on the same version. */
  private async bumpPresenceVersion(): Promise<number> {
    await this.seedPresenceVersion();
    const next = (this.presenceVer ?? 0) + 1;
    this.presenceVer = next;
    await this.doState.storage.put(RoomDO.PRESENCE_VER_KEY, next);
    return next;
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

  /** LK-rip #46 event-emitter env. DORMANT until WAVE_REALTIME_EVENTS_EMIT="1" + the shared secret are set. */
  private eventEnv(): EventEmitEnv {
    return {
      WAVE_REALTIME_EVENTS_EMIT: this.env.WAVE_REALTIME_EVENTS_EMIT,
      WAVE_REALTIME_WEBHOOK_SECRET: this.env.WAVE_REALTIME_WEBHOOK_SECRET,
      WSC_EVENTS_URL: this.env.WSC_EVENTS_URL,
    };
  }
}
