/**
 * E0-P2 (floor-control-not-turn-taking) — MEASURE the three omitted voice COGS terms.
 *
 * The epic's finding: `marginGuard`'s cost input omits ~43.5% of true voice COGS across three terms —
 * barge-in TTS synthesis wastage, streaming-STT silence, and Durable Object duration. A floor evaluated
 * against a number missing 43.5% of its input is not a floor. This module is the MEASUREMENT half.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE, both learned the hard way in this epic:
 *
 * 1. **Quantities and PRICES are separate claims.** "Measured COGS" means we measured the QUANTITIES the
 *    vendor bills on. Turning a quantity into dollars needs a vendor RATE, and a rate we did not read off
 *    an invoice is a guess wearing a number's clothes. So `rates` is an ARGUMENT with no default: absent
 *    rates yield `provenance: "unpriced"` and the quantities are still reported. There is no code path in
 *    this file that invents a rate, and `"estimated"` is not a value `provenance` can take — the catalog's
 *    `cogs.status: "estimated"` is exactly what this phase exists to retire, so it must not be reachable
 *    from the instrument meant to replace it.
 *
 * 2. **A term that was not measured is never zero.** A missing/NaN/negative quantity yields
 *    `provenance: "invalid"`, never a silently-zeroed addend. A cost model that treats absence as $0 is the
 *    same defect class as the dead meter this epic opened on: both ends report success while the number
 *    is wrong in the direction that flatters us.
 *
 * PURE: no I/O, no env, no clock, no network. Every input arrives as an argument.
 */

/** Bytes per millisecond of the PCM this stack moves everywhere: 48 kHz · 2 ch · 16-bit LE. */
export const PCM_BYTES_PER_MS = (48_000 * 2 * 2) / 1000;

/** ms → minutes as a FRACTION (never truncated) — the same fractional rule `turnMinutes` uses. */
const MINUTES = (ms: number) => ms / 60_000;

/**
 * One turn's RAW measured quantities. Every field is a thing a vendor invoice or a platform bill can be
 * reconciled against (P4), not a derived estimate.
 */
export interface VoiceTurnCogsTerms {
  /** Turn wall-time (ms) — the BILLABLE quantity: `voice_agent_minutes` is this in fractional minutes. */
  turnWallMs: number;
  /**
   * TTS characters SUBMITTED to the vendor this turn. This is what is billed: a synthesis request is paid
   * for in full the moment it is issued, and a barge-in only stops us CONSUMING the stream. Counted at the
   * call, not at playout, because that is where the money leaves.
   */
  ttsCharsSubmitted: number;
  /**
   * TTS characters the listener actually HEARD — pieces with audio on the wire, using the codebase's own rule
   * (any audio published ⇒ heard, because a listener cannot un-hear a half-sentence). The gap to
   * `ttsCharsSubmitted` is the DEFINITE barge-in wastage: text paid for and never rendered at all.
   */
  ttsCharsHeard: number;
  /**
   * Characters of pieces cut AFTER some audio was published. Counted as fully heard above, so they contribute
   * ZERO to definite wastage while genuinely being partly wasted. Kept as its own quantity so the wastage term
   * is a stated LOWER BOUND with a named remainder, rather than a number that quietly understates.
   */
  ttsCharsCutMidPiece: number;
  /** Audio milliseconds actually published to the wire (`pcmBytesOut / PCM_BYTES_PER_MS`). */
  ttsAudioMsPublished: number;
  /** How many `speak()` calls this turn were cut by a barge-in (each one submitted, partly-or-never heard). */
  ttsAbortedSpeaks: number;
  /** Audio milliseconds SUBMITTED to STT this turn (the WAV actually POSTed) — what the STT vendor bills. */
  sttAudioMsSubmitted: number;
  /** How many STT requests this turn issued (batch architecture ⇒ normally 1). */
  sttCalls: number;
  /**
   * Durable Object wall-ms ATTRIBUTABLE TO THIS TURN — alive-time since the previous turn's emit (or since
   * the core was constructed, for the first turn). Attributable rather than cumulative so that summing every
   * turn's term over a session equals the session's DO duration exactly, with no double-count. THIS is the
   * term that carries idle time: a silent minute between turns lands on the next turn's slice, which is
   * precisely the cost the per-turn meter cannot see.
   */
  doWallMsAttributed: number;
  /** Cumulative DO alive-ms at this turn (diagnostic only; a LOWER BOUND — see `coreAliveMs` in agent-turn). */
  doAliveMsCumulative: number;
}

/**
 * Vendor/platform unit prices. NO DEFAULTS, deliberately — see rule 1 in the file header. `source` is
 * required alongside any rate so a later reader can tell an invoice-grounded number from a recalled one.
 */
export interface VoiceCogsRates {
  /** USD per TTS character submitted. */
  ttsUsdPerChar?: number;
  /** USD per MINUTE of audio submitted to STT. */
  sttUsdPerAudioMinute?: number;
  /** USD per MINUTE of Durable Object wall-clock. */
  doUsdPerWallMinute?: number;
  /** Where these numbers came from (invoice, pricing page + date). Required for `provenance: "measured"`. */
  source?: string;
}

export type VoiceCogsProvenance = "measured" | "unpriced" | "invalid";

export interface VoiceTurnCogs {
  provenance: VoiceCogsProvenance;
  /** Why, when provenance is not "measured" — a named reason, never a silent degrade. */
  reason?: string;
  /** Per-term USD, present only when priced. */
  ttsUsd?: number;
  sttUsd?: number;
  doUsd?: number;
  totalUsd?: number;
  /**
   * COGS per BILLED unit — total turn cost divided by the turn's billable minutes. This is the number the
   * catalog's `cogs.unit_cost_usd` is expressed in for a per-minute meter, so it is directly comparable to
   * the price. Absent when the turn billed nothing (a zero-length turn has no unit to divide by).
   */
  unitCostUsd?: number;
  /**
   * TTS characters paid for and never rendered at all — the barge-in wastage term, and a LOWER BOUND on true
   * wastage: pieces cut mid-render count as heard, so their unrendered remainder is not in this number. See
   * `bargeInCutMidPieceChars` for the size of that unresolved remainder.
   */
  bargeInWastageChars: number;
  /** Characters cut mid-render — partly wasted by an amount this instrument cannot resolve at character level. */
  bargeInCutMidPieceChars: number;
  /** Wastage as a fraction of submitted characters (0 when nothing was submitted). */
  bargeInWastageFraction: number;
  /**
   * DO wall-time divided by billable turn time. 1.0 means every DO second was billed; 8.0 means the meter
   * sees one eighth of the duration the platform charges for. The idle-amplification factor the epic's
   * "$4,050/mo per 1,000 idle sessions" claim is really about.
   */
  idleAmplification?: number;
}

/** Finite, non-negative, and actually supplied. A term that fails this was NOT measured — never treat as 0. */
const measured = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Compute one turn's COGS from its measured terms and (optionally) vendor rates.
 *
 * Returns quantities ALWAYS and dollars only when every rate needed is supplied with a source. Never throws:
 * this runs on the metering path, which is fail-open, so a bad input must degrade to a NAMED reason rather
 * than to an exception or a zero.
 */
export function voiceTurnCogs(terms: VoiceTurnCogsTerms, rates?: VoiceCogsRates): VoiceTurnCogs {
  const quantityFields = [
    "turnWallMs",
    "ttsCharsSubmitted",
    "ttsCharsHeard",
    "ttsCharsCutMidPiece",
    "ttsAudioMsPublished",
    "ttsAbortedSpeaks",
    "sttAudioMsSubmitted",
    "sttCalls",
    "doWallMsAttributed",
    "doAliveMsCumulative",
  ] as const;
  const bad = quantityFields.filter((f) => !measured(terms?.[f]));
  if (bad.length > 0) {
    return {
      provenance: "invalid",
      reason: `unmeasured term(s): ${bad.join(",")}`,
      bargeInWastageChars: 0,
      bargeInCutMidPieceChars: 0,
      bargeInWastageFraction: 0,
    };
  }

  // Quantities — always reported, rates or not.
  const submitted = terms.ttsCharsSubmitted;
  // Heard can exceed submitted only if a caller mis-wires the two; clamp so wastage is never negative, which
  // would read as a CREDIT and quietly offset real wastage on another turn.
  const wastageChars = Math.max(0, submitted - Math.min(terms.ttsCharsHeard, submitted));
  const wastageFraction = submitted > 0 ? wastageChars / submitted : 0;
  const billableMinutes = MINUTES(terms.turnWallMs);
  const idleAmplification = terms.turnWallMs > 0 ? terms.doWallMsAttributed / terms.turnWallMs : undefined;

  const quantities: VoiceTurnCogs = {
    provenance: "unpriced",
    bargeInWastageChars: wastageChars,
    bargeInCutMidPieceChars: terms.ttsCharsCutMidPiece,
    bargeInWastageFraction: wastageFraction,
    idleAmplification,
  };

  const missingRates = (
    [
      ["ttsUsdPerChar", rates?.ttsUsdPerChar],
      ["sttUsdPerAudioMinute", rates?.sttUsdPerAudioMinute],
      ["doUsdPerWallMinute", rates?.doUsdPerWallMinute],
    ] as const
  )
    .filter(([, v]) => !measured(v))
    .map(([k]) => k);
  if (missingRates.length > 0) {
    return { ...quantities, reason: `no rate for: ${missingRates.join(",")}` };
  }
  if (!rates?.source) {
    // A rate with no stated origin cannot support a "measured" claim — that is the whole point of P2.
    return { ...quantities, reason: "rates supplied without a `source`" };
  }

  const ttsUsd = submitted * (rates.ttsUsdPerChar as number);
  const sttUsd = MINUTES(terms.sttAudioMsSubmitted) * (rates.sttUsdPerAudioMinute as number);
  const doUsd = MINUTES(terms.doWallMsAttributed) * (rates.doUsdPerWallMinute as number);
  const totalUsd = ttsUsd + sttUsd + doUsd;

  return {
    ...quantities,
    provenance: "measured",
    reason: undefined,
    ttsUsd,
    sttUsd,
    doUsd,
    totalUsd,
    unitCostUsd: billableMinutes > 0 ? totalUsd / billableMinutes : undefined,
  };
}

/**
 * Read the (optional) vendor rates off env. Absent → undefined, so `voiceTurnCogs` reports `unpriced`
 * rather than inventing a price. Rates are configuration, not secrets, but they ARE a money input, so a
 * malformed value is dropped rather than coerced.
 */
export interface VoiceCogsRatesEnv {
  VOICE_COGS_TTS_USD_PER_CHAR?: string;
  VOICE_COGS_STT_USD_PER_AUDIO_MIN?: string;
  VOICE_COGS_DO_USD_PER_WALL_MIN?: string;
  VOICE_COGS_RATES_SOURCE?: string;
}

const num = (s: string | undefined): number | undefined => {
  if (typeof s !== "string" || s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function voiceCogsRatesFromEnv(env: VoiceCogsRatesEnv): VoiceCogsRates | undefined {
  const r: VoiceCogsRates = {
    ttsUsdPerChar: num(env.VOICE_COGS_TTS_USD_PER_CHAR),
    sttUsdPerAudioMinute: num(env.VOICE_COGS_STT_USD_PER_AUDIO_MIN),
    doUsdPerWallMinute: num(env.VOICE_COGS_DO_USD_PER_WALL_MIN),
    source: env.VOICE_COGS_RATES_SOURCE?.slice(0, 200) || undefined,
  };
  const anySet = r.ttsUsdPerChar !== undefined || r.sttUsdPerAudioMinute !== undefined || r.doUsdPerWallMinute !== undefined;
  return anySet ? r : undefined;
}
