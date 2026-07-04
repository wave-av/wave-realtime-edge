/**
 * Twilio Media-Streams WebSocket protocol (#60 residual / #76).
 *
 * When a Twilio `<Connect><Stream url="wss://rt.wave.online/…">` bridges a call,
 * Twilio opens a WebSocket and exchanges JSON text frames. This module is the
 * pure, I/O-free parse/build layer for that fixed, documented protocol
 * (https://www.twilio.com/docs/voice/media-streams/websocket-messages).
 * Audio payloads are base64 G.711 μ-law, 8 kHz mono — decode them with the
 * telephony-codec primitive; this module only frames them.
 *
 * Pairing this with telephony-codec.ts reduces the Twilio↔room bridge's
 * remaining work to a minimal injection-glue layer (which is the one part that
 * needs the live-call spike). No network, no room state here — pure + testable.
 */

/** Media format Twilio always announces for a PSTN Media Stream. */
export interface TwilioMediaFormat {
  encoding: string; // "audio/x-mulaw"
  sampleRate: number; // 8000
  channels: number; // 1
}

export interface TwilioConnectedEvent {
  event: "connected";
  protocol: string;
  version: string;
}

export interface TwilioStartEvent {
  event: "start";
  streamSid: string;
  callSid: string;
  accountSid: string;
  tracks: string[];
  mediaFormat: TwilioMediaFormat;
  customParameters: Record<string, string>;
}

export interface TwilioMediaEvent {
  event: "media";
  streamSid: string;
  track: string;
  chunk: string;
  timestamp: string;
  /** Decoded μ-law bytes (base64 already un-wrapped). */
  payload: Uint8Array;
}

export interface TwilioStopEvent {
  event: "stop";
  streamSid: string;
  callSid?: string;
  accountSid?: string;
}

export interface TwilioDtmfEvent {
  event: "dtmf";
  streamSid: string;
  track: string;
  digit: string;
}

export interface TwilioMarkEvent {
  event: "mark";
  streamSid: string;
  name: string;
}

export type TwilioInboundEvent =
  | TwilioConnectedEvent
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioStopEvent
  | TwilioDtmfEvent
  | TwilioMarkEvent;

export class TwilioProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioProtocolError";
  }
}

/** base64 → bytes, using the Workers/DOM-standard atob. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** bytes → base64, using the Workers/DOM-standard btoa. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new TwilioProtocolError(`missing/invalid string field: ${field}`);
  return v;
}

/**
 * Parse one inbound Twilio Media-Stream text frame into a typed event.
 * Throws TwilioProtocolError on malformed JSON or unknown/invalid events —
 * callers should treat that as a protocol violation and close the socket.
 */
export function parseTwilioFrame(text: string): TwilioInboundEvent {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new TwilioProtocolError("frame is not valid JSON");
  }
  const event = msg["event"];
  switch (event) {
    case "connected":
      return {
        event: "connected",
        protocol: asString(msg["protocol"], "protocol"),
        version: asString(msg["version"], "version"),
      };
    case "start": {
      const start = (msg["start"] ?? {}) as Record<string, unknown>;
      const mf = (start["mediaFormat"] ?? {}) as Record<string, unknown>;
      return {
        event: "start",
        streamSid: asString(msg["streamSid"], "streamSid"),
        callSid: asString(start["callSid"], "start.callSid"),
        accountSid: asString(start["accountSid"], "start.accountSid"),
        tracks: Array.isArray(start["tracks"]) ? (start["tracks"] as string[]) : [],
        mediaFormat: {
          encoding: typeof mf["encoding"] === "string" ? (mf["encoding"] as string) : "audio/x-mulaw",
          sampleRate: typeof mf["sampleRate"] === "number" ? (mf["sampleRate"] as number) : 8000,
          channels: typeof mf["channels"] === "number" ? (mf["channels"] as number) : 1,
        },
        customParameters: (start["customParameters"] as Record<string, string>) ?? {},
      };
    }
    case "media": {
      const media = (msg["media"] ?? {}) as Record<string, unknown>;
      return {
        event: "media",
        streamSid: asString(msg["streamSid"], "streamSid"),
        track: typeof media["track"] === "string" ? (media["track"] as string) : "inbound",
        chunk: typeof media["chunk"] === "string" ? (media["chunk"] as string) : "0",
        timestamp: typeof media["timestamp"] === "string" ? (media["timestamp"] as string) : "0",
        payload: base64ToBytes(asString(media["payload"], "media.payload")),
      };
    }
    case "stop": {
      const stop = (msg["stop"] ?? {}) as Record<string, unknown>;
      return {
        event: "stop",
        streamSid: asString(msg["streamSid"], "streamSid"),
        callSid: typeof stop["callSid"] === "string" ? (stop["callSid"] as string) : undefined,
        accountSid: typeof stop["accountSid"] === "string" ? (stop["accountSid"] as string) : undefined,
      };
    }
    case "dtmf": {
      const dtmf = (msg["dtmf"] ?? {}) as Record<string, unknown>;
      return {
        event: "dtmf",
        streamSid: asString(msg["streamSid"], "streamSid"),
        track: typeof dtmf["track"] === "string" ? (dtmf["track"] as string) : "inbound_track",
        digit: asString(dtmf["digit"], "dtmf.digit"),
      };
    }
    case "mark": {
      const mark = (msg["mark"] ?? {}) as Record<string, unknown>;
      return {
        event: "mark",
        streamSid: asString(msg["streamSid"], "streamSid"),
        name: asString(mark["name"], "mark.name"),
      };
    }
    default:
      throw new TwilioProtocolError(`unknown Twilio event: ${String(event)}`);
  }
}

/** Build an outbound `media` frame to play μ-law audio back to the caller. */
export function twilioMediaFrame(streamSid: string, muLawPayload: Uint8Array): string {
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: bytesToBase64(muLawPayload) },
  });
}

/** Build an outbound `mark` frame (used to detect playback completion). */
export function twilioMarkFrame(streamSid: string, name: string): string {
  return JSON.stringify({ event: "mark", streamSid, mark: { name } });
}

/** Build an outbound `clear` frame (flush buffered audio, e.g. on barge-in). */
export function twilioClearFrame(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}
