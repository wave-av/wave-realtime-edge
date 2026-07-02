// presence.ts — E-ROOMS P4 (LK-rip #73): client-facing presence, state-sync, and a data channel.
//
// The RoomDO is the single source of truth for room state, but before this module clients could only POST
// intents and POLL for state. This adds a hibernatable-WebSocket channel the RoomDO owns: a client
// subscribes and receives (a) a `welcome` snapshot on connect, (b) an authoritative `state` view on every
// room mutation (a monotonic `version` gives conflict-free ordering — a client drops any frame older than
// the last it applied), and (c) a `data` channel — a client `data` message fans out to the OTHER
// participants. Client-safe by construction: the projected view strips SFU sessionIds, the ban list, and the
// admitted markers; the waiting list is shown ONLY to hosts.
//
// Structured as a PURE engine (projectRoomView / parseInbound / PresenceHub over an injected SocketRegistry —
// hermetically tested, no DO runtime) plus a THIN Durable-Object glue (WebSocketPair + acceptWebSocket
// hibernation). The RoomDO delegators stay one-liners so room.ts keeps its size budget.
//
// Hardening baseline ([[realtime-socket-hardening-baseline]]): text-JSON only (media never flows here), a
// per-message byte cap, a message-type allowlist, and a per-participant violation counter that closes a
// misbehaving socket so it cannot flood the room.

import type { RoomState, Role, WaitingEntry, TrackKind } from "./room.js";

// ── Client-safe projection ───────────────────────────────────────────────────────────────────────

export interface ViewParticipant {
  participantId: string;
  role: Role;
  publishedAudio: boolean;
  publishedVideo: boolean;
}

export interface ViewTrack {
  trackName: string;
  participantId: string;
  kind: TrackKind;
}

export interface ViewPolicy {
  mode: "knock" | "auto";
  locked: boolean;
  capacity: number | null;
}

/** The client-facing room snapshot. Deliberately excludes SFU sessionIds, the ban list, and admitted
 *  markers (internal control state); `waiting` is populated ONLY for host viewers (moderation UI). */
export interface RoomView {
  roomId: string | null;
  occupancy: number;
  participants: ViewParticipant[];
  tracks: ViewTrack[];
  policy: ViewPolicy | null;
  waitingCount: number;
  waiting?: WaitingEntry[];
}

/** Project the SSOT RoomState into a client-safe RoomView. Pure. */
export function projectRoomView(state: RoomState, opts: { includeWaiting: boolean }): RoomView {
  const participants: ViewParticipant[] = Object.values(state.participants).map((p) => ({
    participantId: p.participantId,
    role: p.role,
    publishedAudio: p.publishedAudio === true,
    publishedVideo: p.publishedVideo === true,
  }));
  const tracks: ViewTrack[] = Object.values(state.tracks).map((t) => ({
    trackName: t.trackName,
    participantId: t.participantId,
    kind: t.kind,
  }));
  const waitingEntries = Object.values(state.waiting);
  const view: RoomView = {
    roomId: state.config?.roomId ?? null,
    occupancy: participants.length,
    participants,
    tracks,
    policy: state.policy
      ? { mode: state.policy.mode, locked: state.policy.locked, capacity: state.policy.capacity }
      : null,
    waitingCount: waitingEntries.length,
  };
  if (opts.includeWaiting) view.waiting = waitingEntries;
  return view;
}

// ── Wire messages ────────────────────────────────────────────────────────────────────────────────

export type PresenceServerMsg =
  | { type: "welcome"; version: number; view: RoomView }
  | { type: "state"; version: number; view: RoomView }
  | { type: "data"; from: string; data: unknown }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

export type PresenceInboundMsg = { type: "ping" } | { type: "data"; data: unknown };

export type InboundResult =
  | { ok: true; msg: PresenceInboundMsg }
  | { ok: false; code: string; message: string };

/** Default per-message byte cap for the presence data channel (control/chat/reactions, not media). */
export const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * Validate one inbound client frame. Text-JSON only (a binary frame is rejected — media never flows on the
 * presence socket); byte length (not code-unit length) is bounded so a multi-byte payload cannot exceed the
 * cap; the message type must be on the allowlist ("ping" | "data").
 */
export function parseInbound(raw: unknown, maxBytes: number = DEFAULT_MAX_MESSAGE_BYTES): InboundResult {
  if (typeof raw !== "string") {
    return { ok: false, code: "BAD_FRAME", message: "presence channel accepts text JSON frames only" };
  }
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > maxBytes) {
    return { ok: false, code: "MESSAGE_TOO_LARGE", message: `message exceeds ${maxBytes} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "BAD_JSON", message: "message is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, code: "BAD_MESSAGE", message: "message must be a JSON object" };
  }
  const type = (parsed as { type?: unknown }).type;
  if (type === "ping") return { ok: true, msg: { type: "ping" } };
  if (type === "data") {
    if (!("data" in parsed)) {
      return { ok: false, code: "BAD_MESSAGE", message: "data message requires a `data` field" };
    }
    return { ok: true, msg: { type: "data", data: (parsed as { data: unknown }).data } };
  }
  return { ok: false, code: "UNKNOWN_TYPE", message: `unknown message type: ${String(type)}` };
}

// ── Pure hub over an injected socket registry ──────────────────────────────────────────────────────

export interface PresenceConn {
  readonly participantId: string;
  readonly role: Role;
  send(msg: PresenceServerMsg): void;
  close(code: number, reason: string): void;
}

export interface SocketRegistry {
  all(): PresenceConn[];
}

export interface PresenceHubOptions {
  maxMessageBytes?: number;
  /** Close a socket after this many protocol violations (abuse/backpressure guard). */
  maxViolations?: number;
}

/**
 * PresenceHub — the pure state-sync + data-channel logic, decoupled from the DO runtime. All I/O goes
 * through the injected SocketRegistry, so it is fully testable with in-memory fakes.
 */
export class PresenceHub {
  private readonly maxBytes: number;
  private readonly maxViolations: number;
  private readonly violations = new Map<string, number>();

  constructor(
    private readonly registry: SocketRegistry,
    opts: PresenceHubOptions = {},
  ) {
    this.maxBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.maxViolations = opts.maxViolations ?? 8;
  }

  /** Send the initial authoritative snapshot to a just-connected socket. */
  welcome(conn: PresenceConn, state: RoomState, version: number): void {
    conn.send({ type: "welcome", version, view: this.viewFor(conn, state) });
  }

  /** Fan the authoritative view out to every subscriber, projected per-role. Called after a mutation. */
  broadcast(state: RoomState, version: number): void {
    for (const conn of this.registry.all()) {
      conn.send({ type: "state", version, view: this.viewFor(conn, state) });
    }
  }

  /**
   * Handle one inbound frame from `conn`: ping→pong; data→fan out to the OTHER participants (never echoed
   * to the sender); anything invalid → a typed error frame + a violation tick. The socket is closed once
   * maxViolations is reached. Returns true if the socket was closed.
   */
  handle(conn: PresenceConn, raw: unknown): boolean {
    const parsed = parseInbound(raw, this.maxBytes);
    if (!parsed.ok) {
      conn.send({ type: "error", code: parsed.code, message: parsed.message });
      return this.tickViolation(conn);
    }
    if (parsed.msg.type === "ping") {
      conn.send({ type: "pong" });
      return false;
    }
    const out: PresenceServerMsg = { type: "data", from: conn.participantId, data: parsed.msg.data };
    for (const other of this.registry.all()) {
      if (other.participantId !== conn.participantId) other.send(out);
    }
    return false;
  }

  private viewFor(conn: PresenceConn, state: RoomState): RoomView {
    return projectRoomView(state, { includeWaiting: conn.role === "host" });
  }

  private tickViolation(conn: PresenceConn): boolean {
    const n = (this.violations.get(conn.participantId) ?? 0) + 1;
    this.violations.set(conn.participantId, n);
    if (n >= this.maxViolations) {
      conn.close(1008, "too many protocol violations");
      return true;
    }
    return false;
  }
}

// ── Durable-Object glue (thin) ─────────────────────────────────────────────────────────────────────

const PRESENCE_TAG = "presence";

/** The subset of the DO state the presence glue needs — the hibernation WebSocket API. Kept optional on the
 *  DO's state-like (room.ts) so tests that don't exercise presence can construct a RoomDO with just storage. */
export interface PresenceDOState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface PresenceAttachment {
  participantId: string;
  role: Role;
}

export interface PresenceParticipant {
  participantId: string;
  role: Role;
}

/** Wrap one hibernation socket (identity from its attachment) as a PresenceConn. */
function wsConn(ws: WebSocket, att: PresenceAttachment): PresenceConn {
  return {
    participantId: att.participantId,
    role: att.role,
    send(msg) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* socket is closing — drop */
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
  };
}

/** Wrap the DO's live presence sockets as a SocketRegistry (identity read from each socket's attachment). */
export function doSocketRegistry(state: PresenceDOState): SocketRegistry {
  return {
    all(): PresenceConn[] {
      const conns: PresenceConn[] = [];
      for (const ws of state.getWebSockets(PRESENCE_TAG)) {
        const att = safeAttachment(ws);
        if (att) conns.push(wsConn(ws, att));
      }
      return conns;
    },
  };
}

function safeAttachment(ws: WebSocket): PresenceAttachment | null {
  try {
    const att = ws.deserializeAttachment() as PresenceAttachment | null;
    return att && typeof att.participantId === "string" ? att : null;
  } catch {
    return null;
  }
}

/**
 * Complete a presence WebSocket upgrade on the RoomDO: pair the socket, persist the participant identity as
 * the socket's hibernation attachment (survives a DO eviction), register it under the presence tag, send the
 * welcome snapshot, and return the 101. `WebSocketPair` is referenced off globalThis so unit tests can stub
 * it; a runtime without it fails closed (503). Some runtimes (the node test env) reject a 101 in the Response
 * ctor — the fallback returns 200 with the same webSocket, matching the recorder/agent WS routes.
 */
export function acceptPresenceSocket(
  state: PresenceDOState,
  participant: PresenceParticipant,
  roomState: RoomState,
  version: number,
): Response {
  const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
  if (!WSP) {
    return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
  }
  const pair = new WSP();
  const client = (pair as unknown as Record<string, WebSocket>)[0];
  const server = (pair as unknown as Record<string, WebSocket>)[1];
  const att: PresenceAttachment = { participantId: participant.participantId, role: participant.role };
  try {
    server.serializeAttachment(att);
  } catch {
    /* attachment unsupported on some runtimes — welcome below still carries identity via the conn */
  }
  state.acceptWebSocket(server, [PRESENCE_TAG]);
  wsConn(server, att).send({
    type: "welcome",
    version,
    view: projectRoomView(roomState, { includeWaiting: participant.role === "host" }),
  });
  try {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  } catch {
    return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }
}

/** Handle one hibernation `webSocketMessage`: resolve the sender from its attachment and run the hub. An
 *  unidentified socket (no/foreign attachment) is closed — it can never have been a valid presence join. */
export function onPresenceMessage(
  state: PresenceDOState,
  ws: WebSocket,
  message: string | ArrayBuffer,
  opts?: PresenceHubOptions,
): void {
  const att = safeAttachment(ws);
  if (!att) {
    try {
      ws.close(1008, "unidentified presence socket");
    } catch {
      /* already closed */
    }
    return;
  }
  const hub = new PresenceHub(doSocketRegistry(state), opts ?? {});
  // A binary frame arrives as ArrayBuffer; parseInbound rejects it (text-JSON only) with BAD_FRAME.
  hub.handle(wsConn(ws, att), message);
}

/** Broadcast the authoritative room view to every connected presence socket. No-op when the runtime has no
 *  hibernation API (tests / no live sockets). */
export function broadcastPresence(
  state: PresenceDOState,
  roomState: RoomState,
  version: number,
  opts?: PresenceHubOptions,
): void {
  new PresenceHub(doSocketRegistry(state), opts ?? {}).broadcast(roomState, version);
}
