// Task #81 (LK-rip Phase 6b) step 4 — VAD unit tests. Proves: RMS math over 16-bit LE PCM; loud frames vs ~zero
// (silence) frames; onset debounce (a single loud frame does NOT declare speech — onsetFrames must be sustained);
// silence hangover (a brief quiet dip mid-speech does NOT end the turn — hangoverFrames must be sustained, so the
// user is not cut off); speech-start / speech-end transitions fire exactly once at the boundary; reset; env config
// parsing (defaults + overrides + garbage fallback). Synthetic PCM only — no live audio.
import { describe, it, expect } from "vitest";
import {
  Vad,
  rms16LE,
  vadConfigFromEnv,
  DEFAULT_VAD_CONFIG,
  type VadEnv,
} from "../src/agent-vad.js";

/** Build a PCM frame of `samples` 16-bit LE samples all at amplitude `amp` (signed). */
function pcmFrame(amp: number, samples = 64): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const v = amp & 0xffff;
  for (let i = 0; i < samples; i++) {
    out[i * 2] = v & 0xff;
    out[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return out;
}
const LOUD = pcmFrame(8000); // well above the default 500 threshold
const QUIET = pcmFrame(0); // pure silence

describe("rms16LE", () => {
  it("is ~0 for silence and the constant amplitude for a constant-magnitude frame", () => {
    expect(rms16LE(QUIET)).toBe(0);
    // a constant |amp| signal has RMS == |amp|
    expect(Math.round(rms16LE(pcmFrame(3000)))).toBe(3000);
  });
  it("decodes negative (two's complement) samples correctly", () => {
    expect(Math.round(rms16LE(pcmFrame(-4000)))).toBe(4000);
  });
  it("returns 0 for empty / odd-only buffers (no throw)", () => {
    expect(rms16LE(new Uint8Array(0))).toBe(0);
    expect(rms16LE(new Uint8Array([0x12]))).toBe(0);
  });
});

describe("Vad — onset debounce", () => {
  it("does NOT declare speech on a single loud frame (onsetFrames=2 default)", () => {
    const vad = new Vad();
    expect(vad.feed(LOUD)).toBe("none"); // 1 loud frame — below onset
    expect(vad.isSpeaking).toBe(false);
  });

  it("declares speech-start exactly once after onsetFrames consecutive loud frames", () => {
    const vad = new Vad();
    expect(vad.feed(LOUD)).toBe("none");
    expect(vad.feed(LOUD)).toBe("speech-start"); // 2nd consecutive loud → onset
    expect(vad.isSpeaking).toBe(true);
    expect(vad.feed(LOUD)).toBe("none"); // steady speech, no repeat event
  });

  it("a quiet frame breaks the onset run (loud frames must be CONSECUTIVE)", () => {
    const vad = new Vad({ onsetFrames: 3 });
    vad.feed(LOUD);
    vad.feed(QUIET); // breaks the run
    vad.feed(LOUD);
    vad.feed(LOUD);
    expect(vad.isSpeaking).toBe(false); // only 2 consecutive, need 3
    expect(vad.feed(LOUD)).toBe("speech-start"); // now 3 consecutive
  });
});

describe("Vad — silence hangover (do not cut the user off)", () => {
  it("a brief quiet dip mid-speech does NOT end the turn", () => {
    const vad = new Vad({ onsetFrames: 1, hangoverFrames: 4 });
    expect(vad.feed(LOUD)).toBe("speech-start");
    // 3 quiet frames (< hangover 4) then loud again — must stay speaking
    expect(vad.feed(QUIET)).toBe("none");
    expect(vad.feed(QUIET)).toBe("none");
    expect(vad.feed(QUIET)).toBe("none");
    expect(vad.feed(LOUD)).toBe("none"); // loud resets the hangover counter
    expect(vad.isSpeaking).toBe(true);
  });

  it("declares speech-end after hangoverFrames consecutive quiet frames", () => {
    const vad = new Vad({ onsetFrames: 1, hangoverFrames: 3 });
    expect(vad.feed(LOUD)).toBe("speech-start");
    expect(vad.feed(QUIET)).toBe("none");
    expect(vad.feed(QUIET)).toBe("none");
    expect(vad.feed(QUIET)).toBe("speech-end"); // 3rd consecutive quiet → end
    expect(vad.isSpeaking).toBe(false);
  });
});

describe("Vad — a full speech episode + reset", () => {
  it("start → sustained → end and tracks lastFrameRms", () => {
    const vad = new Vad({ onsetFrames: 2, hangoverFrames: 2 });
    vad.feed(LOUD);
    expect(vad.feed(LOUD)).toBe("speech-start");
    expect(vad.lastFrameRms).toBeGreaterThan(0);
    vad.feed(QUIET);
    expect(vad.feed(QUIET)).toBe("speech-end");
    vad.reset();
    expect(vad.isSpeaking).toBe(false);
    expect(vad.lastFrameRms).toBe(0);
  });

  it("markSpeaking holds the SPEECH state so trailing loud audio is steady (no false onset) until a real silence", () => {
    // #27 barge-in fix: after the turn controller marks the VAD speaking, the SAME-utterance trailing audio must
    // NOT emit a fresh speech-start (which would self-barge-in the agent). A genuine barge-in needs silence first.
    const vad = new Vad({ onsetFrames: 1, hangoverFrames: 1 });
    vad.markSpeaking();
    expect(vad.isSpeaking).toBe(true);
    expect(vad.feed(LOUD)).toBe("none"); // trailing same-utterance speech = steady, NOT a new onset
    expect(vad.feed(QUIET)).toBe("speech-end"); // the user finally stops
    expect(vad.feed(LOUD)).toBe("speech-start"); // a fresh onset over the agent = a REAL barge-in
  });
});

describe("vadConfigFromEnv", () => {
  it("uses defaults when unset", () => {
    expect(vadConfigFromEnv({})).toEqual(DEFAULT_VAD_CONFIG);
  });
  it("parses overrides and falls back on garbage", () => {
    const env: VadEnv = {
      VOICE_AGENT_VAD_RMS_THRESHOLD: "1200",
      VOICE_AGENT_VAD_ONSET_FRAMES: "3",
      VOICE_AGENT_VAD_HANGOVER_FRAMES: "not-a-number",
    };
    const cfg = vadConfigFromEnv(env);
    expect(cfg.rmsThreshold).toBe(1200);
    expect(cfg.onsetFrames).toBe(3);
    expect(cfg.hangoverFrames).toBe(DEFAULT_VAD_CONFIG.hangoverFrames); // garbage → default
  });
});
