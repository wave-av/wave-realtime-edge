// wave-realtime-edge — WAVE Realtime: the live control & event plane (v0).
//
// One WebSocket + a small REST surface, backed by one Durable Object per channel (see channel.ts).
// This is NOT a media transport (media rides MoQ/NDI/Dante/SRT/OMT) and NOT a WebRTC SFU — it carries
// session STATE and EVENTS: presence, pub/sub broadcast, and the streaming-event bus that the WAVE
// AI products (transcribe/sentiment/captions) push deltas into.
//
//   WS    GET  /v1/connect?channel=<id>[&as=<member>]   subscribe (presence + live frames + history)
//   REST  POST /v1/channels/:id/publish   {event,data}  producer publishes one event to a channel
//   REST  GET  /v1/channels/:id/presence                who is connected
//   REST  GET  /v1/channels/:id/history?limit=N         last-N events (≤50)
//   GET   /health                                       liveness
//   GET   /                                             branded front-door
//
// AUTH: every /v1 call requires `Authorization: Bearer <key>`. Full scope/entitlement/metering
// federate to the gateway (api.wave.online) — wired in v1 (see threat-model + build tasks). v0 enforces
// presence + basic shape of the bearer so the plane is never open; it never trusts a key locally for
// authorization decisions. No secret is stored in this worker.

import { Channel } from "./channel";
import { landingPage } from "./landing";
import type { Env } from "./types";
import { federateVerify } from "./auth";

export { Channel };

const CHANNEL_RE = /^[a-z0-9]([a-z0-9:_-]{0,127})$/i; // namespaced ids like "stream:abc", "room:xyz"

function unauthorized(): Response {
  return Response.json(
    { error: "UNAUTHENTICATED", detail: "Authorization: Bearer <WAVE API key> required; entitlement is enforced at api.wave.online" },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="wave"' } },
  );
}

function routeToChannel(env: Env, channel: string, req: Request): Promise<Response> {
  const id = env.CHANNEL.idFromName(channel);
  const stub = env.CHANNEL.get(id);
  return stub.fetch(req);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/health") {
      return Response.json({ ok: true, service: "wave-realtime-edge", plane: "control-events", substrate: "durable-objects", version: "v0" });
    }
    if (p === "/" || p === "/index.html") {
      return new Response(landingPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // ── /v1 realtime API (auth required — federated to the gateway, ADR-1) ───────
    if (p.startsWith("/v1/")) {
      // Realtime never validates keys locally: the gateway's /v1/verify is the canonical resolver.
      const who = await federateVerify(req, env);
      if (!who) return unauthorized();
      // NOTE: per-op scope (realtime:read on connect, realtime:publish on publish) is enforced once the
      // gateway scope map carries realtime scopes (#108 follow-up); today a valid entitled key suffices.

      // WS subscribe
      if (p === "/v1/connect") {
        if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return Response.json({ error: "EXPECTED_WEBSOCKET", detail: "GET /v1/connect requires an Upgrade: websocket" }, { status: 426 });
        }
        const channel = url.searchParams.get("channel") || "";
        if (!CHANNEL_RE.test(channel)) return Response.json({ error: "BAD_CHANNEL", detail: "channel must match [a-z0-9][a-z0-9:_-]{0,127}" }, { status: 400 });
        // Attribute presence to the caller's key prefix when no explicit member id was given.
        const fwd = new URL(req.url);
        if (!fwd.searchParams.get("as")) fwd.searchParams.set("as", who.keyPrefix || who.organizationId);
        return routeToChannel(env, channel, new Request(fwd.toString(), req));
      }

      // REST channel ops: /v1/channels/:id/(publish|presence|history)
      const m = /^\/v1\/channels\/([^/]+)\/(publish|presence|history)$/.exec(p);
      if (m) {
        const channel = decodeURIComponent(m[1]);
        if (!CHANNEL_RE.test(channel)) return Response.json({ error: "BAD_CHANNEL" }, { status: 400 });
        const fwd = new URL(req.url);
        fwd.searchParams.set("channel", channel);
        return routeToChannel(env, channel, new Request(fwd.toString(), req));
      }

      return Response.json({ error: "NOT_FOUND", detail: "see / for the realtime API surface" }, { status: 404 });
    }

    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  },
};
