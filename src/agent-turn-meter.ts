/**
 * Task #81 — per-turn HONEST counts + the real `voice_agent_minutes` usage emit.
 *
 * Split out of agent-turn.ts along a real seam (file-size-two-tier-gate): turn POLICY (VAD, the agentic loop,
 * history) stays there; "account for a finished turn" is this file's one job. Behaviour is unchanged from the
 * former `TurnTakingCore.logMeter` — same event name, same fields, same FAIL-OPEN emit — plus the D1 `ttfaMs`
 * field (time-to-first-audio), which is the receipt the sentence-streaming fix is measured by.
 */
import type { VoiceTurnUsage } from "./voice-meter.js";
import { voiceTurnCogs, type VoiceCogsRates, type VoiceTurnCogsTerms } from "./voice-cogs.js";
import type { TurnCogsLedger, TurnCogsClose } from "./voice-cogs-ledger.js";

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
  /** E0-P2 — this turn's measured COGS quantities (from `TurnCogsLedger.closeTurn`). */
  cogs: VoiceTurnCogsTerms;
  /** E0-P2 — vendor rates, if any are provisioned. Absent ⇒ quantities are reported `unpriced`, never guessed. */
  cogsRates?: VoiceCogsRates;
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
  // E0-P2 — the COGS receipt, on its OWN event and deliberately NOT on the billable line.
  //
  // These are COST quantities, not customer usage. Adding them to the usage envelope would make them look like
  // billable dimensions to every downstream reader of the gateway's raw-usage plane, and inventing a billable
  // identity is the exact mistake this epic already corrected once (R25: `voice_agent_minutes` must not become a
  // catalog meter). The billable line stays exactly one thing — turn wall-minutes — and cost is observed beside
  // it. `unitCostUsd` is present only when rates were provisioned WITH a source; otherwise `provenance` says
  // `unpriced` and the quantities stand alone, which is an honest half-answer rather than a fabricated whole one.
  const cogs = voiceTurnCogs(m.cogs, m.cogsRates);
  deps.log("agent-turn-cogs", { ...ids, turnId: m.turnId, ...m.cogs, ...cogs });
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

/** Who the turn belongs to, plus the session-scoped state the per-turn accounting reads. */
export interface TurnMeterWho {
  org: string;
  room: string;
  agentId: string;
  /** E0-P2 session ledger — closed exactly once per metered turn (it advances the DO mark). */
  ledger: TurnCogsLedger;
  /** E0-P2 vendor rates, if provisioned. */
  rates?: VoiceCogsRates;
}

/** The per-turn facts the caller holds. `speech` carries both the TTS counters and the TTFA receipt. */
export interface TurnMeterFacts extends Pick<TurnCogsClose, "ttsCharsHeard"> {
  userText: string;
  assistant: string;
  toolsUsed: number;
  turnId: string;
  /** Turn start (the core's `now()` at the top of runTurn). */
  startMs: number;
  speech: NonNullable<TurnCogsClose["speech"]> & { firstAudioMs: number };
}

/**
 * Account for one finished turn: close the COGS ledger, then hand everything to `logTurnMeter`.
 *
 * This lives here rather than in agent-turn.ts because "account for a finished turn" is this file's one job, and
 * agent-turn.ts is past the token tier of the two-tier file-size gate — where the rule is DECOMPOSE, never trim.
 * Turn wall-time is computed HERE, from the same clock the ledger uses, so the turn's billable minutes and its
 * `idleAmplification` denominator can never come from two different clocks.
 */
export async function meterFinishedTurn(
  deps: TurnMeterDeps,
  ids: Record<string, unknown>,
  who: TurnMeterWho,
  t: TurnMeterFacts,
): Promise<void> {
  const turnWallMs = deps.now() - t.startMs;
  await logTurnMeter(deps, ids, {
    org: who.org,
    room: who.room,
    agentId: who.agentId,
    turnId: t.turnId,
    userText: t.userText,
    assistant: t.assistant,
    toolsUsed: t.toolsUsed,
    pcmBytesOut: t.speech.pcmBytesOut,
    startMs: t.startMs,
    firstAudioMs: t.speech.firstAudioMs,
    cogs: who.ledger.closeTurn({ turnWallMs, speech: t.speech, ttsCharsHeard: t.ttsCharsHeard }),
    cogsRates: who.rates,
  });
}
