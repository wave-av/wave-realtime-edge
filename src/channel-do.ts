// channel-do.ts — item #5: the ChannelDO Durable-Object wrapper (thin glue) over the pure ChannelHub engine
// (channel.ts). Mirrors the RoomDO presence glue (room.ts's acceptPresence/webSocketMessage + presence.ts's
// acceptPresenceSocket/onPresenceMessage/broadcastPresence) rather than inventing a second DO pattern: a
// hibernatable WebSocket per subscriber, identity carried in the socket's serialized attachment (survives a
// DO eviction), history persisted to DO storage so a publish is durable across an eviction too.
//
// One ChannelDO per `${org}:${channel}` — route-dispatch.ts derives the DO id EXACTLY the way it derives the
// ROOM DO id, so a caller can only ever address a channel inside its own org namespace (tenant isolation is
// enforced at the dispatch layer, not here; this module trusts the `channel` query param it is handed).
import { ChannelHub, HistoryRing, type ChannelConn, type ChannelEvent, type SocketRegistry } from "./channel.js";

const CHANNEL_TAG = "channel";
const HISTORY_KEY = "channel:history";

interface ChannelAttachment {
  id: string;
}

/** Minimal DO runtime shape (avoids a hard dependency on cloudflare:workers types; mirrors room.ts's
 *  DurableObjectStateLike). The hibernation WebSocket API is OPTIONAL so unit tests construct a ChannelDO
 *  with just storage and assert the 503 fail-closed path. */
interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
  acceptWebSocket?(ws: WebSocket, tags?: string[]): void;
  getWebSockets?(tag?: string): WebSocket[];
}

/** Wrap one hibernation socket (identity from its attachment) as a ChannelConn. */
function wsConn(ws: WebSocket, att: ChannelAttachment): ChannelConn {
  return {
    id: att.id,
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

function safeAttachment(ws: WebSocket): ChannelAttachment | null {
  try {
    const att = (ws as unknown as { deserializeAttachment(): unknown }).deserializeAttachment() as ChannelAttachment | null;
    return att && typeof att.id === "string" ? att : null;
  } catch {
    return null;
  }
}

/** Wrap the DO's live channel sockets as a SocketRegistry (identity read from each socket's attachment). */
function doSocketRegistry(state: DurableObjectStateLike): SocketRegistry {
  return {
    all(): ChannelConn[] {
      const conns: ChannelConn[] = [];
      for (const ws of state.getWebSockets?.(CHANNEL_TAG) ?? []) {
        const att = safeAttachment(ws);
        if (att) conns.push(wsConn(ws, att));
      }
      return conns;
    },
  };
}

/**
 * ChannelDO — one Durable Object per channel (keyed `${org}:${channel}` by the worker). Registered in
 * wrangler.toml (CHANNEL binding + migration) and re-exported from src/worker.ts so the binding resolves
 * on deploy. Every entry point below is reached ONLY via the worker's internal `stub.fetch(...)` calls
 * (route-dispatch.ts) — this module never parses a public URL itself.
 */
export class ChannelDO {
  private readonly doState: DurableObjectStateLike;
  /** Lazily seeded from storage (mirrors RoomDO's presenceVer) so a publish's history write survives an
   *  eviction without paying a storage read on every request. Null until first touched. */
  private history: HistoryRing | null = null;

  constructor(state: DurableObjectStateLike, _env?: unknown) {
    this.doState = state;
  }

  /**
   * Control surface: the worker forwards each of the four public routes here as a fixed internal path
   * (`connect`/`publish`/`presence`/`history`), always carrying `?channel=<id>` so a response can echo the
   * channel name (the DO's own id is an opaque hash — it never learns its channel string from `idFromName`).
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const intent = url.pathname.replace(/^\/+/, "");
    switch (intent) {
      case "connect":
        return this.acceptConnect(request, url);
      case "publish":
        return this.handlePublish(request, url);
      case "presence":
        return this.handlePresence(url);
      case "history":
        return this.handleHistory(url);
      default:
        return Response.json({ error: "BAD_REQUEST", message: `unknown channel intent: ${intent}` }, { status: 400 });
    }
  }

  /** Complete the `GET /v1/connect` WS upgrade: pair the socket, stamp the subscriber's id as the
   *  hibernation attachment, register it, send `welcome`, announce the join, and return the 101. Fails
   *  closed (503) without the hibernation API or WebSocketPair — never a silent no-op socket. */
  private async acceptConnect(request: Request, url: URL): Promise<Response> {
    if (!this.doState.acceptWebSocket || !this.doState.getWebSockets) {
      return Response.json(
        { error: "REALTIME_NOT_CONFIGURED", message: "channel connect requires a Durable Object runtime" },
        { status: 503 },
      );
    }
    const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
    if (!WSP) {
      return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
    }
    const channel = url.searchParams.get("channel") ?? "";
    const as = url.searchParams.get("as") ?? "";
    const id = as || `m-${crypto.randomUUID().slice(0, 8)}`;
    const pair = new WSP();
    const client = (pair as unknown as Record<string, WebSocket>)[0];
    const server = (pair as unknown as Record<string, WebSocket>)[1];
    const att: ChannelAttachment = { id };
    try {
      server.serializeAttachment(att);
    } catch {
      /* attachment unsupported on some runtimes — welcome below still carries identity via the conn */
    }
    this.doState.acceptWebSocket(server, [CHANNEL_TAG]);
    const history = await this.ensureHistory();
    const hub = new ChannelHub(doSocketRegistry(this.doState), history);
    const conn = wsConn(server, att);
    hub.welcome(conn, channel);
    hub.announceJoin(conn);
    try {
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    } catch {
      // Some runtimes (the node test env) reject a 101 in the Response ctor — 200 fallback with the same
      // webSocket, matching presence.ts's acceptPresenceSocket / room.ts's agent WS routes.
      return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    }
  }

  /** `POST .../publish` — fan one event out to every current subscriber, record it into history. Always a
   *  real 200 with the delivered count; a malformed body is 400 (never a silent no-op publish). */
  private async handlePublish(request: Request, url: URL): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const event = typeof body.event === "string" ? body.event : "";
    if (!event) {
      return Response.json({ error: "BAD_REQUEST", message: "publish requires an `event` string" }, { status: 400 });
    }
    const history = await this.ensureHistory();
    const hub = new ChannelHub(doSocketRegistry(this.doState), history);
    const { event: built, delivered } = hub.publish(event, body.data);
    await this.persistHistory();
    return Response.json({ ok: true, delivered, id: built.id, channel: url.searchParams.get("channel") ?? "" }, { status: 200 });
  }

  /** `GET .../presence` — the current, de-duplicated member list. No socket runtime → empty list (never an
   *  error; a channel with zero live subscribers legitimately has zero members). */
  private handlePresence(url: URL): Response {
    const members = this.doState.getWebSockets
      ? new ChannelHub(doSocketRegistry(this.doState), new HistoryRing()).members()
      : [];
    return Response.json({ channel: url.searchParams.get("channel") ?? "", members }, { status: 200 });
  }

  /** `GET .../history` — the last-N events (≤ HISTORY_CAP, per spec/realtime.yaml's `limit` param). */
  private async handleHistory(url: URL): Promise<Response> {
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam != null ? Number(limitParam) : undefined;
    const history = await this.ensureHistory();
    const events: ChannelEvent[] = history.list(limit != null && Number.isFinite(limit) ? limit : undefined);
    return Response.json({ channel: url.searchParams.get("channel") ?? "", events }, { status: 200 });
  }

  /** Hibernation handler — channel sockets are subscribe-only from the client's perspective (publish is the
   *  separate HTTP producer endpoint per spec/realtime.yaml); an inbound frame is treated as a liveness ping
   *  and never crashes the socket. */
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    /* subscribe-only surface — no client→server frame is part of the contract */
  }

  /** Hibernation handler — announce the departure to the remaining subscribers. Fail-safe: a defect here
   *  must never crash the DO or the sockets it still owns. */
  webSocketClose(ws: WebSocket): void {
    this.announceLeave(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.announceLeave(ws);
  }

  private announceLeave(ws: WebSocket): void {
    try {
      const att = safeAttachment(ws);
      if (!att || !this.doState.getWebSockets) return;
      const hub = new ChannelHub(doSocketRegistry(this.doState), this.history ?? new HistoryRing());
      hub.announceLeave(wsConn(ws, att));
    } catch {
      /* fail-safe */
    }
  }

  /** Seed the ring from storage exactly once (survives a DO eviction) — the only await in the history path
   *  outside of the persist call itself. */
  private async ensureHistory(): Promise<HistoryRing> {
    if (!this.history) {
      const stored = await this.doState.storage.get<ChannelEvent[]>(HISTORY_KEY);
      this.history = HistoryRing.fromArray(stored);
    }
    return this.history;
  }

  private async persistHistory(): Promise<void> {
    if (this.history) await this.doState.storage.put(HISTORY_KEY, this.history.snapshot());
  }
}
