// channel.ts — item #5: the channel pub/sub pure engine (spec/realtime.yaml `/realtime/connect`,
// `/realtime/channels/{channel}/{publish,presence,history}`).
//
// A CHANNEL is a lighter-weight sibling of the ROOM plane (room.ts + presence.ts): no SFU media, no
// admission policy, just a named fan-out group a caller subscribes to over a WebSocket and publishes into
// over plain HTTP. Structured exactly like presence.ts — a PURE engine (ChannelHub) over an injected
// SocketRegistry, hermetically testable with in-memory fakes, plus a thin Durable-Object glue module
// (channel-do.ts) that owns the live hibernatable sockets. This file imports nothing from the DO runtime.
//
// Wire contract (server → client frames, per spec/realtime.yaml):
//   welcome  — sent once, right after the WS upgrade: current members + recent history.
//   message  — one published event, fanned out to every subscriber.
//   join     — a new subscriber connected.
//   leave    — a subscriber disconnected.
//   presence — the full, authoritative member list (sent after every join/leave so a client's view can
//              never drift — the SAME "welcome + full resync" idea presence.ts uses for room state).

/** Namespaced channel id, e.g. `stream:abc`, `room:xyz` — matches spec/realtime.yaml `channel` parameter. */
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/;

/** A subscriber-supplied member id (the `as=` query param, or a generated fallback). Deliberately looser
 *  than CHANNEL_ID_PATTERN — it is never used as a storage/billing key, only echoed back in frames. */
export const MEMBER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

// ── Public route shapes (route-dispatch.ts matches against these; kept here, not dispatch-helpers.ts, so
// that module doesn't grow past its size budget for a route family this file already owns the id pattern
// for) ──
/** GET /v1/connect?channel=<id>&as=<member> — WebSocket upgrade (spec/realtime.yaml realtimeConnect). */
export const CHANNEL_CONNECT_PATH = "/v1/connect";
/** POST /v1/channels/{channel}/publish */
export const CHANNEL_PUBLISH_ROUTE = /^\/v1\/channels\/([^/]+)\/publish\/?$/;
/** GET /v1/channels/{channel}/presence */
export const CHANNEL_PRESENCE_ROUTE = /^\/v1\/channels\/([^/]+)\/presence\/?$/;
/** GET /v1/channels/{channel}/history */
export const CHANNEL_HISTORY_ROUTE = /^\/v1\/channels\/([^/]+)\/history\/?$/;

export interface ChannelMember {
  id: string;
}

/** One published event, as it is broadcast + stored in history. */
export interface ChannelEvent {
  id: string;
  ts: number;
  event: string;
  data?: unknown;
}

export type ChannelServerMsg =
  | { type: "welcome"; channel: string; members: ChannelMember[]; history: ChannelEvent[] }
  | { type: "message"; id: string; ts: number; event: string; data?: unknown }
  | { type: "join"; id: string }
  | { type: "leave"; id: string }
  | { type: "presence"; members: ChannelMember[] };

// ── Bounded history ring buffer ──────────────────────────────────────────────────────────────────────
//
// HISTORY_CAP is BOTH the max the DO ever holds in storage AND the max `GET history` can ever return —
// matches spec/realtime.yaml's `limit` parameter (`default: 50, maximum: 50`). A publish beyond the cap
// evicts the oldest event (FIFO ring), so a channel's history storage footprint is O(1), never unbounded.
export const HISTORY_CAP = 50;

export class HistoryRing {
  private buf: ChannelEvent[] = [];
  private readonly cap: number;

  constructor(cap: number = HISTORY_CAP) {
    this.cap = cap > 0 ? cap : HISTORY_CAP;
  }

  /** Rehydrate a ring from a persisted array (DO storage), capping defensively even if the stored array
   *  somehow exceeds `cap` (e.g. a lower cap shipped later). */
  static fromArray(events: ChannelEvent[] | undefined, cap: number = HISTORY_CAP): HistoryRing {
    const ring = new HistoryRing(cap);
    for (const e of (events ?? []).slice(-ring.cap)) ring.buf.push(e);
    return ring;
  }

  push(e: ChannelEvent): void {
    this.buf.push(e);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  /** Most recent `limit` events (oldest-first), clamped to [0, cap]. Omitted `limit` returns the full ring. */
  list(limit?: number): ChannelEvent[] {
    if (limit == null) return this.buf.slice();
    const n = Math.max(0, Math.min(limit, this.cap));
    return this.buf.slice(Math.max(0, this.buf.length - n));
  }

  /** The raw backing array, for persistence (DO storage.put). */
  snapshot(): ChannelEvent[] {
    return this.buf.slice();
  }
}

// ── Pure hub over an injected socket registry ──────────────────────────────────────────────────────

export interface ChannelConn {
  readonly id: string;
  send(msg: ChannelServerMsg): void;
  close(code: number, reason: string): void;
}

export interface SocketRegistry {
  all(): ChannelConn[];
}

/**
 * ChannelHub — the pure pub/sub logic, decoupled from the DO runtime. All I/O goes through the injected
 * SocketRegistry + HistoryRing, so it is fully unit-testable with in-memory fakes (mirrors PresenceHub).
 */
export class ChannelHub {
  constructor(
    private readonly registry: SocketRegistry,
    private readonly history: HistoryRing,
  ) {}

  /** Distinct member ids currently subscribed (a member may hold more than one socket; the presence view
   *  de-dupes by id, same as a chat-room member list). */
  members(): ChannelMember[] {
    const seen = new Set<string>();
    const out: ChannelMember[] = [];
    for (const conn of this.registry.all()) {
      if (!seen.has(conn.id)) {
        seen.add(conn.id);
        out.push({ id: conn.id });
      }
    }
    return out;
  }

  /** Send the initial snapshot to a just-connected socket: current members + recent history. */
  welcome(conn: ChannelConn, channel: string): void {
    conn.send({ type: "welcome", channel, members: this.members(), history: this.history.list() });
  }

  /** Announce a new subscriber to every OTHER socket, then resync the full member list to everyone. */
  announceJoin(conn: ChannelConn): void {
    for (const other of this.registry.all()) {
      if (other.id !== conn.id) other.send({ type: "join", id: conn.id });
    }
    this.broadcastPresence();
  }

  /** Announce a departing subscriber to every OTHER socket, then resync the full member list. */
  announceLeave(conn: ChannelConn): void {
    for (const other of this.registry.all()) {
      if (other.id !== conn.id) other.send({ type: "leave", id: conn.id });
    }
    this.broadcastPresence();
  }

  /** Fan the authoritative member list out to every subscriber. */
  broadcastPresence(): void {
    const members = this.members();
    for (const conn of this.registry.all()) conn.send({ type: "presence", members });
  }

  /**
   * Publish one event to every subscriber: records it into the bounded history ring FIRST (so a client
   * that reconnects immediately after still sees it), then fans out a `message` frame. Returns the built
   * event (carries the minted id/ts) and the subscriber count it reached.
   */
  publish(event: string, data: unknown): { event: ChannelEvent; delivered: number } {
    const built: ChannelEvent = { id: crypto.randomUUID(), ts: Date.now(), event, data };
    this.history.push(built);
    const subs = this.registry.all();
    for (const conn of subs) conn.send({ type: "message", id: built.id, ts: built.ts, event: built.event, data: built.data });
    return { event: built, delivered: subs.length };
  }
}
