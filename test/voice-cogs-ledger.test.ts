// E0-P2 — the INSTRUMENT half: do the three cost terms actually get captured on the real code paths?
//
// `voice-cogs.test.ts` proves the arithmetic. This file proves the WIRING, which is where the epic's original
// defect lived: the dead meter was not a broken formula, it was a quantity nobody counted. So these tests drive
// the genuine `SpeechSession` and `TurnCogsLedger` — no re-implementation of the counters in the test — and
// assert the properties that make the numbers mean anything. Every dep is a fake; zero network.
import { describe, expect, it } from "vitest";
import { SpeechSession, TTS_BYTES_PER_MS } from "../src/agent-turn-speech.js";
import { TurnCogsLedger } from "../src/voice-cogs-ledger.js";
import { PCM_BYTES_PER_MS, voiceTurnCogs } from "../src/voice-cogs.js";
import type { IngestSocket } from "../src/agent-session.js";

const CHUNK = () => new Uint8Array(TTS_BYTES_PER_MS * 10); // 10 ms of audio

function speechFixture(opts: { abortAfterChunks?: number } = {}) {
  const sent: unknown[] = [];
  const sock: IngestSocket = { send: (d: unknown) => sent.push(d), close: () => {} } as unknown as IngestSocket;
  let chunks = 0;
  let t = 0;
  const session = new SpeechSession(
    {
      synthesize: async function* () {
        for (let i = 0; i < 4; i++) yield CHUNK();
      },
      ingestSocket: () => sock,
      now: () => t,
      delay: async (ms) => {
        t += ms;
      },
      log: () => {},
    },
    {
      ttsLeadMs: 0,
      framing: "raw",
      // Abort once the configured number of chunks has reached the wire — a real mid-utterance barge-in.
      isAborted: () => opts.abortAfterChunks !== undefined && chunks >= opts.abortAfterChunks,
      nextSeq: () => {
        chunks++;
        return chunks;
      },
      idFields: () => ({}),
    },
  );
  return { session, sent };
}

describe("SpeechSession — the submitted-vs-heard seam", () => {
  it("counts submitted characters even when a barge-in publishes NOTHING", async () => {
    // THE defect this term exists for. The vendor is billed at the synthesize() call; an abort one chunk later
    // does not refund it. If submission were counted at completion, the turns that waste the most would report
    // the least — the failure would be invisible in exactly the case it matters.
    const { session, sent } = speechFixture({ abortAfterChunks: 0 });
    const n = await session.speak("An entire sentence the listener never hears.");
    expect(n).toBe(-1); // aborted
    expect(sent.length).toBe(0); // nothing heard
    expect(session.ttsCharsSubmitted).toBe("An entire sentence the listener never hears.".length);
    expect(session.abortedSpeaks).toBe(1);
  });

  it("a completed utterance submits and hears the same text — wastage is zero only here", async () => {
    const { session } = speechFixture();
    const text = "Fully spoken.";
    await session.speak(text);
    const terms = new TurnCogsLedger(() => 1_000).closeTurn({
      turnWallMs: 1_000,
      speech: session,
      ttsCharsHeard: text.length,
    });
    expect(voiceTurnCogs(terms).bargeInWastageChars).toBe(0);
  });

  it("a barge-in makes submitted EXCEED heard — the wastage term becomes visible", async () => {
    // The end-to-end property: real SpeechSession + real ledger + real cost model, and the gap appears without
    // anything in the test computing it. Before P2 there was no counter that could show this at all.
    const { session } = speechFixture({ abortAfterChunks: 1 });
    await session.speak("A long sentence that gets cut off part way through by the user.");
    const terms = new TurnCogsLedger(() => 1_000).closeTurn({
      turnWallMs: 1_000,
      speech: session,
      ttsCharsHeard: 0, // the abort landed before the sentence counted as heard
    });
    const cogs = voiceTurnCogs(terms);
    expect(terms.ttsCharsSubmitted).toBeGreaterThan(terms.ttsCharsHeard);
    expect(cogs.bargeInWastageChars).toBe(terms.ttsCharsSubmitted);
    expect(cogs.bargeInWastageFraction).toBe(1);
    // Audio DID reach the wire before the abort, so "heard nothing" and "published nothing" are different facts
    // and the instrument keeps both rather than collapsing them.
    expect(terms.ttsAudioMsPublished).toBeGreaterThan(0);
  });

  it("accumulates submitted chars across sentences — D1 calls speak() once per sentence", async () => {
    const { session } = speechFixture();
    await session.speak("One.");
    await session.speak("Two.");
    expect(session.ttsCharsSubmitted).toBe("One.".length + "Two.".length);
  });
});

describe("TurnCogsLedger — the Durable Object term", () => {
  /** A clock the test advances by hand, so DO wall-time is exact rather than wall-clock-flaky. */
  const clockAt = (ref: { t: number }) => () => ref.t;

  it("per-turn DO slices SUM to the session's duration — never double-charged, never dropped", async () => {
    // The property that makes per-turn attribution legitimate. Charging each turn the DO's CUMULATIVE age would
    // bill the same milliseconds once per turn; charging nothing would lose idle time entirely. Neither is
    // detectable from a single turn, which is why this is asserted across a sequence.
    const ref = { t: 0 };
    const ledger = new TurnCogsLedger(clockAt(ref));
    const slices: number[] = [];
    for (const gap of [5_000, 30_000, 1_000]) {
      ref.t += gap;
      slices.push(ledger.closeTurn({ turnWallMs: 100, ttsCharsHeard: 0 }).doWallMsAttributed);
    }
    expect(slices).toEqual([5_000, 30_000, 1_000]);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(ref.t); // == the session's whole life, exactly once
  });

  it("carries the IDLE gap between turns — the cost the per-turn meter cannot see", async () => {
    const ref = { t: 0 };
    const ledger = new TurnCogsLedger(clockAt(ref));
    ref.t = 60_000; // a minute of DO life, of which only 4s was a turn
    const cogs = voiceTurnCogs(ledger.closeTurn({ turnWallMs: 4_000, ttsCharsHeard: 0 }));
    expect(cogs.idleAmplification).toBe(15); // 15 DO seconds billed per second metered
  });

  it("closing twice cannot re-charge the same milliseconds", async () => {
    const ref = { t: 0 };
    const ledger = new TurnCogsLedger(clockAt(ref));
    ref.t = 10_000;
    expect(ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 }).doWallMsAttributed).toBe(10_000);
    expect(ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 }).doWallMsAttributed).toBe(0);
  });

  it("cumulative age is reported alongside the slice, and only ever grows", async () => {
    const ref = { t: 0 };
    const ledger = new TurnCogsLedger(clockAt(ref));
    const seen: number[] = [];
    for (const gap of [1_000, 1_000, 1_000]) {
      ref.t += gap;
      seen.push(ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 }).doAliveMsCumulative);
    }
    expect(seen).toEqual([1_000, 2_000, 3_000]);
  });
});

describe("TurnCogsLedger — the STT term", () => {
  it("counts SUBMITTED audio ms, converted from the exact buffer POSTed", () => {
    const ledger = new TurnCogsLedger(() => 0);
    ledger.recordStt(PCM_BYTES_PER_MS * 2_500); // 2.5 s of audio
    const terms = ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 });
    expect(terms.sttAudioMsSubmitted).toBe(2_500);
    expect(terms.sttCalls).toBe(1);
  });

  it("resets per TURN — the next utterance is a new submission, not a running total", () => {
    // A session-cumulative STT counter would inflate every turn after the first, and the inflation would grow
    // with conversation length, which is the shape most likely to be mistaken for a real cost trend.
    const ledger = new TurnCogsLedger(() => 0);
    ledger.recordStt(PCM_BYTES_PER_MS * 1_000);
    ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 });
    ledger.recordStt(PCM_BYTES_PER_MS * 500);
    expect(ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 }).sttAudioMsSubmitted).toBe(500);
  });

  it("ignores a non-positive buffer rather than recording a phantom call", () => {
    const ledger = new TurnCogsLedger(() => 0);
    ledger.recordStt(0);
    ledger.recordStt(-1);
    const terms = ledger.closeTurn({ turnWallMs: 1, ttsCharsHeard: 0 });
    expect(terms.sttCalls).toBe(0);
    expect(terms.sttAudioMsSubmitted).toBe(0);
  });

  it("a turn that never spoke still yields MEASURED terms (genuine zeros, not absent ones)", () => {
    // `voiceTurnCogs` calls a missing term `invalid`. A silent turn must therefore emit real zeros, or every
    // silent turn would look like an instrument failure — and instrument failures that are indistinguishable
    // from real data are how the original dead meter survived seven weeks.
    const ledger = new TurnCogsLedger(() => 0);
    const cogs = voiceTurnCogs(ledger.closeTurn({ turnWallMs: 500, ttsCharsHeard: 0 }));
    expect(cogs.provenance).toBe("unpriced"); // quantities fine; only the RATES are missing
    expect(cogs.provenance).not.toBe("invalid");
  });
});
