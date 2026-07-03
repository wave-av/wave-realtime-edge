// agent-media-consumer.ts — #76 P2 (architecture A, co-locate): the agent's media-READ folded onto the
// single RoomDO.mediaTap. Today the wave-native voice agent reads a room over its OWN second SFU subscription
// (AgentSessionDO `createWebsocketAdapter`, egress WS) — the exact duplicate subscribe the MediaTap exists to
// eliminate (transform-once fan-out-many; one authoritative room subscribe). This module makes the agent an
// in-process MediaConsumer off the room's tap: no cross-DO frame transport, no 2nd SFU subscription.
//
// ── INERT UNTIL ARMED ───────────────────────────────────────────────────────────────────────────────────────
//  Nothing here runs unless MEDIA_TAP_ENABLED is armed (the tap publishes nothing when off → the RoomDO builds
//  the consumer registry but never registers a drain, so prod is byte-identical). This is P2 ONLY — the agent's
//  media-READ path. It is ADDITIVE: it does NOT touch the live AgentSessionDO echo/speak path (#78 decommission
//  removes that after parity is proven). Frames drained here are, for now, counted + logged (a receipt the fold
//  is live); the P3 turn-loop (STT/LLM/TTS) is a separate, deferred step (see spec §5, room.ts note).
import type { MediaConsumer, MediaTap, TapConsumerHandle, TapFrame, TapSelector } from "./media-tap.js";
import { pumpConsumer } from "./media-tap.js";

/** The minimum an in-RoomDO agent read needs to know: which participant track (by name) is the agent's watch
 *  input, and the agent's own id (for the consumer id + logging). Derived from the SAME AgentSessionConfig the
 *  /bind dispatch already carries (participantTrackName) — this module invents no new bind signal. */
export interface AgentReadTarget {
  readonly agentId: string;
  /** The participant track the agent subscribes to (egress input today). Selects the tap fan-out. */
  readonly participantTrackName: string;
}

/** A frame sink the co-located agent read drives per drained frame. In P2 the RoomDO supplies a counting/logging
 *  sink (the receipt the read-fold is live); P3 will supply the VAD→STT→LLM→TTS turn-loop instead. Kept as an
 *  injected seam so P3 lands without re-touching the tap wiring, and so this is unit-testable with a fake sink. */
export interface AgentFrameSink {
  onFrame(frame: TapFrame): void | Promise<void>;
  onClose?(): void;
}

/** Stable consumer id for an agent read on a given track — one drain per (agent, track). Re-registering the same
 *  id closes the prior handle (MediaTap.subscribe contract), so a rebind is idempotent. */
export function agentConsumerId(target: AgentReadTarget): string {
  return `agent:${target.agentId}:${target.participantTrackName}`;
}

/**
 * The in-process MediaConsumer for one agent read. selector narrows the tap fan-out to the agent's target track
 * (least-privilege: audio kind — the voice agent watches audio) so the agent only drains the frames it needs.
 * onFrame delegates to the injected sink; a sink defect is isolated by pumpConsumer (never stalls the tap, the
 * source, or a peer consumer). onClose forwards so the sink can release turn-loop resources on room end.
 */
export function buildAgentReadConsumer(target: AgentReadTarget, sink: AgentFrameSink): MediaConsumer {
  const selector: TapSelector = { kinds: ["audio"], trackNames: [target.participantTrackName] };
  return {
    id: agentConsumerId(target),
    selector,
    onFrame: (frame) => sink.onFrame(frame),
    onClose: () => sink.onClose?.(),
  };
}

/**
 * Register the agent read as a tap consumer and start draining it. Returns the handle (so the caller can close it
 * on unbind/room-end) or null when NOT armed — the whole read-fold is gated by `armed`, so an unarmed room builds
 * nothing (prod byte-identical). The pump runs detached (pumpConsumer loops until the handle closes); the returned
 * handle.close() ends it. Fail-safe: registration never throws up into the frame path.
 */
export function startAgentRead(
  tap: MediaTap,
  target: AgentReadTarget,
  sink: AgentFrameSink,
  armed: boolean,
): TapConsumerHandle | null {
  if (!armed) return null;
  const consumer = buildAgentReadConsumer(target, sink);
  const handle = tap.subscribe(consumer.id, consumer.selector);
  // Detached drain — pumpConsumer returns only when the handle closes (room end / unbind). Isolated per
  // media-tap's contract, so no await is threaded through the frame-publish path.
  void pumpConsumer(handle, consumer);
  return handle;
}
