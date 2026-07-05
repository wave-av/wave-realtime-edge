// Zoom RTMS audio transcode (#88) — 16 kHz mono s16le ↔ 48 kHz stereo PCM.
import { describe, it, expect } from "vitest";
import {
  pcmS16LeToInt16,
  int16ToPcmS16Le,
  upsample16kTo48k,
  downsample48kTo16k,
  rtmsAudioToSfuPcm,
  sfuPcmToRtmsAudio,
} from "../src/rtms-audio.js";

describe("s16le <-> Int16", () => {
  it("round-trips samples honouring little-endian byte order", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 258]);
    const bytes = int16ToPcmS16Le(samples);
    expect(bytes.length).toBe(samples.length * 2);
    // 258 = 0x0102 → LE bytes 0x02,0x01
    const i258 = 5 * 2;
    expect(bytes[i258]).toBe(0x02);
    expect(bytes[i258 + 1]).toBe(0x01);
    expect(Array.from(pcmS16LeToInt16(bytes))).toEqual(Array.from(samples));
  });

  it("decodes from a non-zero byteOffset view correctly", () => {
    const backing = new Uint8Array([0xff, 0x02, 0x01]); // skip 1 byte, then 0x0102 LE = 258
    const view = backing.subarray(1);
    expect(Array.from(pcmS16LeToInt16(view))).toEqual([258]);
  });
});

describe("resample 16k <-> 48k (×3)", () => {
  it("upsample multiplies length by 3, downsample divides by 3", () => {
    const in16k = Int16Array.from([100, 200, 300, 400]);
    const up = upsample16kTo48k(in16k);
    expect(up.length).toBe(12);
    expect(downsample48kTo16k(up).length).toBe(4);
  });

  it("upsample preserves each source sample at the interpolation node", () => {
    const up = upsample16kTo48k(Int16Array.from([1000, 2000]));
    expect(up[0]).toBe(1000);
    expect(up[3]).toBe(2000);
  });

  it("a constant tone survives up->down within tight tolerance", () => {
    const flat = new Int16Array(24).fill(5000);
    for (const s of downsample48kTo16k(upsample16kTo48k(flat))) expect(Math.abs(s - 5000)).toBeLessThanOrEqual(1);
  });

  it("handles empty input", () => {
    expect(upsample16kTo48k(new Int16Array(0)).length).toBe(0);
    expect(downsample48kTo16k(new Int16Array(0)).length).toBe(0);
  });
});

describe("composite Zoom RTMS <-> SFU transcode", () => {
  it("RTMS audio bytes (16k mono) -> PCM (48k stereo): int16len = (bytes/2)*3*2", () => {
    const rtms = int16ToPcmS16Le(new Int16Array(160).fill(0)); // 160 samples @16k = 10ms
    const pcm = rtmsAudioToSfuPcm(rtms);
    expect(pcm.length).toBe(160 * 3 * 2);
  });

  it("SFU (48k stereo) -> RTMS audio bytes (16k mono): bytelen = (frames/3)*2", () => {
    const pcm = new Int16Array(160 * 3 * 2).fill(0);
    expect(sfuPcmToRtmsAudio(pcm).length).toBe(160 * 2);
  });

  it("a constant tone survives the full RTMS->SFU->RTMS round-trip near-losslessly", () => {
    const rtms = int16ToPcmS16Le(new Int16Array(160).fill(4000));
    const back = pcmS16LeToInt16(sfuPcmToRtmsAudio(rtmsAudioToSfuPcm(rtms)));
    for (const s of back) expect(Math.abs(s - 4000)).toBeLessThanOrEqual(2);
  });
});
