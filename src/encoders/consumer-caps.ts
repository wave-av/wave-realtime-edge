/// <reference types="@cloudflare/workers-types" />
/**
 * #135 — CONSUMER-CAPABILITIES SOURCE for the recorder encode leg (the real-session half of #86's negotiation).
 *
 * The rt-encoder `/encode` negotiation (PR #123) was byte-identical in a real session because the CALLER never
 * sent `x-dst-capabilities`. This module sources a HONEST consumer (dst) capability descriptor for the recorder
 * leg so, when the operator arms `NEGOTIATION_ENABLED`, the server actually negotiates against a real surface.
 *
 * WHO IS THE CONSUMER on the recorder leg? The recorder's output is muxed into the SKIP-tier WebM/Matroska
 * recording. That recording IS the consuming end of this encode hop — it decodes the produced video codec on
 * playback. So the dst descriptor here describes what the RECORDING SINK accepts, NOT a live WebRTC peer. This
 * is honest and self-described from env — the RoomDO does NOT today parse/store per-participant WebRTC decode
 * capabilities, and doing so would be an SDP-parsing protocol change well beyond this task. When/if the RoomDO
 * later captures real per-consumer caps at JOIN, `roomConsumerDescriptor()` is the seam to feed them in.
 *
 * DEFAULT-OFF SAFETY: the descriptor is only ever ATTACHED to a request when `NEGOTIATION_ENABLED` is on (the
 * caller gates the header). With the flag off, NOTHING here changes the wire — the recorder leg is byte-identical
 * to today. The default descriptor below is the SAFE recording baseline: VP8 decodable (the proven recorder
 * output), over the recorder's local container transport, in the host's region.
 *
 * SHAPE: matches the rt-encoder server's negotiate.mjs/leg-select.mjs parser EXACTLY — `{region, decode[],
 * transports[]}`, decode entries `{name, available}`, transport entries `{protocol, activated}`. No new schema.
 */
import type { DstCapabilityDescriptor } from "./recorder-target.js";

/** Env this seam reads. All optional — absence → the safe recording-baseline descriptor (no behavior change). */
export interface ConsumerCapsEnv {
  /** Arms negotiation on the caller side. "true" → attach x-dst-capabilities. Default-off (absent → off). */
  NEGOTIATION_ENABLED?: string;
  /** Continent-prefixable region the recording consumer is placed in (mirrors the server's regionOf env). */
  RT_REGION?: string;
  /**
   * Optional override of the consumer's decodable codecs as a CSV of registry names (e.g. "vp8,vp9,av1"). When
   * absent the safe baseline is VP8 only (the proven recorder output every WebM player decodes). Honest: an
   * operator who knows the downstream player decodes more can widen this to let the negotiator pick a better codec.
   */
  RT_CONSUMER_DECODE?: string;
  /**
   * Optional override of the consumer's activated transports as a CSV of protocol names (e.g. "moq,ll-hls").
   * Absent → the recorder's local container transport baseline. Only matters when both ends share a transport.
   */
  RT_CONSUMER_TRANSPORTS?: string;
}

/** Truthy iff the operator armed negotiation. Default-off: absent/anything-else → off (byte-identical path). */
export function negotiationArmed(env: ConsumerCapsEnv): boolean {
  return String(env.NEGOTIATION_ENABLED || "").toLowerCase() === "true";
}

/** Registry codec names this build treats as the proven recorder output (safe baseline the muxer plays back). */
const BASELINE_DECODE = ["vp8"] as const;
/** The recorder's local container transport — the leg between the encoder and the in-isolate muxer/sink. */
const BASELINE_TRANSPORT = "moq" as const;

/** Split a CSV env value into a trimmed, de-duped, lowercased token list (empty → []). */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const t = raw.trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen];
}

/**
 * Build the recording consumer's capability descriptor in the EXACT server-parser shape. Sourced from env with
 * a safe VP8/local-transport baseline. PURE given its input. The result is ONLY attached to a request when the
 * caller is in the negotiation-armed path, so this never changes the off-path wire.
 */
export function consumerDescriptor(env: ConsumerCapsEnv): DstCapabilityDescriptor {
  const decodeNames = csv(env.RT_CONSUMER_DECODE);
  const transportNames = csv(env.RT_CONSUMER_TRANSPORTS);
  const decode = (decodeNames.length ? decodeNames : [...BASELINE_DECODE]).map((name) => ({ name, available: true }));
  const transports = (transportNames.length ? transportNames : [BASELINE_TRANSPORT]).map((protocol) => ({
    protocol,
    activated: true,
  }));
  const descriptor: DstCapabilityDescriptor = { decode, transports };
  const region = (env.RT_REGION || "").trim();
  if (region) descriptor.region = region;
  return descriptor;
}

/**
 * SEAM for future real-per-consumer caps. Today the RoomDO does not track per-participant WebRTC decode/transport
 * support (the join payload is {participantId, sessionId, role} — no capability field, and the SDP offer is not
 * parsed for decode capabilities). When that plumbing lands, pass the room's aggregated consumer descriptor here
 * and it takes precedence over the env baseline. Until then this returns the env-sourced baseline unchanged —
 * honest, never a faked live-peer descriptor.
 */
export function roomConsumerDescriptor(
  env: ConsumerCapsEnv,
  roomDescriptor?: DstCapabilityDescriptor | null,
): DstCapabilityDescriptor {
  return roomDescriptor ?? consumerDescriptor(env);
}
