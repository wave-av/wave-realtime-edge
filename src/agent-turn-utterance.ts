// agent-turn-utterance — the bounded utterance buffer (the accumulated-since-last-final PCM),
// extracted from agent-turn.ts (token-budget decompose, 2026-08-30; DECOMPOSE by responsibility,
// never trim). The seam: the buffer + its BOUNDED-eviction law (drop-oldest, always keep >=1) is
// a self-contained responsibility with its own invariant; the session state machine composes it.
// MAX_UTTERANCE_BYTES lives in turn-config.js. Moved verbatim, comments included.
import { MAX_UTTERANCE_BYTES } from "./turn-config.js";

export class UtteranceBuffer {
  /** PCM accumulated since the last FINAL transcript (the current user utterance). Bounded by MAX_UTTERANCE_BYTES. */
  private chunks: Uint8Array[] = [];
  /** Running byte total (avoids re-summing on every frame; drives bounded eviction). */
  private bytes = 0;

  /**
   * Append one PCM frame to the accumulated utterance, BOUNDED. Without this cap the buffer grows for the whole
   * session whenever audio never endpoints (continuous talker / partial-only STT / long in-flight turn) until the
   * DO isolate hits its 128 MB limit and resets mid-turn — the agent never gets to speak. Over MAX_UTTERANCE_BYTES
   * we drop OLDEST frames (always keep ≥1) so STT + barge-in still see the most recent ~15 s of context.
   */
  push(payload: Uint8Array): void {
    this.chunks.push(payload);
    this.bytes += payload.length;
    while (this.bytes > MAX_UTTERANCE_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.length;
    }
  }

  /** Clear the accumulated utterance + its byte counter (after a FINAL transcript consumes it). */
  reset(): void {
    this.chunks = [];
    this.bytes = 0;
  }

  /** Concatenate the accumulated chunks (the drain path). */
  drain(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0];
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  get length(): number {
    return this.chunks.length;
  }
}
