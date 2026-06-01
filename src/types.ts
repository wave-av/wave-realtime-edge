// types.ts — WAVE Realtime shared shapes.

export interface Env {
  CHANNEL: DurableObjectNamespace;
  /** Gateway origin that owns auth/scope/entitlement/metering for the realtime plane. */
  GATEWAY_ORIGIN?: string;
}

/** A frame broadcast to subscribers of a channel. */
export interface ChannelFrame {
  type: "message" | "join" | "leave";
  channel: string;
  event?: string;
  data?: unknown;
  member?: string;
  from?: string;
  ts: number;
}

export interface PresenceMember {
  id: string;
  meta?: Record<string, unknown>;
}

/** POST /v1/channels/:id/publish body (producers: streaming-AI spokes, gateway, apps). */
export interface PublishBody {
  event: string;
  data?: unknown;
}
