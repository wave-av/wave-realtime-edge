// P5.1 — Room Durable Object skeleton (per-room state, no signaling/auth).
//
// One Durable Object instance per room. Single source of truth for room state:
//   • participant set (org-scoped — a room is bound to ONE org)
//   • published/subscribed track registry keyed by CF Realtime track ids
//   • per-participant permissions (grants)
//   • join/leave handlers + a room TTL
//   • registry reconcile against CF Realtime's 30s inactivity GC (design §4)
//
// Signaling and auth are DELIBERATELY OUT (P5.2). This file exposes a typed *internal API* the future
// signaling layer will call (joinRoom / leaveRoom / register tracks / reconcile). The DO holds state;
// it does not talk to the SFU or the network here. Tests inject the storage, so no live DO runtime is
// needed (the class is also wired as a real DurableObject for when bindings land).

import { SfuError } from "./sfu.js";

/** CF Realtime GCs a track after 30s of inactivity (design §4). Registry reconcile uses this. */
export const TRACK_GC_MS = 30_000;
/** Default room lifetime once empty/idle, after which the room is considered expired. */
export const DEFAULT_ROOM_TTL_MS = 30 * 60_000; // 30 min

export type Role = "host" | "speaker" | "viewer";

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
}

export interface RoomState {
  config: RoomConfig | null;
  participants: Record<string, Participant>;
  tracks: Record<string, RoomTrack>;
  /** Set when the room becomes empty; room expires at emptyAt + ttl. Null while occupied. */
  emptyAt: number | null;
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
  return { config: null, participants: {}, tracks: {}, emptyAt: Date.now() };
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

  /** Bind the room to an org on first use. Idempotent for the SAME (roomId, org); rejects a mismatch. */
  async ensureRoom(config: RoomConfig): Promise<RoomConfig> {
    const s = await this.load();
    if (s.config) {
      if (s.config.org !== config.org || s.config.roomId !== config.roomId) {
        // Per-org isolation invariant: a room bound to org A can never be reused for org B.
        throw new SfuError("ROOM_ORG_MISMATCH", "room is bound to a different org/room", 409);
      }
      return s.config;
    }
    s.config = { roomId: config.roomId, org: config.org, ttlMs: config.ttlMs ?? DEFAULT_ROOM_TTL_MS };
    await this.save(s);
    return s.config;
  }

  /**
   * Join a participant. The room MUST already be bound to `org` (ensureRoom) and the join's org must
   * match — a token for org A can never join org B's room (design §4 isolation invariant).
   */
  async joinRoom(
    org: string,
    p: { participantId: string; sessionId: string; role?: Role; permissions?: Permissions },
  ): Promise<Participant> {
    const s = await this.load();
    if (!s.config) throw new SfuError("ROOM_NOT_BOUND", "room is not bound to an org", 409);
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org may not join this room", 403);
    if (!p.participantId || !p.sessionId) throw new SfuError("BAD_REQUEST", "participantId and sessionId are required", 400);

    const role: Role = p.role ?? "speaker";
    const participant: Participant = {
      participantId: p.participantId,
      sessionId: p.sessionId,
      role,
      permissions: p.permissions ?? ROLE_DEFAULT_PERMS[role],
      joinedAt: this.now(),
    };
    s.participants[p.participantId] = participant;
    s.emptyAt = null; // occupied
    await this.save(s);
    return participant;
  }

  /** Leave a participant: remove them and GC every track owned by their session. */
  async leaveRoom(org: string, participantId: string): Promise<void> {
    const s = await this.load();
    if (!s.config) return; // nothing to leave
    if (s.config.org !== org) throw new SfuError("ROOM_ORG_MISMATCH", "org mismatch", 403);
    const participant = s.participants[participantId];
    if (!participant) return; // idempotent leave
    delete s.participants[participantId];
    for (const [name, t] of Object.entries(s.tracks)) {
      if (t.sessionId === participant.sessionId) delete s.tracks[name];
    }
    if (Object.keys(s.participants).length === 0) s.emptyAt = this.now();
    await this.save(s);
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
 * RoomDO — the Durable Object wrapper. Holds a RoomCore over the DO's own storage. Signaling/auth
 * (P5.2) will add a `fetch`/RPC surface that calls these methods; for now this exposes the typed
 * internal API directly. Registered in wrangler config when bindings land (additive, not in P5.1
 * deploy scope).
 */
export class RoomDO {
  private readonly core: RoomCore;

  constructor(state: DurableObjectStateLike, _env?: unknown) {
    this.core = new RoomCore(state.storage);
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
}
