/// <reference types="@cloudflare/workers-types" />
/**
 * #88 M2 — Zoom RTMS → WAVE bridge CONTROL PLANE (webhook receiver).
 *
 * This is the thin, HTTP-only control organ of the Zoom Real-Time Media Streams
 * bridge. It NEVER touches a media byte: Zoom POSTs lifecycle webhooks here and
 * this module verifies + classifies + acks them. On a signed `meeting.rtms_started`
 * it hands the {meeting_uuid, rtms_stream_id, server_urls} tuple to an injected
 * `onRtmsStarted` seam — the outbound signaling+media WebSocket dial-out (the part
 * that dials Zoom's servers, pumps `rtmsAudioToSfuPcm`, and injects into a room via
 * a Durable Object) lands in the FOLLOW-UP slice and is a ◆ Jake-armed crossing
 * (it can only be proven with a live Zoom meeting). Default seam = a no-op ack.
 *
 * INERT (mirrors stream-bridge.ts §6-B1): the whole surface is reached ONLY when
 * `WAVE_ZOOM_RTMS` is truthy. Off (the default) → `maybeHandleZoomRtms` returns
 * null and the worker's 501 catch-all is unchanged — this module is never entered.
 *
 * SECURITY (load-bearing, mirrors rtk-webhook.ts / stream-bridge.ts): like those,
 * this route is intentionally NOT behind the gateway (x-wave-internal) — Zoom calls
 * it directly. It therefore authenticates itself: the `x-zm-signature` header is
 * `v0=HMAC-SHA256(secretToken, "v0:${x-zm-request-timestamp}:${rawBody}")`, verified
 * in CONSTANT TIME over the RAW body BEFORE it is parsed (verifyZoomWebhookSignature,
 * src/rtms-auth.ts). Fail-CLOSED: a missing/invalid signature — INCLUDING when the
 * secret token isn't provisioned yet — yields 401 and nothing is acted on. The
 * `endpoint.url_validation` challenge is answered with the encryptedToken proof
 * (rtmsUrlValidationResponse) only AFTER the same signature check passes.
 */

import {
  parseRtmsWebhook,
  RtmsProtocolError,
  type RtmsWebhookEvent,
} from "./rtms-protocol";
import { verifyZoomWebhookSignature, rtmsUrlValidationResponse } from "./rtms-auth";

/** The single webhook path Zoom is configured to POST RTMS events to. */
export const ZOOM_RTMS_ROUTE = "/zoom/rtms";

/** Env this module reads. WAVE_ZOOM_RTMS is a [vars] flag; the secret is a wrangler SECRET. */
export interface ZoomRtmsEnv {
  /** [vars] flag, default off ("0"). Truthy → the /zoom/rtms webhook is served. */
  WAVE_ZOOM_RTMS?: string | boolean;
  /**
   * wrangler SECRET — the Zoom app's Event-notification "Secret Token". Signs
   * every inbound webhook AND is the key for the url_validation encryptedToken.
   * Empty/absent → every webhook 401s (fail-closed). NOT in [vars].
   */
  ZOOM_RTMS_WEBHOOK_SECRET_TOKEN?: string;
}

/** The narrowed `rtms_started` event handed to the media-bridge seam. */
export type RtmsStartedEvent = Extract<RtmsWebhookEvent, { kind: "rtms_started" }>;

/** The narrowed `rtms_stopped` event handed to the teardown seam. */
export type RtmsStoppedEvent = Extract<RtmsWebhookEvent, { kind: "rtms_stopped" }>;

/**
 * Seam for the outbound media bridge. Receives a verified rtms_started event; the
 * default is a no-op so the surface stays INERT (verify+ack only, no dial-out) until
 * a caller injects the real DO-backed dialer (route-dispatch wires it to ZoomRtmsBridgeDO).
 */
export type OnRtmsStarted = (event: RtmsStartedEvent) => void | Promise<void>;

/**
 * Seam for tearing the bridge down on `meeting.rtms_stopped`. Default no-op (INERT); the
 * live wiring routes it to the same meeting-keyed DO's `/stop`. A dropped Zoom leg also
 * self-tears-down inside the core, so this is the clean-shutdown path, not the only one.
 */
export type OnRtmsStopped = (event: RtmsStoppedEvent) => void | Promise<void>;

/** Truthy-flag check (mirrors streamBridgeEnabled): "1"/"true"/true → enabled; absent/"0"/false → inert. */
export function zoomRtmsEnabled(env: { WAVE_ZOOM_RTMS?: string | boolean }): boolean {
  const v = env.WAVE_ZOOM_RTMS;
  return v === true || v === "1" || v === "true";
}

/**
 * Handle a Zoom RTMS webhook, or return null to fall through to the rest of the
 * router. Returns null when the path isn't `/zoom/rtms` OR the flag is off (so the
 * 501 catch-all is byte-identical when INERT). Otherwise: 405 for non-POST; 401 on
 * a bad/absent signature (fail-closed); 400 on unparseable JSON; a url_validation
 * echo, or a lifecycle ack. `ctx.waitUntil` backgrounds the rtms_started seam so a
 * slow dial-out can't hold the ack past Zoom's webhook timeout.
 */
export async function maybeHandleZoomRtms(
  request: Request,
  env: ZoomRtmsEnv,
  ctx?: { waitUntil(p: Promise<unknown>): void },
  onRtmsStarted: OnRtmsStarted = () => {},
  onRtmsStopped: OnRtmsStopped = () => {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== ZOOM_RTMS_ROUTE) return null; // not our route → fall through unchanged
  if (!zoomRtmsEnabled(env)) return null; // INERT → the 501 catch-all is unchanged
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await request.text();
  const secret = env.ZOOM_RTMS_WEBHOOK_SECRET_TOKEN ?? "";
  // Verify over the RAW body BEFORE parsing. Empty secret → verify returns false → 401 (fail-closed).
  const verified = await verifyZoomWebhookSignature(
    rawBody,
    request.headers.get("x-zm-signature"),
    request.headers.get("x-zm-request-timestamp"),
    secret,
  );
  if (!verified) return new Response("invalid zoom signature", { status: 401 });

  let event: RtmsWebhookEvent;
  try {
    event = parseRtmsWebhook(JSON.parse(rawBody));
  } catch (err) {
    // Malformed JSON or a url_validation missing its plainToken → 400 (verified sender, bad body).
    const detail = err instanceof RtmsProtocolError ? err.message : "invalid json";
    return new Response(detail, { status: 400 });
  }

  switch (event.kind) {
    case "url_validation":
      // Prove we hold the secret: echo plainToken + encryptedToken = HMAC(secret, plainToken).
      return Response.json(await rtmsUrlValidationResponse(event.plainToken, secret));
    case "rtms_started": {
      // INERT seam: the outbound signaling+media WS dial-out is the ◆ follow-up slice.
      const started = Promise.resolve(onRtmsStarted(event));
      if (ctx) ctx.waitUntil(started);
      else await started;
      return Response.json({ ok: true, accepted: "rtms_started" });
    }
    case "rtms_stopped": {
      // Clean teardown of the meeting-keyed bridge DO (a dropped Zoom leg also self-tears-down in the core).
      const stopped = Promise.resolve(onRtmsStopped(event));
      if (ctx) ctx.waitUntil(stopped);
      else await stopped;
      return Response.json({ ok: true, accepted: "rtms_stopped" });
    }
    default:
      return Response.json({ ok: true, accepted: "ignored" });
  }
}
