// room-state.ts — the room's LEAF data model: shared types (Role/RoomType/Participant/RoomTrack/RoomState/…),
// the admission-policy defaults, and the pure state helpers (emptyState/normalizeState). Split out of room.ts so
// the DO wrapper + the RoomCore state machine each stay under the file-size gate (file-size-two-tier-gate). This
// module imports NOTHING from room.ts (or room-core) — it is the leaf of the room module graph, so there is no
// import cycle. room.ts re-exports everything here (`export *`) for back-compat, so existing importers of
// `./room.js` are unaffected.

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

export const POLICY_DEFAULTS: Record<RoomType, AdmissionPolicy> = {
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

export const STATE_KEY = "room:state";
export const ROLE_DEFAULT_PERMS: Record<Role, Permissions> = {
  host: { canPublish: true, canSubscribe: true },
  speaker: { canPublish: true, canSubscribe: true },
  viewer: { canPublish: false, canSubscribe: true },
};

export function emptyState(): RoomState {
  return { config: null, participants: {}, tracks: {}, emptyAt: Date.now(), policy: null, waiting: {}, banned: [], admitted: [] };
}

/**
 * Normalize a loaded state record so code added after the original schema can rely on the admission
 * fields being present. Records written before this change lack policy/waiting/banned/admitted; without
 * this, `s.banned.includes(...)` / `delete s.waiting[...]` / `s.admitted.includes(...)` throw. Mutates
 * and returns the same object (so the cached instance is normalized too).
 */
export function normalizeState(s: RoomState): RoomState {
  if (s.policy === undefined) s.policy = null;
  if (!s.waiting) s.waiting = {};
  if (!Array.isArray(s.banned)) s.banned = [];
  if (!Array.isArray(s.admitted)) s.admitted = [];
  if (!s.participants) s.participants = {};
  if (!s.tracks) s.tracks = {};
  return s;
}
