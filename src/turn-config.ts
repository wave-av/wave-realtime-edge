/**
 * Turn pacing + buffer configuration — extracted from agent-turn.ts under the file-size gate
 * (DECOMPOSE law: a cohesive module, never a trim). Pure constants + one pure resolver.
 */

/** Step-5 hard default cap on tool-call iterations within ONE turn (anti-runaway). Overridable per-core. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 5;

/**
 * Step-4 barge-in: the TTS send-ahead LEAD (ms). `speak()` paces chunks to the real playout clock, never letting
 * the SFU buffer get more than this far ahead. This is the keystone that makes barge-in interrupt the agent the
 * LISTENER actually hears: with a shallow buffer, (a) `turnInFlight` spans the whole PLAYOUT (so a VAD speech-start
 * during the reply fires `bargeIn()`, not just during generation), and (b) on abort only ≤lead of already-sent
 * audio drains → the agent goes silent within ~lead + jitter. 0 disables pacing (legacy bulk send). 150ms keeps a
 * safe anti-underrun cushion while leaving headroom under the 300ms target; env-overridable (AGENT_TTS_LEAD_MS).
 */
export const DEFAULT_TTS_LEAD_MS = 150;

/** Resolve the TTS pacing lead from env (AGENT_TTS_LEAD_MS), clamped to ≥0; falls back to the default. Pure. */
export function ttsLeadMsFromEnv(env: { AGENT_TTS_LEAD_MS?: string | number }): number {
  const raw = typeof env.AGENT_TTS_LEAD_MS === "string" ? Number(env.AGENT_TTS_LEAD_MS) : env.AGENT_TTS_LEAD_MS;
  return Number.isFinite(raw) && (raw as number) >= 0 ? Math.floor(raw as number) : DEFAULT_TTS_LEAD_MS;
}

/**
 * Hard cap on the accumulated-utterance PCM buffer (bounded-backpressure). The buffer holds participant PCM
 * since the last FINAL transcript; without a cap it grows for the WHOLE session when audio never endpoints (a
 * continuous talker, partial-only STT, or a long in-flight turn) and resets the DO isolate at the 128 MB cap —
 * which kills the turn before TTS publishes. ~15 s of 48 kHz / 16-bit / stereo PCM (192 KB/s) ≈ 5.76 MB is far
 * more than any single utterance needs and stays well under the isolate limit; over the cap we evict OLDEST
 * frames (keep the most recent context for STT + barge-in). Pure constant → unit-testable.
 */
export const MAX_UTTERANCE_BYTES = 48_000 * 2 * 2 * 15;
