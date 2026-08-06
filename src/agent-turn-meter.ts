/**
 * Task #81 — per-turn HONEST counts + the real `voice_agent_minutes` usage emit.
 *
 * Split out of agent-turn.ts along a real seam (file-size-two-tier-gate): turn POLICY (VAD, the agentic loop,
 * history) stays there; "account for a finished turn" is this file's one job. Behaviour is unchanged from the
 * former `TurnTakingCore.logMeter` — same event name, same fields, same FAIL-OPEN emit — plus the D1 `ttfaMs`
 * field (time-to-first-audio), which is the receipt the sentence-streaming fix is measured by.
 */
import type { VoiceTurnUsage } from "./voice-meter.js";

/** The deps this needs: the structured logger, the (fail-open) usage emit, and the clock. */
export interface TurnMeterDeps {
  log(event: string, fields: Record<string, unknown>): void;
  emitMeter(usage: VoiceTurnUsage): Promise<void>;
  now(): number;
}

export interface TurnMeterInput {
  org: string;
  room: string;
  agentId: string;
  turnId: string;
  userText: string;
  assistant: string;
  toolsUsed: number;
  pcmBytesOut: number;
  /** Turn start (deps.now() at the top of runTurn). */
  startMs: number;
  /** deps.now() when the FIRST audio frame hit the wire, or -1 if nothing was published. */
  firstAudioMs: number;
}

/**
 * Structured-log the honest per-turn counts AND emit the real `voice_agent_minutes` usage to the gateway
 * (step 7). The emit is FAIL-OPEN: awaited inside a try/catch so a metering error (or a thrown fake) is logged
 * and swallowed — it NEVER breaks the turn or drops media. turnWallMs drives the billable fractional minutes.
 *
 * `ttfaMs` = first audio ON THE WIRE minus turn start. This is the D1 metric: it used to be
 * `STT + the whole LLM stream + first TTS chunk`; with sentence-streaming it is `STT + first sentence + TTS`.
 * -1 means nothing was published (no ingest socket, or the turn died before any audio).
 */
export async function logTurnMeter(deps: TurnMeterDeps, ids: Record<string, unknown>, m: TurnMeterInput): Promise<void> {
  const turnWallMs = deps.now() - m.startMs;
  deps.log("agent-turn-meter", {
    ...ids,
    turnId: m.turnId,
    userChars: m.userText.length,
    assistantChars: m.assistant.length,
    toolsUsed: m.toolsUsed,
    pcmBytesOut: m.pcmBytesOut,
    turnWallMs,
    ttfaMs: m.firstAudioMs < 0 ? -1 : m.firstAudioMs - m.startMs,
  });
  try {
    await deps.emitMeter({
      org: m.org,
      room: m.room,
      agentId: m.agentId,
      turnId: m.turnId,
      turnWallMs,
      llmChars: m.assistant.length,
      ttsChars: m.assistant.length,
      toolsUsed: m.toolsUsed,
    });
  } catch (e) {
    // Fail-open: a metering error must NEVER break the turn (media-safety). Logged, swallowed. `turnId` is in
    // the log because gateway idempotency is keyed per turn — a dropped usage line must be reconcilable/replayable
    // from this event alone.
    deps.log("agent-turn-meter-error", { ...ids, turnId: m.turnId, message: (e as Error)?.message ?? "unknown" });
  }
}
