/**
 * Task #81 / E1 finding D1 — SENTENCE-BOUNDARY CHUNKER for the voice-agent turn loop.
 *
 * WHY: `runTurn` used to accumulate the ENTIRE LLM stream into one string before calling `speak()`, so
 * time-to-first-audio was exactly `STT + the WHOLE LLM stream + first TTS chunk`. The E1 live-run arithmetic
 * showed first-token at ~800 ms bought nothing — the listener waited for the LAST token. Speaking each sentence
 * as it completes moves TTS onto the LLM's critical path in parallel instead of after it.
 *
 * This module is PURE (no I/O, no timers, no deps) so the boundary policy is exhaustively unit-testable and the
 * turn loop keeps its own concerns. Feed it stream deltas; it hands back only COMPLETE sentences.
 *
 * Boundary policy (deliberately conservative — a wrong split is heard as a stutter, a missed split only costs
 * the latency we already have today):
 *   • A sentence ends at . ! ? … or a newline, and ONLY when a following character has arrived and is
 *     whitespace/quote/bracket. Requiring the lookahead is what makes "3.14" and "wave.online" safe — we never
 *     guess mid-token, we wait for the next delta (which is milliseconds away).
 *   • Common abbreviations (Mr., Dr., e.g., i.e., etc., U.S.) do NOT end a sentence.
 *   • A run of . ! ? (…, ?!, ...) is ONE boundary, and trailing closers (" ' ) ] } ”) belong to the sentence.
 *   • Sentences shorter than `minChars` are HELD and merged into the next one — "Hi." alone is choppy TTS.
 *   • `maxChars` force-flushes at the last space, so an unpunctuated monologue can never stall the audio.
 */

/** Tunables for the boundary policy. Defaults are the voice-turn values; overridable for tests/env. */
export interface SentenceChunkerOptions {
  /** Hold + merge any candidate sentence shorter than this (avoids choppy one-word TTS calls). */
  minChars?: number;
  /** Force a flush at the last word boundary once the buffer exceeds this (unpunctuated-monologue guard). */
  maxChars?: number;
}

export const DEFAULT_MIN_SENTENCE_CHARS = 12;
export const DEFAULT_MAX_SENTENCE_CHARS = 240;

/** Terminators that can END a sentence. */
const TERMINATORS = new Set([".", "!", "?", "…"]); // . ! ? …
/** Closers that stay ATTACHED to the sentence they follow (quotes/brackets). */
const CLOSERS = new Set(['"', "'", ")", "]", "}", "”", "’"]); // " ' ) ] } ” ’
/**
 * Abbreviations whose trailing "." is NOT a sentence end. Lower-cased, compared against the last whitespace-
 * delimited token. Single capital letters (initials: "J." in "J. Fineman") are handled separately.
 */
const ABBREVIATIONS = new Set([
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.",
  "e.g.", "i.e.", "etc.", "vs.", "approx.", "inc.", "ltd.", "co.",
  "fig.", "no.", "vol.", "u.s.", "u.k.", "a.m.", "p.m.",
]);

/**
 * Streaming sentence splitter. `push` each LLM text delta; it returns the sentences that became COMPLETE with
 * that delta (usually zero, sometimes one). `flush` returns whatever is left when the stream ends.
 *
 * Stateful across deltas by design: a sentence boundary routinely straddles two deltas ("...done" + ". Next"),
 * so the buffer — and the pending-short-sentence hold — must survive between calls.
 */
export class SentenceChunker {
  private buf = "";
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(opts: SentenceChunkerOptions = {}) {
    this.minChars = opts.minChars ?? DEFAULT_MIN_SENTENCE_CHARS;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_SENTENCE_CHARS;
  }

  /** True when nothing is buffered (the stream ended exactly on a boundary). */
  get isEmpty(): boolean {
    return this.buf.trim().length === 0;
  }

  /** Feed one LLM text delta; returns every sentence that is now COMPLETE (in order, ready to speak). */
  push(delta: string): string[] {
    if (delta.length === 0) return [];
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      const text = piece.trim();
      // A too-short piece is NOT emitted: leaving it in front of the next sentence merges them ("Hi." + "How
      // are you?" → "Hi. How are you?"), which TTS speaks far better than two clipped calls.
      if (text.length > 0) out.push(text);
    }
    return out;
  }

  /** End of stream: return the trailing partial sentence (trimmed), or "" if the buffer holds nothing sayable. */
  flush(): string {
    const rest = this.buf.trim();
    this.buf = "";
    return rest;
  }

  /**
   * Index just past the end of the first COMPLETE sentence in the buffer, or -1 if none is complete yet.
   * "Complete" requires a terminator, its trailing closers, AND at least one following character (the lookahead
   * that makes "3.14"/"wave.online" safe) — except for the maxChars force-flush, which needs no terminator.
   */
  private findCut(): number {
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i]!;
      if (ch === "\n") {
        // A hard line break IS a boundary (lists, paragraphs) — no lookahead needed, the break already arrived.
        if (this.buf.slice(0, i).trim().length >= this.minChars) return i + 1;
        continue;
      }
      if (!TERMINATORS.has(ch)) continue;
      // Absorb a terminator RUN ("...", "?!") then any closers — they belong to this sentence, not the next.
      let end = i;
      while (end + 1 < this.buf.length && TERMINATORS.has(this.buf[end + 1]!)) end++;
      while (end + 1 < this.buf.length && CLOSERS.has(this.buf[end + 1]!)) end++;
      const next = this.buf[end + 1];
      if (next === undefined) return -1; // no lookahead yet → wait for the next delta (never guess mid-token)
      if (!/\s/.test(next)) {
        // Not followed by whitespace → this is INSIDE a token: "3.14", "wave.online", "v1.2". Not a boundary.
        i = end;
        continue;
      }
      if (ch === "." && this.endsWithAbbreviation(this.buf.slice(0, end + 1))) {
        i = end;
        continue;
      }
      if (this.buf.slice(0, end + 1).trim().length < this.minChars) {
        i = end;
        continue; // too short to speak alone → hold it and merge with the next sentence
      }
      return end + 1;
    }
    // Unpunctuated-monologue guard: past maxChars, flush at the LAST space so we never cut a word in half.
    if (this.buf.length > this.maxChars) {
      const sp = this.buf.lastIndexOf(" ", this.maxChars);
      if (sp > 0) return sp + 1;
    }
    return -1;
  }

  /** True when `text` ends with a known abbreviation or a single-letter initial (both keep the sentence open). */
  private endsWithAbbreviation(text: string): boolean {
    const token = text.slice(text.lastIndexOf(" ") + 1).toLowerCase();
    if (ABBREVIATIONS.has(token)) return true;
    return /^[a-z]\.$/.test(token); // an initial: "J." in "J. Fineman"
  }
}
