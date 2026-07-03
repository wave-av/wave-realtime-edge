// agent-turn-sink.ts — #76 P3 (arch A, co-locate): the READ port. Bridges the RoomDO MediaTap's `AgentFrameSink`
// seam (P2, agent-media-consumer.ts) onto the wave-native voice turn-loop (`TurnTakingCore`, agent-turn.ts). P2
// drained tapped frames into a counting RECEIPT; P3 drains them into the real VAD→STT→LLM→TTS loop. The tap
// wiring in `RoomDO.armAgentRead` is UNCHANGED — P2 built the sink as an INJECTED seam exactly so P3 lands here
// without re-touching the tap plumbing (see room.ts:649 note "swaps in a richer sink WITHOUT re-touching this
// wiring").
//
// ── TTS-OUT DECISION (spec §3 "decide where TTS-out publishes" — RESOLVED) ─────────────────────────────────────
//  Arch A folds the agent's media-READ onto the in-process tap (no 2nd SFU subscription). The agent's speak /
//  TTS-OUT still needs a publish track — it publishes via the SAME `createIngestAdapter` mechanism the live
//  `AgentSessionDO` uses today (agent-session.ts `buildMediaDeps`), only now the ingest adapter + outbound socket
//  are owned by the RoomDO. So arch A is symmetric: READ in-process via the tap, WRITE in-process via an ingest
//  adapter — NO cross-DO frame transport on either side. `buildTurnDeps()` takes the ingest half of
//  `AgentMediaDeps` verbatim; the EGRESS half (`createEgress`) is DEAD in arch A (the tap replaced the 2nd SFU
//  read). This module builds the pure, testable driver that slots into that; the LIVE SFU ingest-socket lifecycle
//  in the RoomDO is the ◆-arm slice (it cannot run until the room publishes into the tap AND `MEDIA_TAP_ENABLED`
//  is armed — both ◆ Jake), and the agent-bind intent must first be enriched to carry org/participantSessionId.
//
// ── INERT ──────────────────────────────────────────────────────────────────────────────────────────────────────
//  Nothing here runs in prod today: `RoomDO.armAgentRead` only builds a turn-loop sink when a driver is INJECTED,
//  and the agent-bind control-plane path injects none (→ the P2 counting receipt). `buildRoomTurnLoopDriver`
//  returns null unless `voiceAgentEnabled(env)`. Off → prod byte-identical.
import type { AgentFrameSink } from "./agent-media-consumer.js";
import type { TapFrame } from "./media-tap.js";
import type { AgentMediaDeps } from "./agent-session.js";
import { voiceAgentEnabled } from "./agent-session.js";
import {
  TurnTakingCore,
  buildTurnDeps,
  toolAllowlistFromEnv,
  ttsLeadMsFromEnv,
  type AgentTurnEnv,
  type TurnTakingConfig,
} from "./agent-turn.js";
import { vadConfigFromEnv } from "./agent-vad.js";

/**
 * The minimum turn-loop surface a sink drives — a STRUCTURAL subset of `TurnTakingCore` so this module is
 * unit-testable with a fake driver (no gateway / STT / TTS network). `onFrame` is the core's PCM entry point
 * (`TurnTakingCore.onFrame`); `close` releases the TTS-out ingest socket the core published on (on room-end /
 * unbind). Keeping the driver as an interface is what lets P3 land without importing live network adapters into
 * the test path.
 */
export interface TurnLoopDriver {
  /** Feed one decoded PCM frame into the turn state machine. Fail-safe: the core never throws up the media path. */
  onFrame(pcm: Uint8Array): void | Promise<void>;
  /** Release turn-loop resources on room-end / unbind (closes the ingest publish socket). Optional. */
  close?(): void;
}

/**
 * Bridge the P2 tap-consumer sink onto a turn-loop driver. This is the WHOLE READ port: a drained tapped frame
 * becomes a PCM frame the turn-loop consumes.
 *
 *  • audio-kind guard — defense-in-depth. The agent read's tap selector already narrows to `kind:["audio"]`
 *    (agent-media-consumer.ts), so a non-audio frame should never arrive; if one does we DROP it rather than feed
 *    video bytes to STT as if they were PCM.
 *  • fail-isolation — `TurnTakingCore` is itself fail-safe (every stage catches + abandons the turn, never throws
 *    up the media path). We ALSO isolate here: a sync throw or an async rejection from a fake/real driver is
 *    swallowed so a driver defect can NEVER propagate into `pumpConsumer` and stall the tap, the source, or a peer
 *    consumer (recorder, perception). The tap's backpressure isolation is preserved.
 *  • fire-and-forget — `onFrame` returns void to the pump; the core awaits its own STT/LLM/TTS internally.
 */
export function buildTurnLoopSink(driver: TurnLoopDriver): AgentFrameSink {
  return {
    onFrame(frame: TapFrame): void {
      if (frame.kind !== "audio") return; // the agent watches AUDIO; never feed non-audio bytes as PCM
      try {
        const r = driver.onFrame(frame.bytes);
        // The core's onFrame is async (STT/LLM/TTS). Swallow a rejection so it never escapes into the tap drain.
        if (r && typeof (r as Promise<void>).then === "function") {
          void (r as Promise<void>).catch(() => {
            /* core is fail-safe; swallow to protect the tap fan-out */
          });
        }
      } catch {
        /* a synchronous driver defect must never escape into pumpConsumer / the tap */
      }
    },
    onClose(): void {
      try {
        driver.close?.();
      } catch {
        /* release best-effort — never throw on teardown */
      }
    },
  };
}

/** Everything `buildRoomTurnLoopDriver` needs to construct a LIVE turn-loop for one co-located agent read. */
export interface RoomTurnLoopInputs {
  /** The turn env (gateway/STT/TTS creds referenced, never valued here). */
  readonly env: AgentTurnEnv;
  /**
   * The full turn config for this bound agent — roomId, org, agentId, participantSessionId, participantTrackName,
   * and the optional persona. NOTE: the P2 agent-bind intent currently forwards only agentId + participantTrackName
   * (room.ts); assembling the rest (org / participantSessionId / roomId) from an ENRICHED bind is part of the ◆-arm
   * slice. This module takes the assembled config so it stays pure + testable.
   */
  readonly config: TurnTakingConfig;
  /**
   * The media seam. Only the INGEST (TTS-out) half is live in arch A — `createIngest` + `ingestSocket` + `now` +
   * `log`. `createEgress` is DEAD (the tap replaced the 2nd SFU read); it is still present on the interface for
   * type-compat but is never called by the co-located loop.
   */
  readonly media: AgentMediaDeps;
  /** Tenant for gateway attribution (x-wave-org). Defaults to config.org. */
  readonly org?: string;
  /** Injectable fetch for tests; defaults to the platform fetch (same convention as agent-session `__agentFetch`). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Construct the LIVE turn-loop driver for one co-located agent read — the arch-A mirror of
 * `AgentSessionDO.armTurnTaking` (agent-session.ts:447), differing ONLY in that the READ is driven by tapped
 * frames (via `buildTurnLoopSink`) instead of a 2nd SFU egress socket. Wires the same live deps from env
 * (`buildTurnDeps`: transcribe → WAVE transcribe spoke, complete → gateway LLM proxy, synthesize → ElevenLabs,
 * emitMeter → voice_agent_minutes) and the same barge-in / tool / TTS-pacing opts.
 *
 * Returns null when `voiceAgentEnabled(env)` is false (VOICE_AGENT_PROVIDER!=="wave") — fail-closed, the room then
 * keeps the P2 counting receipt. `close()` closes the ingest publish socket so a room-end releases the TTS-out
 * track. Construction is the caller's to guard behind the arm; this function itself opens no socket.
 */
export function buildRoomTurnLoopDriver(inputs: RoomTurnLoopInputs): TurnLoopDriver | null {
  if (!voiceAgentEnabled(inputs.env)) return null;
  const org = inputs.org ?? inputs.config.org;
  const deps = buildTurnDeps(inputs.env, inputs.media, inputs.fetchImpl ?? fetch, org);
  const tools = toolAllowlistFromEnv(inputs.env); // step 5: agent-least-privilege allowlist (env-driven)
  const core = new TurnTakingCore(deps, inputs.config, {
    framing: inputs.env.AGENT_INGEST_FRAMING,
    vad: vadConfigFromEnv(inputs.env), // step 4: barge-in VAD thresholds (env-overridable)
    ttsLeadMs: ttsLeadMsFromEnv(inputs.env), // step 4: real-time TTS pacing → interruptible playout (barge-in)
    tools, // step 5: only these tools are advertised to the model + executable
  });
  return {
    onFrame: (pcm) => core.onFrame(pcm),
    close: () => {
      try {
        inputs.media.ingestSocket()?.close?.();
      } catch {
        /* best-effort — teardown never throws */
      }
    },
  };
}
