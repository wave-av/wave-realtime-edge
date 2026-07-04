/**
 * Telephony transcode primitive for the Twilio Media-Stream ↔ WAVE room bridge
 * (#60 residual / #76 wave-native voice).
 *
 * Twilio Media Streams are FIXED at G.711 μ-law, 8 kHz, mono, 20 ms frames
 * (160 μ-law bytes/frame). The CF Realtime SFU media-transport adapter
 * (see agent-ingest-adapter.ts) carries 16-bit LE PCM, 48 kHz, STEREO — a
 * VERIFIED target format. This module is the pure, deterministic transcode
 * between those two worlds. It has NO consumer yet: the WebSocket bridge that
 * uses it lands with the live-call spike (its send-side framing is the one
 * unverified item in agent-ingest-adapter.ts). Isolating the codec here lets it
 * be fully unit-tested now, with zero prod exposure.
 *
 * Nothing here does I/O. Pure functions only.
 *
 * G.711 μ-law encode/decode are the canonical Sun/CCITT reference algorithms;
 * their correctness is pinned by the round-trip identity encode(decode(u))===u
 * for all 256 μ-law byte values (a μ-law byte survives a decode→encode cycle
 * unchanged — the defining property of the quantizer). See the test.
 */

const BIAS = 0x84; // 132
const CLIP = 32635;

/** Sun g711.c decode segment table: exp_lut[exponent]. */
const DECODE_EXP_LUT = [0, 132, 396, 924, 1980, 4092, 8316, 16764] as const;

/** Decode one μ-law byte to a 16-bit signed linear PCM sample. */
export function muLawDecodeSample(muLawByte: number): number {
  const u = ~muLawByte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = DECODE_EXP_LUT[exponent]! + (mantissa << (exponent + 3));
  return sign !== 0 ? -sample : sample;
}

/** Encode one 16-bit signed linear PCM sample to a μ-law byte. */
export function muLawEncodeSample(pcm: number): number {
  let sign = (pcm >> 8) & 0x80;
  let sample = pcm;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;
  // Exponent = index of the top set bit at/above bit 7 (segment number).
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    /* scan down */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** μ-law byte stream (8 kHz mono) → Int16 PCM (8 kHz mono). */
export function muLawToPcm16(muLaw: Uint8Array): Int16Array {
  const out = new Int16Array(muLaw.length);
  for (let i = 0; i < muLaw.length; i++) out[i] = muLawDecodeSample(muLaw[i]!);
  return out;
}

/** Int16 PCM (8 kHz mono) → μ-law byte stream (8 kHz mono). */
export function pcm16ToMuLaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = muLawEncodeSample(pcm[i]!);
  return out;
}

const UPSAMPLE_FACTOR = 6; // 8 kHz → 48 kHz

/**
 * Upsample 8 kHz → 48 kHz by linear interpolation (×6). Adequate for 8 kHz
 * telephony voice, which carries no energy above 4 kHz; replace with a
 * polyphase FIR if fidelity ever requires it.
 */
export function upsample8kTo48k(pcm8k: Int16Array): Int16Array {
  const n = pcm8k.length;
  if (n === 0) return new Int16Array(0);
  const out = new Int16Array(n * UPSAMPLE_FACTOR);
  for (let i = 0; i < n; i++) {
    const cur = pcm8k[i]!;
    const next = i + 1 < n ? pcm8k[i + 1]! : cur;
    for (let k = 0; k < UPSAMPLE_FACTOR; k++) {
      const t = k / UPSAMPLE_FACTOR;
      out[i * UPSAMPLE_FACTOR + k] = Math.round(cur + (next - cur) * t);
    }
  }
  return out;
}

/**
 * Downsample 48 kHz → 8 kHz by 6-tap box averaging + decimation — a crude
 * anti-alias low-pass sufficient for voice. Replace with a polyphase FIR if
 * fidelity requires. Output length = floor(input/6).
 */
export function downsample48kTo8k(pcm48k: Int16Array): Int16Array {
  const n = Math.floor(pcm48k.length / UPSAMPLE_FACTOR);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < UPSAMPLE_FACTOR; k++) sum += pcm48k[i * UPSAMPLE_FACTOR + k]!;
    out[i] = Math.round(sum / UPSAMPLE_FACTOR);
  }
  return out;
}

/** Mono → interleaved stereo (duplicate each sample L=R). */
export function monoToStereo(mono: Int16Array): Int16Array {
  const out = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    const s = mono[i]!;
    out[i * 2] = s;
    out[i * 2 + 1] = s;
  }
  return out;
}

/** Interleaved stereo → mono (average L/R). */
export function stereoToMono(stereo: Int16Array): Int16Array {
  const n = Math.floor(stereo.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round((stereo[i * 2]! + stereo[i * 2 + 1]!) / 2);
  return out;
}

/**
 * Twilio → SFU: μ-law (8 kHz mono) → Int16 PCM (48 kHz stereo, interleaved).
 * This is what the bridge feeds into the CF Realtime ingest adapter.
 */
export function twilioMuLawToSfuPcm(muLaw: Uint8Array): Int16Array {
  return monoToStereo(upsample8kTo48k(muLawToPcm16(muLaw)));
}

/**
 * SFU → Twilio: Int16 PCM (48 kHz stereo, interleaved) → μ-law (8 kHz mono).
 * This is what the bridge sends back over the Twilio Media-Stream WebSocket.
 */
export function sfuPcmToTwilioMuLaw(pcm48kStereo: Int16Array): Uint8Array {
  return pcm16ToMuLaw(downsample48kTo8k(stereoToMono(pcm48kStereo)));
}
