import { describe, expect, it } from "vitest";
import {
  PCM_BYTES_PER_MS,
  voiceCogsRatesFromEnv,
  voiceTurnCogs,
  type VoiceCogsRates,
  type VoiceTurnCogsTerms,
} from "../src/voice-cogs.js";

/**
 * These tests assert the PROPERTIES this module exists to guarantee, not examples of them.
 *
 * That distinction is not stylistic here — it is the lesson this epic paid for three times in one session
 * (a prior incident in an internal repo): a sanitizer test asserted `evil:1234 -> evil_1234` (the MAPPING) and passed against an
 * implementation that collapsed two distinct orgs onto one key, which was the exact collision the sanitizer
 * existed to prevent. An example-shaped test on a property-shaped contract is worse than no test, because it
 * buys confidence. So: "absence never reads as zero", "wastage is never negative", "provenance can never be
 * 'estimated'" — the contracts — rather than "these inputs produce this number".
 */

const TERMS: VoiceTurnCogsTerms = {
  turnWallMs: 6_000,
  ttsCharsSubmitted: 400,
  ttsCharsHeard: 400,
  ttsCharsCutMidPiece: 0,
  ttsAudioMsPublished: 4_000,
  ttsAbortedSpeaks: 0,
  sttAudioMsSubmitted: 3_000,
  sttCalls: 1,
  doWallMsAttributed: 30_000,
  doAliveMsCumulative: 120_000,
};

const RATES: VoiceCogsRates = {
  ttsUsdPerChar: 0.00003,
  sttUsdPerAudioMinute: 0.0043,
  doUsdPerWallMinute: 0.0000075,
  source: "test-fixture rates — NOT an invoice",
};

const QUANTITY_FIELDS = Object.keys(TERMS) as (keyof VoiceTurnCogsTerms)[];

describe("voiceTurnCogs — provenance is a claim, not a default", () => {
  it("never returns 'estimated' for ANY input, priced or not — that value must be unreachable", () => {
    // The catalog's `cogs.status: "estimated"` is what this phase exists to retire. If the instrument meant
    // to replace it could itself emit "estimated", the phase would be circular. Property, not example:
    // sweep priced/unpriced/invalid and assert the value never appears.
    const cases = [
      voiceTurnCogs(TERMS, RATES),
      voiceTurnCogs(TERMS),
      voiceTurnCogs({ ...TERMS, turnWallMs: Number.NaN }, RATES),
      voiceTurnCogs(undefined as unknown as VoiceTurnCogsTerms, RATES),
    ];
    for (const c of cases) expect(c.provenance).not.toBe("estimated");
    expect(new Set(cases.map((c) => c.provenance))).toEqual(new Set(["measured", "unpriced", "invalid"]));
  });

  it("a MISSING term is 'invalid', never a silently-zeroed addend — for every term independently", () => {
    // The dead-meter failure class, one layer up: absence must not read as a healthy zero. Asserted per
    // field rather than on one representative, because a guard that covers 8 of 9 fields looks identical
    // to one that covers all 9 until the 9th is the one that goes missing.
    for (const f of QUANTITY_FIELDS) {
      for (const bogus of [undefined, Number.NaN, -1, Infinity]) {
        const got = voiceTurnCogs({ ...TERMS, [f]: bogus } as VoiceTurnCogsTerms, RATES);
        expect(got.provenance, `${f}=${String(bogus)}`).toBe("invalid");
        expect(got.totalUsd, `${f}=${String(bogus)}`).toBeUndefined();
        expect(got.reason).toContain(f);
      }
    }
  });

  it("a missing RATE is 'unpriced' with the rate NAMED, and quantities survive", () => {
    for (const f of ["ttsUsdPerChar", "sttUsdPerAudioMinute", "doUsdPerWallMinute"] as const) {
      const got = voiceTurnCogs(TERMS, { ...RATES, [f]: undefined });
      expect(got.provenance, f).toBe("unpriced");
      expect(got.reason).toContain(f);
      expect(got.unitCostUsd).toBeUndefined();
      // The measurement is still delivered — an unpriced turn is not an unmeasured one.
      expect(got.bargeInWastageChars).toBeTypeOf("number");
    }
  });

  it("rates without a `source` cannot support a 'measured' claim", () => {
    const got = voiceTurnCogs(TERMS, { ...RATES, source: undefined });
    expect(got.provenance).toBe("unpriced");
    expect(got.totalUsd).toBeUndefined();
  });
});

describe("voiceTurnCogs — the barge-in wastage term", () => {
  it("wastage is ZERO exactly when everything submitted was heard, and POSITIVE otherwise", () => {
    // The contract is the iff, not a sample point.
    for (let heard = 0; heard <= 400; heard += 40) {
      const got = voiceTurnCogs({ ...TERMS, ttsCharsHeard: heard }, RATES);
      expect(got.bargeInWastageChars === 0).toBe(heard >= 400);
      expect(got.bargeInWastageChars).toBe(400 - heard);
    }
  });

  it("wastage is NEVER negative — heard > submitted cannot become a credit", () => {
    // A negative wastage would silently offset real wastage on another turn when these are summed, which is
    // the direction that flatters us. Clamped, and asserted as the property across a range.
    for (const heard of [401, 1_000, 10 ** 9]) {
      const got = voiceTurnCogs({ ...TERMS, ttsCharsHeard: heard }, RATES);
      expect(got.bargeInWastageChars).toBe(0);
      expect(got.bargeInWastageFraction).toBe(0);
    }
  });

  it("cost is driven by SUBMITTED characters, not heard ones — the whole point of the term", () => {
    // If the model billed on `heard`, the wastage term would be invisible again. Two turns with identical
    // submitted counts must cost the same regardless of how much was heard.
    const allHeard = voiceTurnCogs({ ...TERMS, ttsCharsHeard: 400 }, RATES);
    const noneHeard = voiceTurnCogs({ ...TERMS, ttsCharsHeard: 0 }, RATES);
    expect(noneHeard.ttsUsd).toBe(allHeard.ttsUsd);
    expect(noneHeard.bargeInWastageChars).toBeGreaterThan(allHeard.bargeInWastageChars);
  });

  it("fraction is 0 when nothing was submitted (no division by zero)", () => {
    const got = voiceTurnCogs({ ...TERMS, ttsCharsSubmitted: 0, ttsCharsHeard: 0 }, RATES);
    expect(got.bargeInWastageFraction).toBe(0);
    expect(Number.isFinite(got.totalUsd as number)).toBe(true);
  });
});

describe("voiceTurnCogs — cost is monotonic in every term", () => {
  it("increasing ANY billed quantity strictly increases total cost", () => {
    // The property that makes the number trustworthy: no term is accidentally dropped from the sum. A term
    // wired up but never added would pass an equality test on a fixture and fail this one.
    const base = voiceTurnCogs(TERMS, RATES).totalUsd as number;
    for (const f of ["ttsCharsSubmitted", "sttAudioMsSubmitted", "doWallMsAttributed"] as const) {
      const more = voiceTurnCogs({ ...TERMS, [f]: TERMS[f] * 2 }, RATES).totalUsd as number;
      expect(more, `${f} must move the total`).toBeGreaterThan(base);
    }
  });

  it("terms that are NOT billed do not move the total (they are diagnostics)", () => {
    for (const f of ["ttsAudioMsPublished", "ttsAbortedSpeaks", "sttCalls", "doAliveMsCumulative"] as const) {
      const got = voiceTurnCogs({ ...TERMS, [f]: TERMS[f] + 5_000 }, RATES).totalUsd;
      expect(got, f).toBeCloseTo(voiceTurnCogs(TERMS, RATES).totalUsd as number, 12);
    }
  });

  it("unitCostUsd is total-per-BILLABLE-minute, so a longer turn at equal cost is cheaper per unit", () => {
    const short = voiceTurnCogs({ ...TERMS, turnWallMs: 6_000 }, RATES).unitCostUsd as number;
    const long = voiceTurnCogs({ ...TERMS, turnWallMs: 60_000 }, RATES).unitCostUsd as number;
    expect(long).toBeLessThan(short);
  });

  it("a zero-length turn has no unit to divide by — unitCostUsd is absent, not Infinity", () => {
    const got = voiceTurnCogs({ ...TERMS, turnWallMs: 0 }, RATES);
    expect(got.provenance).toBe("measured");
    expect(got.unitCostUsd).toBeUndefined();
    expect(got.idleAmplification).toBeUndefined();
  });
});

describe("voiceTurnCogs — the idle-amplification (Durable Object) term", () => {
  it("reports how many DO seconds the meter does NOT see per billed second", () => {
    // The epic's DO claim is about IDLE time: the meter bills turn wall-time while the platform bills DO
    // wall-time, and the ratio is the exposure. 30s DO against a 6s turn = 5x.
    const got = voiceTurnCogs(TERMS, RATES);
    expect(got.idleAmplification).toBeCloseTo(5, 12);
  });

  it("amplification of exactly 1 means every DO ms was billed — the only non-leaking case", () => {
    const got = voiceTurnCogs({ ...TERMS, doWallMsAttributed: TERMS.turnWallMs }, RATES);
    expect(got.idleAmplification).toBe(1);
  });
});

describe("voiceCogsRatesFromEnv", () => {
  it("returns undefined when nothing is configured — so the model reports 'unpriced', not a guess", () => {
    expect(voiceCogsRatesFromEnv({})).toBeUndefined();
    const cogs = voiceTurnCogs(TERMS, voiceCogsRatesFromEnv({}));
    expect(cogs.provenance).toBe("unpriced");
  });

  it("drops malformed and negative values rather than coercing them — a money input is not NaN-safe", () => {
    for (const bad of ["", "  ", "abc", "-1", "NaN", "Infinity"]) {
      const r = voiceCogsRatesFromEnv({ VOICE_COGS_TTS_USD_PER_CHAR: bad, VOICE_COGS_RATES_SOURCE: "s" });
      expect(r?.ttsUsdPerChar, bad).toBeUndefined();
    }
  });

  it("accepts well-formed rates including 0 (a genuinely free term is a real answer)", () => {
    const r = voiceCogsRatesFromEnv({
      VOICE_COGS_TTS_USD_PER_CHAR: "0",
      VOICE_COGS_STT_USD_PER_AUDIO_MIN: "0.0043",
      VOICE_COGS_DO_USD_PER_WALL_MIN: "0.0000075",
      VOICE_COGS_RATES_SOURCE: "vendor pricing page 2026-08-11",
    });
    expect(voiceTurnCogs(TERMS, r).provenance).toBe("measured");
  });
});

describe("PCM_BYTES_PER_MS", () => {
  it("matches the 48 kHz · 2 ch · 16-bit format this stack moves everywhere", () => {
    // Pinned because every ms-from-bytes conversion in the instrument divides by it; a drift here would
    // silently rescale two of the three measured terms.
    expect(PCM_BYTES_PER_MS).toBe(192);
  });
});
