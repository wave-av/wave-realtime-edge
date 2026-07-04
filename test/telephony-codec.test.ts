// Telephony transcode primitive (#60 residual / #76) — pure G.711 + resample.
// The load-bearing test is the G.711 round-trip identity over all 256 μ-law
// bytes: a μ-law byte must survive decode→encode unchanged. That pins the
// encode/decode pair to the standard without needing golden vectors.
import { describe, it, expect } from "vitest";
import {
  muLawDecodeSample,
  muLawEncodeSample,
  muLawToPcm16,
  pcm16ToMuLaw,
  upsample8kTo48k,
  downsample48kTo8k,
  monoToStereo,
  stereoToMono,
  twilioMuLawToSfuPcm,
  sfuPcmToTwilioMuLaw,
} from "../src/telephony-codec.js";

describe("G.711 μ-law encode/decode", () => {
  it("round-trips all 256 μ-law bytes EXCEPT the −0 codeword 0x7F", () => {
    // G.711 μ-law has two zero codewords: 0xFF (+0) and 0x7F (−0), both decode
    // to linear 0. A standard encoder maps linear 0 → 0xFF, so 0x7F collapses to
    // 0xFF on re-encode. Every other codeword survives decode→encode unchanged.
    for (let u = 0; u < 256; u++) {
      const expected = u === 0x7f ? 0xff : u;
      expect(muLawEncodeSample(muLawDecodeSample(u))).toBe(expected);
    }
    expect(muLawEncodeSample(muLawDecodeSample(0x7f))).toBe(0xff); // the −0 → +0 collapse
  });

  it("decodes both zero codewords to ~0 and 0x00 to a large magnitude", () => {
    expect(Math.abs(muLawDecodeSample(0xff))).toBeLessThan(64); // +0
    expect(Math.abs(muLawDecodeSample(0x7f))).toBeLessThan(64); // −0
    expect(Math.abs(muLawDecodeSample(0x00))).toBeGreaterThan(30000);
  });

  it("decodes symmetric sign: 0x80 large positive, 0x00 large negative", () => {
    expect(Math.sign(muLawDecodeSample(0x80))).toBe(1);
    expect(Math.sign(muLawDecodeSample(0x00))).toBe(-1);
    expect(muLawDecodeSample(0x80)).toBe(-muLawDecodeSample(0x00)); // symmetric magnitude
  });

  it("array helpers preserve length and round-trip a μ-law frame", () => {
    const frame = new Uint8Array(160).map((_v, i) => (i * 7) & 0xff); // 20ms @ 8k
    const pcm = muLawToPcm16(frame);
    expect(pcm.length).toBe(160);
    const back = pcm16ToMuLaw(pcm);
    expect(Array.from(back)).toEqual(Array.from(frame)); // frame is already μ-law-valid
  });

  it("clips full-scale int16 PCM without throwing", () => {
    // 32767 (int16 max) exceeds the μ-law CLIP of 32635 → both clip to the same
    // codeword. -32768 is the negative extreme.
    expect(() => muLawEncodeSample(32767)).not.toThrow();
    expect(() => muLawEncodeSample(-32768)).not.toThrow();
    expect(muLawEncodeSample(32767) & 0xff).toBe(muLawEncodeSample(32635) & 0xff);
  });
});

describe("resampling 8k <-> 48k (×6)", () => {
  it("upsample multiplies length by 6, downsample divides by 6", () => {
    const in8k = Int16Array.from([100, 200, 300, 400]);
    const up = upsample8kTo48k(in8k);
    expect(up.length).toBe(24);
    expect(downsample48kTo8k(up).length).toBe(4);
  });

  it("upsample interpolates endpoints exactly (first sample preserved)", () => {
    const up = upsample8kTo48k(Int16Array.from([1000, 2000]));
    expect(up[0]).toBe(1000); // t=0 at each source sample
    expect(up[6]).toBe(2000);
  });

  it("a constant tone survives up->down within tight tolerance", () => {
    const flat = new Int16Array(48).fill(5000);
    const round = downsample48kTo8k(upsample8kTo48k(flat));
    for (const s of round) expect(Math.abs(s - 5000)).toBeLessThanOrEqual(1);
  });

  it("handles empty input", () => {
    expect(upsample8kTo48k(new Int16Array(0)).length).toBe(0);
    expect(downsample48kTo8k(new Int16Array(0)).length).toBe(0);
  });
});

describe("channel conversion", () => {
  it("mono->stereo duplicates, stereo->mono averages", () => {
    const st = monoToStereo(Int16Array.from([10, 20]));
    expect(Array.from(st)).toEqual([10, 10, 20, 20]);
    expect(Array.from(stereoToMono(Int16Array.from([10, 30, 100, 200])))).toEqual([20, 150]);
  });
});

describe("composite Twilio <-> SFU transcode", () => {
  it("μ-law(8k mono) -> PCM(48k stereo): length = bytes * 6 * 2", () => {
    const muLaw = new Uint8Array(160).fill(0xff);
    const pcm = twilioMuLawToSfuPcm(muLaw);
    expect(pcm.length).toBe(160 * 6 * 2);
  });

  it("PCM(48k stereo) -> μ-law(8k mono): length = frames / 6", () => {
    const pcm = new Int16Array(160 * 6 * 2).fill(0);
    expect(sfuPcmToTwilioMuLaw(pcm).length).toBe(160);
  });

  it("a μ-law frame survives the full round-trip near-losslessly (silence)", () => {
    const muLaw = new Uint8Array(160).fill(0xff); // near-silence
    const back = sfuPcmToTwilioMuLaw(twilioMuLawToSfuPcm(muLaw));
    expect(back.length).toBe(160);
    for (const b of back) expect(Math.abs(muLawDecodeSample(b))).toBeLessThan(128);
  });
});
