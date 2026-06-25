// Task #81 step 7 — pcmToWav: the agent egress PCM (16-bit LE / 48 kHz / stereo) is wrapped in a canonical
// WAV/RIFF container before it goes to the transcribe spoke. Pure, byte-exact, no network.
import { describe, it, expect } from "vitest";
import { pcmToWav, PCM_SAMPLE_RATE, PCM_CHANNELS, PCM_BITS_PER_SAMPLE, WAV_MIME } from "../src/pcm-wav.js";

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

describe("pcmToWav", () => {
  it("emits a 44-byte canonical header + the PCM bytes, with the agent codec defaults", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + pcm.length);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
    // the PCM payload is copied in verbatim after the header
    expect(Array.from(wav.slice(44))).toEqual(Array.from(pcm));
  });

  it("writes the correct fmt fields (PCM, channels, sample rate, byte rate, block align, bits)", () => {
    const pcm = new Uint8Array([0, 0, 0, 0]);
    const wav = pcmToWav(pcm);
    const v = new DataView(wav.buffer);
    expect(v.getUint32(4, true)).toBe(36 + pcm.length); // RIFF chunk size
    expect(v.getUint32(16, true)).toBe(16); // fmt subchunk size (PCM)
    expect(v.getUint16(20, true)).toBe(1); // AudioFormat = PCM
    expect(v.getUint16(22, true)).toBe(PCM_CHANNELS);
    expect(v.getUint32(24, true)).toBe(PCM_SAMPLE_RATE);
    const blockAlign = (PCM_CHANNELS * PCM_BITS_PER_SAMPLE) >> 3;
    expect(v.getUint32(28, true)).toBe(PCM_SAMPLE_RATE * blockAlign); // byte rate
    expect(v.getUint16(32, true)).toBe(blockAlign);
    expect(v.getUint16(34, true)).toBe(PCM_BITS_PER_SAMPLE);
    expect(v.getUint32(40, true)).toBe(pcm.length); // data subchunk size
  });

  it("handles an empty PCM buffer (header only)", () => {
    const wav = pcmToWav(new Uint8Array(0));
    expect(wav.length).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });

  it("exposes the audio/wav container mime", () => {
    expect(WAV_MIME).toBe("audio/wav");
  });
});
