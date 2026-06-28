/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b), build-order step 4 — VAD (voice-activity detection), the FIRST half of the
 * interrupt controller (true best-in-class barge-in, design §L2.1).
 *
 * This is the PURE, dependency-free, unit-testable speech detector. Feed it the 16-bit LE PCM payload of one
 * decoded egress frame (the SAME `pkt.payload` shape `decodePacket` produces); it computes per-frame RMS energy
 * and runs a debounced onset / hangover state machine, emitting `speech-start` / `speech-end` transitions. NO ML
 * model, NO new dependency — energy/RMS is the correct, latency-cheap v1 (fires in tens of ms, design §L2.1).
 *
 * ── THE STATE MACHINE ───────────────────────────────────────────────────────────────────────────────────────
 *   silence ──(RMS ≥ threshold for `onsetFrames` consecutive frames)──▶ SPEECH   (emit "speech-start")
 *   speech  ──(RMS <  threshold for `hangoverFrames` consecutive frames)──▶ silence (emit "speech-end")
 *
 * The onset debounce avoids a single noisy frame triggering a false barge-in; the hangover (silence after
 * speech) avoids cutting the user off mid-word on a brief pause (design §L2.2 endpointing care). Counts (not
 * wall-time) keep it pure + deterministic in tests; one egress audio frame is a fixed ~real duration so a frame
 * count maps to a real time window at deploy (documented; the live spike pins the exact ms per frame).
 *
 * ── BARGE-IN USE ────────────────────────────────────────────────────────────────────────────────────────────
 *  The interrupt controller (in agent-turn.ts) runs this on EVERY incoming frame. While the agent is speaking
 *  (turnInFlight), a `speech-start` event = the user barged in → abort the in-flight LLM/TTS via onUserSpeech().
 */

/** One VAD transition for a fed frame. `none` = no state change (steady speech or steady silence). */
export type VadEvent = "none" | "speech-start" | "speech-end";

/** Tunable VAD config. Defaults are sensible for 16-bit LE PCM 48 kHz; all env-overridable (see vadConfigFromEnv). */
export interface VadConfig {
  /**
   * RMS amplitude threshold (0..32767, the 16-bit sample magnitude scale). A frame whose RMS ≥ this is "loud"
   * (candidate speech). Default tuned so near-silence (dither / line noise) stays below it but normal speech is
   * comfortably above. The live spike refines against real room noise floors.
   */
  rmsThreshold: number;
  /** Consecutive loud frames required to DECLARE speech onset (debounce against a single noise spike). */
  onsetFrames: number;
  /** Consecutive quiet frames required to DECLARE speech end (silence hangover — don't cut the user off). */
  hangoverFrames: number;
}

/** Sensible defaults for 16-bit LE PCM @ 48 kHz. onset 2 frames = fast barge-in; hangover 12 = a real pause. */
export const DEFAULT_VAD_CONFIG: VadConfig = {
  rmsThreshold: 500,
  onsetFrames: 2,
  hangoverFrames: 12,
};

/**
 * Compute RMS (root-mean-square) amplitude over a 16-bit LE PCM buffer. PURE. Interprets `pcm` as little-endian
 * signed 16-bit samples; an odd trailing byte is ignored. Returns 0 for an empty/odd-only buffer. The result is
 * on the same 0..32767 scale as the samples, so it compares directly against `rmsThreshold`.
 */
export function rms16LE(pcm: Uint8Array): number {
  const sampleCount = pcm.length >> 1; // 2 bytes per sample; ignore a dangling odd byte
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const lo = pcm[i * 2];
    const hi = pcm[i * 2 + 1];
    // little-endian signed 16-bit: combine then sign-extend the high byte
    let sample = (hi << 8) | lo;
    if (sample >= 0x8000) sample -= 0x10000;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Vad — a pure, frame-fed voice-activity detector. Stateful (tracks the onset/hangover run lengths + whether it
 * currently believes the user is speaking) but does ZERO I/O. `feed(pcm)` returns the transition for THIS frame.
 * Deterministic → fully unit-testable with synthetic loud / quiet PCM. No throw on bad input (empty = quiet).
 */
export class Vad {
  private readonly config: VadConfig;
  /** Are we currently in the SPEECH state (sustained speech declared, not yet ended)? */
  private speaking = false;
  /** Consecutive loud frames seen while NOT yet speaking (counts toward onset). */
  private loudRun = 0;
  /** Consecutive quiet frames seen while speaking (counts toward hangover). */
  private quietRun = 0;
  /** RMS of the most recent fed frame (exposed for latency/diagnostic logging — never a claim). */
  private lastRms = 0;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = {
      rmsThreshold: clampPositive(config.rmsThreshold, DEFAULT_VAD_CONFIG.rmsThreshold),
      onsetFrames: clampMin1(config.onsetFrames, DEFAULT_VAD_CONFIG.onsetFrames),
      hangoverFrames: clampMin1(config.hangoverFrames, DEFAULT_VAD_CONFIG.hangoverFrames),
    };
  }

  /** True while the detector believes the user is speaking (between a speech-start and its speech-end). */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** RMS of the most recent fed frame (for diagnostic logging only — no perf/latency claim is made from it). */
  get lastFrameRms(): number {
    return this.lastRms;
  }

  /** The effective (defaults-merged, validated) config — for diagnostic logging + tests. */
  get effectiveConfig(): Readonly<VadConfig> {
    return this.config;
  }

  /**
   * Feed ONE frame's PCM. Returns the VAD transition: "speech-start" the frame onset is DECLARED, "speech-end"
   * the frame hangover completes, else "none". Pure w.r.t. I/O; only mutates this detector's run counters.
   */
  feed(pcm: Uint8Array): VadEvent {
    const energy = rms16LE(pcm);
    this.lastRms = energy;
    const loud = energy >= this.config.rmsThreshold;
    if (!this.speaking) {
      // SILENCE state: accumulate consecutive loud frames toward an onset declaration.
      if (loud) {
        this.loudRun += 1;
        if (this.loudRun >= this.config.onsetFrames) {
          this.speaking = true;
          this.loudRun = 0;
          this.quietRun = 0;
          return "speech-start";
        }
      } else {
        this.loudRun = 0; // a quiet frame breaks the onset run (must be CONSECUTIVE loud frames)
      }
      return "none";
    }
    // SPEECH state: accumulate consecutive quiet frames toward an end (hangover); any loud frame resets it.
    if (loud) {
      this.quietRun = 0;
      return "none";
    }
    this.quietRun += 1;
    if (this.quietRun >= this.config.hangoverFrames) {
      this.speaking = false;
      this.quietRun = 0;
      this.loudRun = 0;
      return "speech-end";
    }
    return "none";
  }

  /** Reset to the silence state (e.g. after a barge-in consumed the onset, before the next utterance). */
  reset(): void {
    this.speaking = false;
    this.loudRun = 0;
    this.quietRun = 0;
    this.lastRms = 0;
  }

  /**
   * Force the detector into the SPEECH state (speaking, clean run counters). The turn controller calls this when
   * it KNOWS the user just spoke (an STT-final consumed the utterance and a turn is starting): the audio that
   * produced that transcript is often STILL arriving (network/jitter-buffer lag, the utterance tail), and a
   * reset-to-silence would re-onset on that SAME-utterance audio and fire a FALSE barge-in before the agent utters
   * a word. Holding "speaking" makes the trailing audio steady-speech (no event); a genuine barge-in must then be a
   * fresh speech-start, which the state machine only emits AFTER a silence (speech-end) — i.e. the user actually
   * stops, then speaks over the agent. Idempotent. (#27 root cause: agent-turn-interrupt fired on every live turn.)
   */
  markSpeaking(): void {
    this.speaking = true;
    this.loudRun = 0;
    this.quietRun = 0;
  }
}

function clampPositive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}
function clampMin1(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/**
 * Parse VAD config from env (honest names; all optional, all defaulted). INERT-safe: any unset/garbage value
 * falls back to the default — a missing knob never breaks the detector. Numeric envs arrive as strings.
 */
export function vadConfigFromEnv(env: VadEnv): VadConfig {
  return {
    rmsThreshold: numEnv(env.VOICE_AGENT_VAD_RMS_THRESHOLD, DEFAULT_VAD_CONFIG.rmsThreshold),
    onsetFrames: numEnv(env.VOICE_AGENT_VAD_ONSET_FRAMES, DEFAULT_VAD_CONFIG.onsetFrames),
    hangoverFrames: numEnv(env.VOICE_AGENT_VAD_HANGOVER_FRAMES, DEFAULT_VAD_CONFIG.hangoverFrames),
  };
}

/** Env knobs for the VAD (vars, not secrets). All optional; defaults apply when unset. */
export interface VadEnv {
  /** RMS threshold (0..32767) above which a frame counts as speech. Default 500. */
  VOICE_AGENT_VAD_RMS_THRESHOLD?: string;
  /** Consecutive loud frames to declare speech onset (barge-in debounce). Default 2. */
  VOICE_AGENT_VAD_ONSET_FRAMES?: string;
  /** Consecutive quiet frames to declare speech end (silence hangover). Default 12. */
  VOICE_AGENT_VAD_HANGOVER_FRAMES?: string;
}

function numEnv(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
