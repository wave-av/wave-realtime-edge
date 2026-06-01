// channel.ts — WAVE Realtime: one Durable Object per channel = the authoritative live room.
//
// A Channel holds the subscriber WebSockets (via the Hibernation API, so idle rooms cost nothing),
// the live presence set, and a bounded last-N history ring. It is single-threaded per channel id, so
// there are no locks: every op (subscribe / publish / presence / history) mutates in-order.
//
// This is the control & event PLANE — it carries session state and events, not media bits (those ride
// the transports: MoQ/NDI/Dante/SRT/OMT). Producers (the streaming-AI spokes, the gateway) POST events
// in; consumers (UIs, agents) subscribe over one WebSocket and receive them live.

import type { ChannelFrame, PresenceMember, PublishBody } from "./types";

const HISTORY_MAX = 50;

interface Attachment {
  member: string; // stable member id for this socket
  channel: string;
}

export class Channel implements DurableObject {
  private history: ChannelFrame[] = [];

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: unknown,
  ) {
    // Best-effort restore of the history ring across hibernation/eviction.
    this.ctx.blockConcurrencyWhile(async () => {
      this.history = (await this.ctx.storage.get<ChannelFrame[]>("history")) ?? [];
    });
  }

  // ── HTTP/WS entry (called by the worker after it has authed + routed) ───────────
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const channel = url.searchParams.get("channel") ?? "default";

    // 1) WebSocket subscriber — upgrade and accept into the hibernatable pool.
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const member = url.searchParams.get("as") || crypto.randomUUID();
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const att: Attachment = { member, channel };
      server.serializeAttachment(att);
      this.ctx.acceptWebSocket(server);
      // greet: snapshot of presence + recent history so a new subscriber is immediately consistent.
      server.send(JSON.stringify({ type: "welcome", channel, member, presence: this.presence(), history: this.history }));
      this.fanout({ type: "join", channel, member, ts: Date.now() }, server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2) REST ops (producers + readers that don't hold a socket).
    if (req.method === "POST" && url.pathname.endsWith("/publish")) {
      const body = (await req.json().catch(() => null)) as PublishBody | null;
      if (!body || typeof body.event !== "string") {
        return Response.json({ error: "BAD_PUBLISH", detail: "expected {event, data}" }, { status: 400 });
      }
      const frame: ChannelFrame = { type: "message", channel, event: body.event, data: body.data ?? null, ts: Date.now() };
      this.append(frame);
      const n = this.fanout(frame);
      return Response.json({ ok: true, delivered: n });
    }
    if (req.method === "GET" && url.pathname.endsWith("/presence")) {
      return Response.json({ channel, members: this.presence() });
    }
    if (req.method === "GET" && url.pathname.endsWith("/history")) {
      const limit = Math.min(Number(url.searchParams.get("limit")) || HISTORY_MAX, HISTORY_MAX);
      return Response.json({ channel, events: this.history.slice(-limit) });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // ── Hibernation handlers (called by the runtime, even after the DO slept) ───────
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    let msg: { op?: string; event?: string; data?: unknown } | null = null;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", detail: "invalid JSON frame" }));
      return;
    }
    if (msg?.op === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }
    if (msg?.op === "publish" && typeof msg.event === "string") {
      const frame: ChannelFrame = { type: "message", channel: att.channel, event: msg.event, data: msg.data ?? null, ts: Date.now(), from: att.member };
      this.append(frame);
      this.fanout(frame);
      return;
    }
    if (msg?.op === "presence") {
      ws.send(JSON.stringify({ type: "presence", channel: att.channel, members: this.presence() }));
      return;
    }
    ws.send(JSON.stringify({ type: "error", detail: "unknown op (expected publish|presence|ping)" }));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att) this.fanout({ type: "leave", channel: att.channel, member: att.member, ts: Date.now() }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ── internals ──────────────────────────────────────────────────────────────────
  private presence(): PresenceMember[] {
    return this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment() as Attachment | null;
      return { id: a?.member ?? "unknown" };
    });
  }

  /** Send a frame to every open subscriber (optionally excluding one). Returns delivery count. */
  private fanout(frame: ChannelFrame | Record<string, unknown>, except?: WebSocket): number {
    const payload = JSON.stringify(frame);
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
        n++;
      } catch {
        /* socket gone; runtime will fire close */
      }
    }
    return n;
  }

  private append(frame: ChannelFrame): void {
    this.history.push(frame);
    if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
    // fire-and-forget persistence so history survives hibernation (not awaited on the hot path).
    void this.ctx.storage.put("history", this.history);
  }
}
