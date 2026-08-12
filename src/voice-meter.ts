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

/** Meter event name for billable voice-agent runtime.
 *
 *  HISTORY, kept because it cost seven weeks of revenue. This comment used to say the gateway-side
 *  definition was "a separate gateway-side PR (TODO #81) — we emit regardless; an undefined meter is
 *  dropped gateway-side, never a silent no-op here." The first half was true and the second half was
 *  FALSE, and nothing here could tell the difference: the gateway's ingest door is deliberately fail-open,
 *  so it acked `200 {ok:true, recorded:0}` on every dropped turn while this emitter checked only `res.ok`.
 *  It WAS a silent no-op, at both ends, from 2026-06-25. The gateway-side billing registry now carries
 *  the dimension, and emitVoiceTurnUsage below now reads `recorded`, not just the status — so the claim
 *  this comment makes is finally mechanically true rather than merely intended. */
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
 * The returned promise settles after the FIRST attempt; a 429's single retry is detached and never extends
 * the caller's await (the caller holds `turnInFlight`, so an awaited wait here would stall the next turn).
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
      const res = await postUsage(fetchFn, base, token, body);
      // ONE retry on 429, and only on 429. The gateway's ingest limiter is per-ORG (its buckets are
      // minute-scoped), so a 429 is a transient fairness signal rather than a defect — but a dropped
      // usage line is unrecoverable revenue, so it is worth exactly one cheap retry. `retry-after` is
      // clamped: an upstream must not be able to park the metering task for an arbitrary time.
      //
      // The retry is DETACHED, never awaited. This emit is awaited at the end of every turn while
      // `turnInFlight` blocks the next one (TurnTakingCore.runTurn → logMeter → emitMeter), so an inline
      // sleep here — the first shape of this fix — stalled the live conversation for up to 2s whenever
      // ingest rate-limited. The retry re-sends the IDENTICAL body (event_id dedup ⇒ it can never
      // double-bill), settles its own receipt, and swallows its own errors (fail-open); losing it on
      // teardown is acceptable — it was best-effort recovery of an already-429'd line.
      if (res.status === 429) {
        // A missing/blank header must take the 1s default: `Number(null)` and `Number("")` are BOTH 0,
        // and an instant re-send into the same minute-scoped limiter would almost always 429 again.
        const raw = res.headers.get("retry-after");
        const after = raw === null || raw.trim() === "" ? NaN : Number(raw);
        // `after >= 0`: an explicit `retry-after: 0` means "retry now" and must not fall through to the 1s default.
        const waitMs = Math.min(Number.isFinite(after) && after >= 0 ? after * 1000 : 1000, 2000);
        setTimeout(() => {
          postUsage(fetchFn, base, token, body)
            .then((retryRes) => settleReceipt(retryRes, usage.meter, u.org))
            .catch((e) =>
              console.warn(`voice-meter emit error meter=${usage.meter} org=${u.org}: ${(e as Error)?.message ?? e}`),
            );
        }, waitMs);
        continue;
      }
      await settleReceipt(res, usage.meter, u.org);
    } catch (e) {
      // Fail-open: a usage emit must NEVER affect the live voice-agent turn (media-safety).
      console.warn(`voice-meter emit error meter=${usage.meter} org=${u.org}: ${(e as Error)?.message ?? e}`);
    }
  }
}

/** Judge one ingest response — shared by the inline path and the detached 429 retry. Warns, never throws. */
async function settleReceipt(res: Response, meter: string, org: string): Promise<void> {
  if (!res.ok) {
    // Loud, but never blocking — observability only, no secret/PII in the line.
    console.warn(`voice-meter emit failed meter=${meter} status=${res.status} org=${org}`);
    return;
  }
  // A 200 IS NOT AN ACK. handleUsageIngest is deliberately fail-open — it answers
  // `{ok:true, recorded:N}` even when the record failed, and signals that with `recorded:0`. So a
  // meter the gateway does not carry produced 200/recorded:0 and this emitter, which only checked
  // `res.ok`, read it as SUCCESS. That is exactly how voice_agent_minutes was dropped on every turn
  // from 2026-06-25 while both ends logged success. `recorded` is the real receipt; read it.
  const { recorded, deduped } = await ingestReceipt(res);
  // `deduped` excluded deliberately: an idempotent re-emit legitimately records 0 dimensions and is
  // HEALTHY. Warning on it would fire on every retry and train the reader to ignore the one warning
  // that means lost revenue.
  if (recorded === 0 && !deduped) {
    console.warn(
      `voice-meter DROPPED meter=${meter} org=${org}: gateway acked 200 but recorded:0 — the ` +
        `meter is not registered in the gateway billing registry, or every dimension zeroed. This usage ` +
        `is NOT billed and is NOT recoverable. Register the meter gateway-side; do not ignore this line.`,
    );
  }
}

/** One POST to the gateway usage door. Split out so the 429 retry re-sends the IDENTICAL body — the
 *  event_id is idempotent, so a retry the gateway already recorded de-dupes rather than double-billing. */
function postUsage(fetchFn: typeof fetch, base: string, token: string, body: UsageEnvelope) {
  return fetchFn(`${base}/v1/internal/usage`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** The ingest response's own account of what it did: `{recorded, deduped}`.
 *
 *  `recorded` is `null` when it cannot be read, and null is NOT treated as a drop — an unparseable body is
 *  an observability failure, and inventing a drop warning from one would train the reader to ignore the
 *  warning that matters. Only an explicit `recorded: 0` on a NON-deduped ingest is a drop. */
async function ingestReceipt(res: Response): Promise<{ recorded: number | null; deduped: boolean }> {
  try {
    const j = (await res.clone().json()) as { recorded?: unknown; deduped?: unknown };
    const recorded = typeof j?.recorded === "number" && Number.isFinite(j.recorded) ? j.recorded : null;
    return { recorded, deduped: j?.deduped === true };
  } catch {
    return { recorded: null, deduped: false };
  }
}
