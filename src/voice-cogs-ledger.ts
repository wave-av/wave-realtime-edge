/**
 * E0-P2 — the per-SESSION half of the voice COGS instrument.
 *
 * `voice-cogs.ts` is the pure arithmetic; this is the small amount of STATE that arithmetic needs and that a
 * single turn cannot hold: the Durable Object's wall-clock, and the STT audio submitted for the utterance that
 * triggered the turn. It lives here rather than in `agent-turn.ts` because that file is already past the
 * token tier of the two-tier file-size gate — the rule there is DECOMPOSE, never trim.
 *
 * The DO term is the reason this class exists at all. A turn can measure its own TTS and its own STT, but
 * "how long has this Durable Object been alive, and how much of that is idle?" is a question only something
 * outliving the turn can answer — and idle time is precisely the cost the per-turn meter is blind to.
 */
import { PCM_BYTES_PER_MS, type VoiceTurnCogsTerms } from "./voice-cogs.js";
import type { SpeechSession } from "./agent-turn-speech.js";

/** What a finished turn contributes, beyond what the ledger itself tracks. */
export interface TurnCogsClose {
  /** Turn wall-time (ms) — the billable quantity. */
  turnWallMs: number;
  /** The turn's speech session (TTS submitted/published counters). Absent when the turn never spoke. */
  speech?: Pick<SpeechSession, "ttsCharsSubmitted" | "ttsCharsHeard" | "ttsCharsCutMidPiece" | "abortedSpeaks" | "pcmBytesOut" | "audioMsPublished">;
}

/**
 * One voice session's cost ledger. Constructed with the core, closed once per turn.
 *
 * Clock: injected, never `Date.now()` directly, so the whole instrument is testable without faking globals and
 * so it uses the same clock the turn's own wall-time comes from (two clocks would make `idleAmplification`
 * meaningless).
 */
export class TurnCogsLedger {
  /** When the DO began holding this session. A LOWER BOUND on DO lifetime — the DO may predate the core. */
  private readonly bornMs: number;
  /** The mark the next turn's DO slice is measured from. Advancing it per turn makes the slices SUM, not overlap. */
  private lastAccountedMs: number;
  private sttAudioMs = 0;
  private sttCalls = 0;
  /** Set by `closeSession` — the terminal slice is emitted at most once, however many teardown paths fire. */
  private sessionClosed = false;

  constructor(private readonly now: () => number) {
    this.bornMs = now();
    this.lastAccountedMs = this.bornMs;
  }

  /**
   * Record one STT submission. `pcmBytes` is the buffer actually POSTed, so this counts what the vendor bills:
   * the utterance PLUS whatever VAD hangover padding rode along with it.
   *
   * NOTE, and it is a correction to this epic's own premise — see the E0 phase doc. The epic's second cost term
   * is "silence-window STREAMING STT", billed across silence by an always-open stream. WAVE has no streaming STT:
   * `transcribeViaProvider` is short-buffer BATCH per utterance. So the term is real but its SHAPE is different —
   * we are billed for submitted audio, not for wall-clock silence — and this is the quantity that settles it.
   */
  recordStt(pcmBytes: number): void {
    if (!(pcmBytes > 0)) return;
    this.sttAudioMs += pcmBytes / PCM_BYTES_PER_MS;
    this.sttCalls += 1;
  }

  /**
   * Close a turn: emit its measured terms and advance the DO mark. Called once per metered turn.
   *
   * A turn that never reached TTS still gets a row — with zeroed TTS counters that are genuinely zero (nothing
   * was submitted), not zero-because-unmeasured. The difference matters: `voiceTurnCogs` treats a MISSING term
   * as `invalid`, so anything it reports as a number here is a real observation.
   */
  closeTurn(c: TurnCogsClose): VoiceTurnCogsTerms {
    const at = this.now();
    const terms: VoiceTurnCogsTerms = {
      turnWallMs: Math.max(0, c.turnWallMs),
      ttsCharsSubmitted: c.speech?.ttsCharsSubmitted ?? 0,
      ttsCharsHeard: c.speech?.ttsCharsHeard ?? 0,
      ttsAudioMsPublished: c.speech?.audioMsPublished ?? 0,
      ttsCharsCutMidPiece: c.speech?.ttsCharsCutMidPiece ?? 0,
      ttsAbortedSpeaks: c.speech?.abortedSpeaks ?? 0,
      sttAudioMsSubmitted: this.sttAudioMs,
      sttCalls: this.sttCalls,
      doWallMsAttributed: Math.max(0, at - this.lastAccountedMs),
      doAliveMsCumulative: Math.max(0, at - this.bornMs),
    };
    // Advance BEFORE returning so a caller that closes twice cannot double-charge the same DO milliseconds.
    this.lastAccountedMs = at;
    // STT counters are per-TURN, not per-session: the next turn's utterance is a new submission.
    this.sttAudioMs = 0;
    this.sttCalls = 0;
    return terms;
  }

  /**
   * Close the SESSION: the terminal slice between the last closed turn and teardown. Sessions usually end idle,
   * so without this the final idle window — often the largest single DO interval — would silently vanish and the
   * "per-turn slices sum to session duration" invariant would hold only until the last turn, not until room-end.
   * Any STT recorded after the last turn (an utterance that never became a turn) rides on this slice too.
   *
   * Idempotent, and reported with the SAME field names as `closeTurn`, so a downstream reader sums
   * `doWallMsAttributed` across per-turn rows plus this terminal row and lands exactly on `doAliveMsCumulative`.
   * Returns null on any call after the first — a double teardown must not re-charge the tail.
   */
  closeSession(): Pick<VoiceTurnCogsTerms, "doWallMsAttributed" | "doAliveMsCumulative" | "sttAudioMsSubmitted" | "sttCalls"> | null {
    if (this.sessionClosed) return null;
    this.sessionClosed = true;
    const at = this.now();
    const terminal = {
      doWallMsAttributed: Math.max(0, at - this.lastAccountedMs),
      doAliveMsCumulative: Math.max(0, at - this.bornMs),
      sttAudioMsSubmitted: this.sttAudioMs,
      sttCalls: this.sttCalls,
    };
    this.lastAccountedMs = at;
    this.sttAudioMs = 0;
    this.sttCalls = 0;
    return terminal;
  }
}
