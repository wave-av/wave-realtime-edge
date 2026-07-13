/**
 * Zoom RTMS native-WebSocket protocol (#88 Zoom→wave bridge).
 *
 * Pure parse/build for the RTMS control + media protocol, with constants taken
 * verbatim from Zoom's reference mock server (server/constants/messageTypes.js)
 * and native-WebSocket docs. Two socket legs:
 *
 *   webhook meeting.rtms_started → { meeting_uuid, rtms_stream_id, server_urls }
 *     → SIGNALING socket: send SIGNALING_HAND_SHAKE_REQ(1) with the handshake
 *       signature; recv SIGNALING_HAND_SHAKE_RESP(2) carrying media server URLs
 *     → MEDIA socket: send DATA_HAND_SHAKE_REQ(3, media_type bitmask); recv
 *       DATA_HAND_SHAKE_RESP(4), then MEDIA_DATA_AUDIO(14) frames (base64 PCM)
 *     → answer KEEP_ALIVE_REQ(12) with KEEP_ALIVE_RESP(13) to hold the stream.
 *
 * No network, no room state, no crypto here — signatures come from rtms-auth.ts,
 * audio transcode from rtms-audio.ts. This module only frames/parses. Pairing
 * the three reduces the live Zoom bridge to a thin socket-glue layer (the one
 * part that needs a real meeting to prove).
 */

import { base64ToBytes } from "./twilio-mediastream.js";

/** RTMS control/media message types (mock server: MESSAGE_TYPE). */
export const RTMS_MSG_TYPE = {
  UNDEFINED: 0,
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  EVENT_SUBSCRIPTION: 5,
  EVENT_UPDATE: 6,
  CLIENT_READY_ACK: 7,
  STREAM_STATE_UPDATE: 8,
  SESSION_STATE_UPDATE: 9,
  SESSION_STATE_REQ: 10,
  SESSION_STATE_RESP: 11,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_AUDIO: 14,
  MEDIA_DATA_VIDEO: 15,
  MEDIA_DATA_SHARE: 16,
  MEDIA_DATA_TRANSCRIPT: 17,
  MEDIA_DATA_CHAT: 18,
  STREAM_STATE_REQ: 19,
  STREAM_STATE_RESP: 20,
} as const;

/** Media-type subscription bitmask (mock server: MEDIA_DATA_TYPE OR-able flags). */
export const RTMS_MEDIA_TYPE = {
  AUDIO: 1,
  VIDEO: 2,
  SHARE: 4,
  TRANSCRIPT: 8,
  CHAT: 16,
  ALL: 32,
} as const;

const PROTOCOL_VERSION = 1;

export class RtmsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RtmsProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Webhook events (HTTP side, before any socket is opened)
// ---------------------------------------------------------------------------

export type RtmsWebhookEvent =
  | { kind: "url_validation"; plainToken: string }
  | { kind: "rtms_started"; meetingUuid: string; rtmsStreamId: string; serverUrls: string }
  | { kind: "rtms_stopped"; meetingUuid: string; rtmsStreamId: string; stopReason?: number }
  | { kind: "other"; event: string };

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Classify a parsed Zoom webhook body. RTMS event fields live under
 * `payload.object` (falling back to `payload`) as `meeting_uuid`,
 * `rtms_stream_id`, `server_urls`. url_validation carries `payload.plainToken`.
 */
export function parseRtmsWebhook(body: unknown): RtmsWebhookEvent {
  const msg = asObject(body);
  const event = typeof msg["event"] === "string" ? (msg["event"] as string) : "";
  const payload = asObject(msg["payload"]);
  const obj = asObject(payload["object"]);
  const pick = (k: string): string => {
    const v = obj[k] ?? payload[k];
    return typeof v === "string" ? v : "";
  };
  switch (event) {
    case "endpoint.url_validation": {
      const plainToken = payload["plainToken"];
      if (typeof plainToken !== "string") throw new RtmsProtocolError("url_validation missing plainToken");
      return { kind: "url_validation", plainToken };
    }
    case "meeting.rtms_started":
      return {
        kind: "rtms_started",
        meetingUuid: pick("meeting_uuid"),
        rtmsStreamId: pick("rtms_stream_id"),
        serverUrls: pick("server_urls"),
      };
    case "meeting.rtms_stopped": {
      const reason = obj["stop_reason"] ?? payload["stop_reason"];
      return {
        kind: "rtms_stopped",
        meetingUuid: pick("meeting_uuid"),
        rtmsStreamId: pick("rtms_stream_id"),
        stopReason: typeof reason === "number" ? reason : undefined,
      };
    }
    default:
      return { kind: "other", event };
  }
}

// ---------------------------------------------------------------------------
// Outbound socket messages (we send these)
// ---------------------------------------------------------------------------

/** SIGNALING_HAND_SHAKE_REQ(1) — opens the signaling leg. */
export function signalingHandshakeReq(meetingUuid: string, rtmsStreamId: string, signature: string): string {
  return JSON.stringify({
    msg_type: RTMS_MSG_TYPE.SIGNALING_HAND_SHAKE_REQ,
    protocol_version: PROTOCOL_VERSION,
    sequence: 0,
    meeting_uuid: meetingUuid,
    rtms_stream_id: rtmsStreamId,
    signature,
  });
}

/** DATA_HAND_SHAKE_REQ(3) — opens the media leg for the given media-type bitmask. */
export function dataHandshakeReq(
  meetingUuid: string,
  rtmsStreamId: string,
  signature: string,
  mediaType: number = RTMS_MEDIA_TYPE.AUDIO,
): string {
  return JSON.stringify({
    msg_type: RTMS_MSG_TYPE.DATA_HAND_SHAKE_REQ,
    protocol_version: PROTOCOL_VERSION,
    sequence: 0,
    meeting_uuid: meetingUuid,
    rtms_stream_id: rtmsStreamId,
    signature,
    media_type: mediaType,
    payload_encryption: false,
  });
}

/** KEEP_ALIVE_RESP(13) — echo the timestamp of a KEEP_ALIVE_REQ to hold the stream. */
export function keepAliveResp(timestamp: number): string {
  return JSON.stringify({ msg_type: RTMS_MSG_TYPE.KEEP_ALIVE_RESP, timestamp });
}

// ---------------------------------------------------------------------------
// Inbound socket messages (Zoom sends these)
// ---------------------------------------------------------------------------

export type RtmsInboundMessage =
  | { msgType: 2; kind: "signaling_ack"; statusCode: number; mediaServerUrls: Record<string, string> }
  | { msgType: 4; kind: "data_ack"; statusCode: number }
  | { msgType: 12; kind: "keepalive_req"; timestamp: number }
  | { msgType: 14; kind: "audio"; userId?: number; payload: Uint8Array }
  | { msgType: 15; kind: "video"; userId?: number; payload: Uint8Array }
  | { msgType: 17; kind: "transcript"; userName?: string; text: string }
  | { msgType: number; kind: "other"; raw: Record<string, unknown> };

/**
 * Parse one inbound RTMS text frame into a typed message. Throws
 * RtmsProtocolError on malformed JSON; unknown msg_types return kind:"other".
 * MEDIA_DATA_AUDIO/MEDIA_DATA_VIDEO payloads are base64-decoded to raw bytes
 * (PCM `s16le` for audio; JPEG stills for video — see rtms-video.ts header for
 * the video-codec grounding + what's still unverified pending a live meeting).
 */
export function parseRtmsMessage(text: string): RtmsInboundMessage {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new RtmsProtocolError("frame is not valid JSON");
  }
  const msgType = typeof msg["msg_type"] === "number" ? (msg["msg_type"] as number) : -1;
  const content = asObject(msg["content"]);
  switch (msgType) {
    case RTMS_MSG_TYPE.SIGNALING_HAND_SHAKE_RESP: {
      const server = asObject(asObject(msg["media_server"])["server_urls"]);
      const urls: Record<string, string> = {};
      for (const [k, v] of Object.entries(server)) if (typeof v === "string") urls[k] = v;
      return {
        msgType: 2,
        kind: "signaling_ack",
        statusCode: typeof msg["status_code"] === "number" ? (msg["status_code"] as number) : 0,
        mediaServerUrls: urls,
      };
    }
    case RTMS_MSG_TYPE.DATA_HAND_SHAKE_RESP:
      return {
        msgType: 4,
        kind: "data_ack",
        statusCode: typeof msg["status_code"] === "number" ? (msg["status_code"] as number) : 0,
      };
    case RTMS_MSG_TYPE.KEEP_ALIVE_REQ:
      return {
        msgType: 12,
        kind: "keepalive_req",
        timestamp: typeof msg["timestamp"] === "number" ? (msg["timestamp"] as number) : 0,
      };
    case RTMS_MSG_TYPE.MEDIA_DATA_AUDIO: {
      const data = content["data"];
      if (typeof data !== "string") throw new RtmsProtocolError("audio frame missing content.data");
      return {
        msgType: 14,
        kind: "audio",
        userId: typeof content["user_id"] === "number" ? (content["user_id"] as number) : undefined,
        payload: base64ToBytes(data),
      };
    }
    case RTMS_MSG_TYPE.MEDIA_DATA_VIDEO: {
      const data = content["data"];
      if (typeof data !== "string") throw new RtmsProtocolError("video frame missing content.data");
      return {
        msgType: 15,
        kind: "video",
        userId: typeof content["user_id"] === "number" ? (content["user_id"] as number) : undefined,
        payload: base64ToBytes(data),
      };
    }
    case RTMS_MSG_TYPE.MEDIA_DATA_TRANSCRIPT:
      return {
        msgType: 17,
        kind: "transcript",
        userName: typeof content["user_name"] === "string" ? (content["user_name"] as string) : undefined,
        text: typeof content["data"] === "string" ? (content["data"] as string) : "",
      };
    default:
      return { msgType, kind: "other", raw: msg };
  }
}
