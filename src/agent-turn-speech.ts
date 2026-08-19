/**
 * Task #81 / E1 finding D1 — the agent's SPEECH lane: TTS → paced publish onto the ingest socket.
 *
 * Split out of agent-turn.ts along a real seam (file-size-two-tier-gate): agent-turn.ts owns turn-taking policy
 * (VAD, the agentic loop, history), THIS file owns "turn text into paced RTP on the wire". The move was forced
 * by D1: `speak()` is now called ONCE PER SENTENCE instead of once per turn, so the media clock and the pacing
 * state it used to keep in LOCALS must live for the whole turn — a per-sentence reset would restart the RTP
 * timestamp at 0 mid-utterance (breaking the #34 barge-in-tail fix) and restart the ttsLeadMs pacing window.
 * `SpeechSession` is exactly that lifetime: ONE session per turn, `speak()` any number of times.
 *
 * Everything else is byte-for-byte the previous `TurnTakingCore.speak` — same chunking, same pacing math, same
 * abort checks at every await, same log event.
 */
import { chunkPcm, encodeIngestFrame, type IngestFraming } from "./agent-ingest-adapter.js";
import type { IngestSocket } from "./agent-session.js";
import type { SentenceChunker } from "./sentence-chunker.js";
import type { CompletionEvent, ToolUse } from "./agent-tools.js";

/** pcm_48000 STEREO interleaved (the synthesize() output): 48 kHz · 2 ch · 2 bytes = 192 bytes per millisecond. */
export const TTS_BYTES_PER_MS = (48_000 * 2 * 2) / 1000;
/** Bytes per RTP 48 kHz timestamp tick: one stereo sample frame = 2 ch · 2 bytes = 4 bytes. The ingest Packet
 *  timestamp is the per-channel 48 kHz sample index, so ticks = byteOffset / 4 (#34 barge-in tail fix). */
export const TTS_BYTES_PER_TS_TICK = 2 * 2;

/** The slice of the turn deps the speech lane needs (kept narrow so tests fake 5 functions, not the world). */
export interface SpeechSessionDeps {
  synthesize(text: string): AsyncIterable<Uint8Array>;
  ingestSocket(): IngestSocket | null;
  now(): number;
  delay?(ms: number): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
}

export interface SpeechSessionOptions {
  /** Step-4 barge-in: TTS send-ahead lead (ms). 0 = legacy bulk send (no pacing). */
  ttsLeadMs: number;
  framing: IngestFraming;
  /** Barge-in probe, read at EVERY await — the core owns the abort flag, we only honor it. */
  isAborted(): boolean;
  /** Core-wide monotonic outbound sequence number (spans turns, so the core owns it). */
  nextSeq(): number;
  /** org/room/agentId for the structured log. */
  idFields(): Record<string, unknown>;
}

/**
 * ONE agent utterance's worth of speaking state: the media clock (`tsTicks`), the pacing window
 * (`playoutStartMs`/`sentMs`), and the cumulative byte/latency counters. Construct one per turn.
 */
export class SpeechSession {
  private playoutStartMs = 0;
  private sentMs = 0;
  private tsTicks = 0;
  private noIngestLogged = false;
  /** Cumulative PCM bytes published this turn (across every sentence). */
  pcmBytesOut = 0;
  /** Wall-clock ms at which the FIRST audio frame of this turn hit the wire — the TTFA receipt. -1 = none yet. */
  firstAudioMs = -1;
  /**
   * E0-P2 — TTS characters SUBMITTED to the vendor this turn, counted at the `synthesize()` call rather than
   * at playout. That is where the money leaves: vendors bill submitted characters, and a barge-in only stops us
   * CONSUMING the response stream — the request was already issued and is already paid for. This counter is the
   * first half of the epic's barge-in wastage term; `ttsCharsHeard` below is the second.
   * Nothing counted this before, which is exactly why the term was invisible.
   */
  ttsCharsSubmitted = 0;
  /** E0-P2 — how many `speak()` calls this turn a barge-in cut short (each one submitted, partly-or-never heard). */
  abortedSpeaks = 0;
  /**
   * E0-P2 — TTS characters the listener actually HEARD. Counted HERE rather than derived from
   * `StreamSpeakAcc.spoken` because that string is built for HISTORY, not for accounting, and mis-measures in
   * both directions: it joins sentences with a space that was never submitted (over-count), and the flushed
   * trailing partial is spoken without ever being appended to it (under-count). Counting at the same place the
   * submission is counted keeps the two halves of the wastage term symmetrical by construction.
   *
   * Uses the codebase's own definition of heard, verbatim from `streamSpeakSentences`: a piece counts as heard
   * if ANY of its audio reached the wire — the listener cannot un-hear a half-sentence.
   */
  ttsCharsHeard = 0;
  /**
   * E0-P2 — characters of pieces a barge-in cut AFTER some audio had already reached the wire.
   *
   * These are the honest grey zone of the wastage term. `ttsCharsHeard` counts such a piece as fully heard (the
   * codebase's rule, and the right one for history), so `submitted - heard` reports ZERO wastage for it — while
   * the vendor was in fact paid for a sentence the listener only partly received. Rather than leave that as a
   * comment about being "conservative", the quantity is counted, so the wastage term can state a definite LOWER
   * BOUND and name the unresolved remainder instead of quietly absorbing it.
   */
  ttsCharsCutMidPiece = 0;

  /** Audio ms actually published this turn — the "heard" side, in the same unit the vendor's audio is billed in. */
  get audioMsPublished(): number {
    return this.pcmBytesOut / TTS_BYTES_PER_MS;
  }

  /**
   * Close out one `speak()` — the ONE exit point, so a new abort site cannot silently skip the accounting.
   * Returns exactly what `speak()` has always returned: bytes published, or -1 when a barge-in cut it short.
   */
  private endSpeak(text: string, publishedThisPiece: number, aborted: boolean): number {
    if (publishedThisPiece > 0) this.ttsCharsHeard += text.length;
    if (!aborted) return publishedThisPiece;
    if (publishedThisPiece > 0) this.ttsCharsCutMidPiece += text.length;
    this.abortedSpeaks++;
    return -1;
  }

  constructor(
    private readonly deps: SpeechSessionDeps,
    private readonly opts: SpeechSessionOptions,
  ) {}

  /**
   * Speak ONE piece of text (a sentence, or the whole reply) via streaming TTS → the ingest socket (the EXACT
   * echoFrame send path). Returns the PCM bytes published FOR THIS PIECE, or -1 if a barge-in aborted mid-stream
   * (the agent goes silent). Honors abort at every await. Safe to call repeatedly — the media clock continues.
   */
  async speak(text: string, onFirstAudio?: () => void): Promise<number> {
    let pcmBytesOut = 0;
    const sock = this.deps.ingestSocket();
    // Observability (#29): the agent has a reply to speak but the SFU never dialed our /ingest endpoint (no live
    // sink) → every frame below is dropped and the agent track stays silent (0 RTP). Surfaced so a live run sees
    // THIS rather than only an absent meter. Logged ONCE per turn (D1: speak() now runs per sentence).
    if (!sock && !this.noIngestLogged) {
      this.noIngestLogged = true;
      this.deps.log("agent-speak-no-ingest", { ...this.opts.idFields(), chars: text.length });
    }
    // Step-4 barge-in keystone — REAL-TIME PACING. We throttle the send to the real playout clock so the SFU
    // buffer never gets more than `ttsLeadMs` ahead. Without this the whole reply is dumped to the buffer and the
    // turn completes (turnInFlight=false) BEFORE the listener even hears it → a barge during playout is a no-op
    // (proven: 0 agent-turn-interrupt; the meter preceded the first agent RTP). With a shallow buffer, turnInFlight
    // spans the playout (bargeIn fires mid-reply) and on abort only ≤lead drains → the agent falls silent fast.
    // We sleep ONLY when AHEAD of the clock (never when behind → no underrun risk). lead=0 → legacy bulk send.
    const delay = this.deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // E0-P2: count the submit BEFORE the call. The vendor bills this text whether or not a barge-in lands
    // one chunk later, so counting at completion would under-report exactly the turns that waste the most.
    this.ttsCharsSubmitted += text.length;
    try {
      let firstAudio = false;
      for await (const pcm of this.deps.synthesize(text)) {
        if (this.opts.isAborted()) return this.endSpeak(text, pcmBytesOut, true); // barge-in: stop publishing the now-stale reply mid-stream
        if (!sock || pcm.length === 0) continue;
        if (!firstAudio) { firstAudio = true; onFirstAudio?.(); } // E1 harness: TTS-first-audio-byte
        for (const chunk of chunkPcm(pcm)) {
          if (this.opts.isAborted()) return this.endSpeak(text, pcmBytesOut, true); // barge-in between chunks → go silent immediately (don't send more)
          // playoutStartMs anchors the pacing window to the FIRST frame of the TURN, not of this sentence — with a
          // per-sentence anchor every sentence would be allowed a fresh `ttsLeadMs` of run-ahead and the buffer
          // would deepen sentence by sentence, re-introducing the ~700 ms post-abort tail #34 removed.
          if (this.playoutStartMs === 0) this.playoutStartMs = this.deps.now();
          if (this.opts.ttsLeadMs > 0) {
            let aheadMs = this.sentMs - (this.deps.now() - this.playoutStartMs);
            // UNDERRUN RE-ANCHOR (D1): between sentences the loop stalls on the LLM while wall time keeps running,
            // so `aheadMs` goes negative by the stall length. Left alone, the gate would stay open until `sentMs`
            // climbed back past elapsed+lead — publishing a `stallMs + ttsLeadMs` BURST whose depth is exactly the
            // post-abort tail #34 removed (a barge-in during the burst keeps talking for its whole length). A
            // negative `aheadMs` means the remote playout underran (drained to empty), so treat it as a playout
            // RESTART: re-anchor the window to `now - sentMs` and measure the lead from the RESUMED playout.
            if (aheadMs < 0) {
              this.playoutStartMs = this.deps.now() - this.sentMs;
              aheadMs = 0;
            }
            if (aheadMs > this.opts.ttsLeadMs) {
              await delay(aheadMs - this.opts.ttsLeadMs); // let the buffer drain back down to the lead
              if (this.opts.isAborted()) return this.endSpeak(text, pcmBytesOut, true); // barge-in DURING the pacing wait → stop before the next chunk
            }
          }
          const seq = this.opts.nextSeq();
          // #34 barge-in tail: monotonic 48 kHz RTP timestamp (per-channel sample index). The ingest protocol is a
          // proto3 Packet{seq,ts,payload} — it has NO flush/control field, so the SFU playout buffer cannot be
          // flushed out-of-band on abort. The keystone is to make the SFU pace by the MEDIA CLOCK: with a real,
          // monotonic timestamp the SFU buffer-mode pull emits in lockstep with the timeline and never runs ahead,
          // so when bargeIn() stops the send the SFU has ~one frame buffered (not an undefined backlog). ts is the
          // START-of-chunk sample index and CONTINUES ACROSS SENTENCES (D1) — one utterance, one timeline.
          const wire = encodeIngestFrame(chunk, { sequenceNumber: seq, timestamp: this.tsTicks }, this.opts.framing);
          sock.send(wire);
          if (this.firstAudioMs < 0) this.firstAudioMs = this.deps.now(); // TTFA receipt: first frame ON THE WIRE
          pcmBytesOut += chunk.length;
          this.pcmBytesOut += chunk.length;
          this.sentMs += chunk.length / TTS_BYTES_PER_MS;
          this.tsTicks += Math.floor(chunk.length / TTS_BYTES_PER_TS_TICK); // advance the clock by this chunk's samples
        }
      }
    } catch (e) {
      // The THROW exit. A synthesize()/send() failure mid-piece must route through the SAME accounting as the
      // other two exits: audio already on the wire was HEARD — the exact rule `streamSpeakSentences` applies to
      // history on this same error path — so skipping `endSpeak` here would report a partly-delivered piece as
      // definite wastage and put the ledger in disagreement with the history it sits beside. NOT a barge-in:
      // `abortedSpeaks` and the mid-cut grey zone stay barge-in-only (aborted=false), and the rethrow itself is
      // the record of this piece's failure — the caller attributes it (`errorStage: "tts"`) and abandons the turn.
      this.endSpeak(text, pcmBytesOut, false);
      throw e;
    }
    return this.endSpeak(text, pcmBytesOut, false);
  }
}

/**
 * What a sentence-streamed turn produced. MUTATED IN PLACE by `streamSpeakSentences` so the caller can read the
 * partial state even when the stream THROWS mid-turn (the #344 fail-closed LLM_UPSTREAM, or a TTS error) — the
 * honest failure path needs to know exactly how much the listener actually heard.
 */
export interface StreamSpeakAcc {
  /** Every text delta seen, concatenated (what the model said — spoken or not). */
  assistant: string;
  /** The sentences actually HANDED TO TTS, in order, joined — i.e. what the listener heard (or is hearing). */
  spoken: string;
  /** tool_use blocks seen. Non-empty here is defensive only: the core enables this path with NO tools advertised. */
  toolUses: ToolUse[];
  /** True when a barge-in cut the turn (either the stream loop or a speak() call saw the abort flag). */
  aborted: boolean;
  /**
   * Which lane a thrown error came from: "tts" when speak()/synthesize/send threw, "llm" (the default) when the
   * event stream itself threw. Set BEFORE the rethrow so the caller can log the honest stage/reason — a TTS or
   * ingest failure reported as an LLM upstream error would send production debugging to the wrong service.
   */
  errorStage?: "llm" | "tts";
}

/**
 * D1 — consume the LLM stream and SPEAK EACH SENTENCE AS IT COMPLETES, instead of waiting for the stream to end.
 * This is the whole latency fix: time-to-first-audio stops being `STT + the ENTIRE LLM stream + TTS` and becomes
 * `STT + the FIRST SENTENCE + TTS`, with the rest of the LLM stream overlapping playout.
 *
 * Does NOT flush the chunker's trailing partial sentence: the caller speaks that AFTER it has atomically
 * committed the full assistant turn to history, preserving the existing commit-then-speak ordering at stream end.
 * Honors barge-in between every delta and inside every speak(). Throws through (after `acc` is up to date).
 */
export async function streamSpeakSentences(
  events: AsyncIterable<CompletionEvent>,
  session: SpeechSession,
  chunker: SentenceChunker,
  acc: StreamSpeakAcc,
  isAborted: () => boolean,
  onFirstToken?: () => void,
  onFirstAudio?: () => void,
): Promise<void> {
  let sawText = false;
  for await (const evt of events) {
    if (isAborted()) {
      acc.aborted = true;
      return; // step-4 barge-in: cancel the in-flight stream
    }
    if (evt.type !== "text") {
      acc.toolUses.push({ id: evt.id, name: evt.name, input: evt.input });
      continue; // defensive: a tool_use here means the caller mis-gated; stop speaking, let it handle them
    }
    if (!sawText) { sawText = true; onFirstToken?.(); } // E1 harness: LLM-first-token
    acc.assistant += evt.text;
    if (acc.toolUses.length > 0) continue; // never speak text that belongs to a tool-calling turn
    for (const sentence of chunker.push(evt.text)) {
      const bytesBefore = session.pcmBytesOut;
      let n: number;
      try {
        n = await session.speak(sentence, onFirstAudio);
      } catch (e) {
        acc.errorStage = "tts"; // the SPEECH lane died (synthesize/send), not the LLM stream — attribute honestly
        // Same rule as barge-in: audio that reached the wire before the throw was HEARD → acc stays honest.
        if (session.pcmBytesOut > bytesBefore) {
          acc.spoken = acc.spoken.length > 0 ? `${acc.spoken} ${sentence}` : sentence;
        }
        throw e;
      }
      // A barge-in mid-sentence still counts the sentence as HEARD if any of its audio reached the wire — the
      // listener cannot un-hear a half-sentence, so history must contain it. Aborted with zero bytes published
      // (the common case: the abort landed between sentences) is NOT heard and is correctly left out.
      if (n > 0 || session.pcmBytesOut > bytesBefore) {
        acc.spoken = acc.spoken.length > 0 ? `${acc.spoken} ${sentence}` : sentence;
      }
      if (n < 0) {
        acc.aborted = true;
        return; // barge-in: the agent goes silent; `acc.spoken` is exactly what was heard
      }
    }
  }
}
