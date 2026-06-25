// Task #81 (LK-rip Phase 6b) step 7 — voice-agent usage metering.
//
// Turns the step-3 `agent-turn-meter` structured-log SEAM into a REAL gateway usage emit. Mirrors
// src/metering.ts (emitParticipantUsage → POST /v1/internal/usage, Bearer service token, fractional
// meter_value, idempotent event_id) — same server-to-server convention, same fail-OPEN safety.
//
// PRIMARY meter: `voice_agent_minutes` — derived from the per-turn wall-time (ms → fractional minutes,
// NOT truncated). One line per turn, idempotent on (room, agentId, turnId). The llm/tts/tool counts are
// passed THROUGH as descriptive context for now (the gateway PRODUCT_METER for token/char sub-meters is a
// separate gateway PR — TODO below); voice_agent_minutes is the billable line that ships here.
//
// SAFETY: a metering-emit failure must NEVER break the turn or drop media — the emit is fire-and-forget +
// fail-OPEN (mirrors metering.ts). Pure body-builders are split from the I/O so accounting is unit-testable
// with no network.

/** Meter event name for billable voice-agent runtime. NOTE: the gateway PRODUCT_METER def for this name is a
 *  separate gateway-side PR (TODO #81) — we emit regardless; an undefined meter is dropped gateway-side, never
 *  a silent no-op here (config-no-silent-noop / proven-live-or-not-done). */
export const METER_VOICE_AGENT_MINUTES = "voice_agent_minutes";

/** The subset of env the voice meter reads. Both optional → INERT until an operator provisions both. */
export interface VoiceMeterEnv {
  /** Gateway origin, e.g. https://api.wave.online (var; not a secret). */
  GATEWAY_BASE_URL?: string;
  /** Internal service-to-service bearer for /v1/internal/usage (secret; deploy-time, never logged). */
  WAVE_SERVICE_TOKEN?: string;
}

/** One completed turn's measured usage, captured by TurnTakingCore at the end of a successful reply. */
export interface VoiceTurnUsage {
  org: string;
  room: string;
  agentId: string;
  /** Stable id for THIS turn (idempotency) — the core derives it from agentId + a turn counter. */
  turnId: string;
  /** Turn wall-time in ms (now-at-commit − now-at-turn-start). */
  turnWallMs: number;
  /** Descriptive pass-through counts (not billed by this line; carried for observability/future sub-meters). */
  llmChars?: number;
  ttsChars?: number;
  toolsUsed?: number;
}

/** One meter line to ingest — identical shape to metering.ts MeterLine (gateway src/usage.ts meter_value). */
export interface MeterLine {
  meter: string;
  /** Fractional value (minutes). Never truncated. */
  meter_value: number;
  /** Idempotent per (room, agentId, turn) — a retried emit is de-duped by the gateway. */
  event_id: string;
}

/** The gateway /v1/internal/usage envelope (matches gateway handleUsageIngest meter_value). */
export interface UsageEnvelope {
  org: string;
  usage: MeterLine;
}

/** Wall-ms → fractional MINUTES (NOT truncated; design fractional rule). Non-positive → 0 (never negative). */
export function turnMinutes(turnWallMs: number): number {
  if (!(turnWallMs > 0)) return 0;
  return turnWallMs / 60_000;
}

/**
 * Build the meter line(s) for one turn — PURE (no I/O), unit-testable. Returns one `voice_agent_minutes`
 * line when the turn had measurable wall-time, else [] (a zero/negative turn bills nothing). event_id is
 * stable per (room, agentId, turn).
 */
export function buildVoiceMeterLines(u: VoiceTurnUsage): MeterLine[] {
  const minutes = turnMinutes(u.turnWallMs);
  if (minutes <= 0) return [];
  return [
    {
      meter: METER_VOICE_AGENT_MINUTES,
      meter_value: minutes,
      event_id: `${u.room}:${u.agentId}:${u.turnId}:${METER_VOICE_AGENT_MINUTES}`,
    },
  ];
}

/** True only when an operator has provisioned BOTH the gateway URL and the service token (else INERT). */
export function isVoiceMeterProvisioned(env: VoiceMeterEnv): boolean {
  return Boolean(env.GATEWAY_BASE_URL && env.WAVE_SERVICE_TOKEN);
}

/**
 * Flush one turn's voice-agent usage to the gateway. Fire-and-forget friendly; NEVER throws and NEVER breaks
 * the turn (design media-safety). No-op (no network) when unprovisioned or nothing billable. Failures are
 * logged loud (config-no-silent-noop) but swallowed (fail-open) — a metering error must not affect the agent.
 */
export async function emitVoiceTurnUsage(
  env: VoiceMeterEnv,
  u: VoiceTurnUsage,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!isVoiceMeterProvisioned(env)) return; // INERT until operator provisions URL + token
  const lines = buildVoiceMeterLines(u);
  if (lines.length === 0) return; // nothing billable (zero/negative turn)

  const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
  const token = env.WAVE_SERVICE_TOKEN as string;

  for (const usage of lines) {
    const body: UsageEnvelope = { org: u.org, usage };
    try {
      const res = await fetchFn(`${base}/v1/internal/usage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Loud, but never blocking — observability only, no secret/PII in the line.
        console.warn(`voice-meter emit failed meter=${usage.meter} status=${res.status} org=${u.org}`);
      }
    } catch (e) {
      // Fail-open: a usage emit must NEVER affect the live voice-agent turn (media-safety).
      console.warn(`voice-meter emit error meter=${usage.meter} org=${u.org}: ${(e as Error)?.message ?? e}`);
    }
  }
}
